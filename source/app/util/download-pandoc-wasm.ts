import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import ZIP from 'adm-zip'
import { DEFAULT_PANDOC_WASM_SHA256, DEFAULT_PANDOC_WASM_URL } from '@common/pandoc-util/pandoc-wasm-url'
import { validatePandocWasmRuntime } from './pandoc-reactor'
import { downloadPandocHttp, inspectPandocHttp, MAX_PANDOC_DOWNLOAD_BYTES, type SourceMetadata } from './pandoc-download-http'

interface DownloadedModule extends SourceMetadata {
  bytes: Buffer
}
type Download = (url: URL) => Promise<Buffer|DownloadedModule>
type Inspect = (url: URL) => Promise<SourceMetadata>
type UpdateStatus = 'downloaded'|'updated'|'unchanged'
interface CachedModule {
  filename: string
  status: UpdateStatus
}
const pending = new Map<string, Promise<CachedModule>>()
const validated = new Map<string, string>()
const checked = new Set<string>()
// Custom builds with debug information can exceed 128 MiB. Keep downloads
// bounded while allowing substantially larger modules than the stock release.
const MAX_DOWNLOAD_BYTES = MAX_PANDOC_DOWNLOAD_BYTES
const REQUIRED_EXPORTS = [ 'malloc', 'convert', 'query', '__wasm_call_ctors', 'hs_init_with_rtsopts' ]

/** Check before allocating, and bound reads if the opened file grows. */
async function readLimitedFile (filename: string|URL, description: string, limit = MAX_DOWNLOAD_BYTES): Promise<Buffer> {
  const file = await fs.open(filename, 'r')
  try {
    const error = () => new Error(`${description} is larger than the ${limit === MAX_DOWNLOAD_BYTES ? '512 MiB' : '16 KiB'} safety limit.`)
    if ((await file.stat()).size > limit) {
      throw error()
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer
      size += bytes.length
      if (size > limit) {
        throw error()
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await file.close()
  }
}

async function inspectSource (url: URL): Promise<SourceMetadata> {
  if (url.protocol === 'file:') {
    const stat = await fs.stat(url, { bigint: true })
    return { lastModified: `${stat.mtimeNs}:${stat.size}` }
  }
  return await inspectPandocHttp(url)
}

async function download (url: URL): Promise<DownloadedModule> {
  if (url.protocol === 'file:') {
    const metadata = await inspectSource(url)
    return { ...metadata, bytes: await readLimitedFile(url, 'The Pandoc download') }
  }

  return await downloadPandocHttp(url)
}

function hasWasmHeader (bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([ 0, 97, 115, 109, 1, 0, 0, 0 ]))
}

async function compileWasm (bytes: Buffer): Promise<WebAssembly.Module|undefined> {
  if (!hasWasmHeader(bytes)) {
    return undefined
  }
  try {
    return await WebAssembly.compile(new Uint8Array(bytes))
  } catch {
    return undefined
  }
}

function hasPandocExports (module: WebAssembly.Module): boolean {
  const exports = WebAssembly.Module.exports(module)
  return exports.some(item => item.name === 'memory' && item.kind === 'memory') &&
    REQUIRED_EXPORTS.every(name => exports.some(item => item.name === name && item.kind === 'function'))
}

async function isPandocWasm (bytes: Buffer): Promise<boolean> {
  const module = await compileWasm(bytes)
  return module !== undefined && hasPandocExports(module)
}

function hasExpectedHash (bytes: Buffer, expectedSha256?: string): boolean {
  return expectedSha256 === undefined || createHash('sha256').update(bytes).digest('hex') === expectedSha256
}

/** Download raw WASM or extract the module from a Pandoc release ZIP. */
async function extractWasm (bytes: Buffer, expectedSha256?: string): Promise<Buffer> {
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new Error('The Pandoc download is larger than the 512 MiB safety limit.')
  }
  let wasm: Buffer|undefined
  if (hasWasmHeader(bytes)) {
    wasm = bytes
  } else if (bytes.subarray(0, 2).toString() === 'PK') {
    const archive = new ZIP(bytes)
    const entry = archive.getEntries().find(entry => !entry.isDirectory && path.posix.basename(entry.entryName) === 'pandoc.wasm')
    if (entry !== undefined) {
      if (entry.header.size > MAX_DOWNLOAD_BYTES) {
        throw new Error('The extracted Pandoc WASM module is larger than the 512 MiB safety limit.')
      }
      wasm = entry.getData()
    }
  }
  if (wasm === undefined || !hasWasmHeader(wasm)) {
    throw new Error('The Pandoc download must be a valid WASM module or a ZIP containing pandoc.wasm.')
  }
  const module = await compileWasm(wasm)
  if (module === undefined) {
    throw new Error('The Pandoc download must be a valid WASM module or a ZIP containing pandoc.wasm.')
  }
  if (!hasPandocExports(module)) {
    throw new Error('The downloaded module does not provide the Pandoc WASM API. Check the Pandoc download URL.')
  }
  if (!hasExpectedHash(wasm, expectedSha256)) {
    throw new Error('The downloaded Pandoc WASM module failed its integrity check.')
  }
  return wasm
}

/** Cache by source URL, sharing concurrent downloads and committing atomically. */
export async function downloadPandocWasm (
  urlString: string,
  cacheDirectory: string,
  request: Download = download,
  sha256?: string,
  inspect: Inspect = inspectSource
): Promise<string> {
  return (await resolvePandocWasm(urlString, cacheDirectory, request, sha256, inspect, false)).filename
}

/** Manual checks bypass the session guard and download when validators are absent. */
export async function checkPandocWasmUpdates (
  urlString: string,
  cacheDirectory: string,
  request: Download = download,
  sha256?: string,
  inspect: Inspect = inspectSource
): Promise<UpdateStatus> {
  return (await resolvePandocWasm(urlString, cacheDirectory, request, sha256, inspect, true)).status
}

async function resolvePandocWasm (
  urlString: string,
  cacheDirectory: string,
  request: Download,
  sha256: string|undefined,
  inspect: Inspect,
  manual: boolean
): Promise<CachedModule> {
  const url = new URL(urlString.trim())
  if (![ 'https:', 'file:' ].includes(url.protocol)) {
    throw new Error('The Pandoc download URL must use HTTPS or file.')
  }
  const configuredSha256 = sha256?.trim().toLowerCase()
  if (configuredSha256 !== undefined && configuredSha256 !== '' && !/^[a-f0-9]{64}$/.test(configuredSha256)) {
    throw new Error('The Pandoc SHA-256 hash must contain exactly 64 hexadecimal characters.')
  }
  const expectedSha256 = configuredSha256 !== undefined && configuredSha256 !== ''
    ? configuredSha256
    : url.href === DEFAULT_PANDOC_WASM_URL ? DEFAULT_PANDOC_WASM_SHA256 : undefined
  // A URL/hash pair identifies a distinct expected module and must not share
  // cache entries or in-flight downloads with a different hash configuration.
  const cacheKey = expectedSha256 === undefined || url.href === DEFAULT_PANDOC_WASM_URL && expectedSha256 === DEFAULT_PANDOC_WASM_SHA256
    ? url.href
    : `${url.href}\0${expectedSha256}`
  const filename = `${createHash('sha256').update(cacheKey).digest('hex')}.wasm`
  const destination = path.join(cacheDirectory, filename)
  const existing = pending.get(destination)
  if (existing !== undefined) {
    if (!manual) {
      return await existing
    }
    // A manual check must not be satisfied by an automatic cache lookup.
    await existing.catch(() => {})
    return await resolvePandocWasm(urlString, cacheDirectory, request, sha256, inspect, manual)
  }

  const task = (async (): Promise<CachedModule> => {
    let cachedDigest: string|undefined
    try {
      const cached = await readLimitedFile(destination, 'The cached Pandoc WASM module')
      const digest = createHash('sha256').update(cached).digest('hex')
      const previous = validated.get(destination)
      // Once this process has validated a cache entry, a changed digest is
      // tampering or corruption, not a new candidate to trust based on exports.
      if (previous === undefined || previous === digest) {
        if (hasExpectedHash(cached, expectedSha256) && (previous === digest || await isPandocWasm(cached))) {
          validated.set(destination, digest)
          cachedDigest = digest
        }
      }
      if (cachedDigest === undefined) {
        validated.delete(destination)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    const metadataPath = `${destination}.json`
    if (cachedDigest !== undefined) {
      // A pinned module cannot advance without changing the configured hash.
      if (!manual && (checked.has(destination) || expectedSha256 !== undefined)) {
        return { filename: destination, status: 'unchanged' }
      }
      checked.add(destination)
      try {
        let previous: SourceMetadata = {}
        try {
          const saved: unknown = JSON.parse((await readLimitedFile(metadataPath, 'Pandoc cache metadata', 16 * 1024)).toString('utf8'))
          if (saved !== null && typeof saved === 'object') {
            const data = saved as Record<string, unknown>
            if (data.digest === cachedDigest) {
              previous = {
                etag: typeof data.etag === 'string' ? data.etag : undefined,
                lastModified: typeof data.lastModified === 'string' ? data.lastModified : undefined
              }
            }
          }
        } catch { /* Missing or invalid metadata cannot establish freshness. */ }
        const current = await inspect(url)
        const hasValidators = current.etag !== undefined || current.lastModified !== undefined
        const unchanged = current.etag !== undefined && previous.etag !== undefined
          ? current.etag === previous.etag
          : current.lastModified !== undefined && previous.lastModified !== undefined && current.lastModified === previous.lastModified
        if (unchanged || (!manual && !hasValidators)) {
          return { filename: destination, status: 'unchanged' }
        }
      } catch (error) {
        if (manual) {
          throw error
        }
        console.warn('Could not check for Pandoc WASM updates; using the cached module.', error)
        return { filename: destination, status: 'unchanged' }
      }
    }

    let fetched: Buffer|DownloadedModule
    let wasm: Buffer
    let digest: string
    try {
      fetched = await request(url)
      wasm = await extractWasm(Buffer.isBuffer(fetched) ? fetched : fetched.bytes, expectedSha256)
      digest = createHash('sha256').update(wasm).digest('hex')
      if (digest !== cachedDigest) {
        await fs.mkdir(cacheDirectory, { recursive: true })
        const temporary = path.join(cacheDirectory, `${filename}.${randomUUID()}.tmp`)
        try {
          await fs.writeFile(temporary, wasm, { flag: 'wx' })
          // Never replace a working cache with a module that merely has the
          // right export names. Initialization and a real query must succeed.
          await validatePandocWasmRuntime(temporary)
          await fs.rename(temporary, destination)
        } finally {
          await fs.rm(temporary, { force: true }).catch(error => {
            console.warn('Could not remove a temporary Pandoc WASM module.', error)
          })
        }
      }
    } catch (error) {
      if (manual || cachedDigest === undefined) {
        throw error
      }
      console.warn('Could not update Pandoc WASM; using the cached module.', error)
      return { filename: destination, status: 'unchanged' }
    }
    validated.set(destination, digest)
    checked.add(destination)
    const metadata = Buffer.isBuffer(fetched) ? {} : { etag: fetched.etag, lastModified: fetched.lastModified }
    const metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`
    try {
      if (metadata.etag !== undefined || metadata.lastModified !== undefined) {
        await fs.writeFile(metadataTemporary, JSON.stringify({ ...metadata, digest }), { flag: 'wx' })
        await fs.rename(metadataTemporary, metadataPath)
      } else {
        await fs.rm(metadataPath, { force: true })
      }
    } catch (error) {
      // Metadata is an optimization; a fully validated module remains usable.
      console.warn('Could not save Pandoc WASM update metadata.', error)
    } finally {
      await fs.rm(metadataTemporary, { force: true }).catch(error => {
        console.warn('Could not remove temporary Pandoc WASM metadata.', error)
      })
    }
    return { filename: destination, status: cachedDigest === undefined ? 'downloaded' : digest === cachedDigest ? 'unchanged' : 'updated' }
  })()
  pending.set(destination, task)
  try {
    return await task
  } finally {
    pending.delete(destination)
  }
}

/** Remove a cached module that fails compile, API, or runtime validation. */
export async function invalidatePandocWasm (filename: string): Promise<void> {
  validated.delete(filename)
  checked.delete(filename)
  await Promise.all([ fs.rm(filename, { force: true }), fs.rm(`${filename}.json`, { force: true }) ])
}
