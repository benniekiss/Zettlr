import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import got from 'got'
import ZIP from 'adm-zip'
import { DEFAULT_PANDOC_WASM_SHA256, DEFAULT_PANDOC_WASM_URL } from '@common/pandoc-util/pandoc-wasm-url'

type Download = (url: URL) => Promise<Buffer>
const pending = new Map<string, Promise<string>>()
const validated = new Map<string, string>()
// Custom builds with debug information can exceed 128 MiB. Keep downloads
// bounded while allowing substantially larger modules than the stock release.
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const REQUIRED_EXPORTS = [ 'malloc', 'convert', 'query', '__wasm_call_ctors', 'hs_init_with_rtsopts' ]

async function download (url: URL): Promise<Buffer> {
  if (url.protocol === 'file:') {
    const stat = await fs.stat(url)
    if (stat.size > MAX_DOWNLOAD_BYTES) {
      throw new Error('The Pandoc download is larger than the 512 MiB safety limit.')
    }
    return await fs.readFile(url)
  }

  const request = got.stream(url, {
    timeout: { request: 60000 },
    retry: { limit: 1 },
    hooks: {
      beforeRedirect: [options => {
        if (options.url.protocol !== 'https:') {
          throw new Error('The Pandoc download cannot redirect to a non-HTTPS URL.')
        }
      }]
    }
  })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_DOWNLOAD_BYTES) {
      request.destroy()
      throw new Error('The Pandoc download is larger than the 512 MiB safety limit.')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
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
  sha256?: string
): Promise<string> {
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
    return await existing
  }

  const task = (async () => {
    try {
      const cached = await fs.readFile(destination)
      const digest = createHash('sha256').update(cached).digest('hex')
      const previous = validated.get(destination)
      // Once this process has validated a cache entry, a changed digest is
      // tampering or corruption, not a new candidate to trust based on exports.
      if (previous === undefined || previous === digest) {
        if (hasExpectedHash(cached, expectedSha256) && (previous === digest || await isPandocWasm(cached))) {
          validated.set(destination, digest)
          return destination
        }
      }
      validated.delete(destination)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    const wasm = await extractWasm(await request(url), expectedSha256)
    await fs.mkdir(cacheDirectory, { recursive: true })
    const temporary = path.join(cacheDirectory, `${filename}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, wasm, { flag: 'wx' })
      await fs.rename(temporary, destination)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    validated.set(destination, createHash('sha256').update(wasm).digest('hex'))
    return destination
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
  await fs.rm(filename, { force: true })
}
