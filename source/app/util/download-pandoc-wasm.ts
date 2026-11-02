import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import ZIP from 'adm-zip'
import type { PandocModuleSource } from '@common/pandoc-util/pandoc-module-source'
import { InvalidPandocModuleError, validatePandocWasmRuntime } from './pandoc-reactor'
import { downloadPandocHttp, MAX_PANDOC_DOWNLOAD_BYTES } from './pandoc-download-http'

type Download = (url: URL) => Promise<Buffer>
type UpdateStatus = 'downloaded'|'updated'|'unchanged'
interface CachedModule {
  filename: string
  status: UpdateStatus
}
const MAX_DOWNLOAD_BYTES = MAX_PANDOC_DOWNLOAD_BYTES

/** Check before allocating, and bound reads if the opened file grows. */
async function readLimitedFile (filename: string|URL, description: string): Promise<Buffer> {
  const file = await fs.open(filename, 'r')
  try {
    const error = () => new Error(`${description} is larger than the 512 MiB safety limit.`)
    if ((await file.stat()).size > MAX_DOWNLOAD_BYTES) {
      throw error()
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer
      size += bytes.length
      if (size > MAX_DOWNLOAD_BYTES) {
        throw error()
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await file.close()
  }
}

async function downloadSource (url: URL): Promise<Buffer> {
  return url.protocol === 'file:'
    ? await readLimitedFile(url, 'The Pandoc download')
    : await downloadPandocHttp(url)
}

function hasWasmHeader (bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([ 0, 97, 115, 109, 1, 0, 0, 0 ]))
}

/** Download raw WASM or extract the module from a Pandoc release ZIP. */
function extractWasm (bytes: Buffer): Buffer {
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
  return wasm
}

function normalizeSource (source: PandocModuleSource): PandocModuleSource {
  if (source.url.trim() === '') {
    throw new Error('No Pandoc WASM download URL is configured. Set one in Preferences → Import/Export → Pandoc download.')
  }
  const url = new URL(source.url.trim())
  if (![ 'https:', 'file:' ].includes(url.protocol)) {
    throw new Error('The Pandoc download URL must use HTTPS or file.')
  }
  const configuredHash = source.sha256?.trim().toLowerCase()
  const sha256 = configuredHash === '' ? undefined : configuredHash
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('The Pandoc SHA-256 hash must contain exactly 64 hexadecimal characters.')
  }
  return { ...source, url: url.href, sha256 }
}

/** Internal construction boundary for isolated state and test transport injection. */
export function createPandocModuleManager ({ download = downloadSource }: { download?: Download } = {}) {
  const pending = new Map<string, { update: boolean, task: Promise<CachedModule> }>()
  const validated = new Map<string, string>()

  async function readCachedDigest (filename: string, expectedSha256?: string): Promise<string|undefined> {
    try {
      const bytes = await readLimitedFile(filename, 'The cached Pandoc WASM module')
      const digest = createHash('sha256').update(bytes).digest('hex')
      const previous = validated.get(filename)
      // Changed bytes must be replaced from the source, even if they still expose
      // a working API. Keep hashing on every use to detect changes within a session.
      if ((previous === undefined || previous === digest) && (expectedSha256 === undefined || digest === expectedSha256)) {
        if (previous !== digest) {
          await validatePandocWasmRuntime(filename)
        }
        validated.set(filename, digest)
        return digest
      }
    } catch (error: unknown) {
      if (!(error instanceof InvalidPandocModuleError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    validated.delete(filename)
  }

  async function installCandidate (source: PandocModuleSource, destination: string, cachedDigest: string|undefined, update: boolean): Promise<CachedModule> {
    const bytes = !update && source.bundledPath !== undefined
      ? await readLimitedFile(source.bundledPath, 'The bundled Pandoc WASM module')
      : await download(new URL(source.url))
    const wasm = extractWasm(bytes)
    const digest = createHash('sha256').update(wasm).digest('hex')
    if (source.sha256 !== undefined && digest !== source.sha256) {
      throw new Error('The downloaded Pandoc WASM module failed its integrity check.')
    }
    if (digest !== cachedDigest) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const temporary = `${destination}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, wasm, { flag: 'wx' })
        // Initialization and a real version query must succeed before replacing
        // a working installation. A matching export table alone is insufficient.
        await validatePandocWasmRuntime(temporary)
        await fs.rename(temporary, destination)
      } finally {
        await fs.rm(temporary, { force: true }).catch(error => {
          console.warn('Could not remove a temporary Pandoc WASM module.', error)
        })
      }
    }
    validated.set(destination, digest)
    return { filename: destination, status: cachedDigest === undefined ? 'downloaded' : digest === cachedDigest ? 'unchanged' : 'updated' }
  }

  async function resolve (input: PandocModuleSource, cacheDirectory: string, update: boolean): Promise<CachedModule> {
    const source = normalizeSource(input)
    const cacheKey = source.sha256 === undefined ? source.url : `${source.url}\0${source.sha256}`
    const key = createHash('sha256').update(cacheKey).digest('hex')
    const destination = path.resolve(cacheDirectory, `${key}.wasm`)
    // Share matching jobs. A manual update must still fetch the source after an
    // in-flight cache lookup or bundled installation has completed.
    let existing = pending.get(destination)
    while (existing !== undefined) {
      if (!update || existing.update) {
        return await existing.task
      }
      await existing.task.catch(() => {})
      existing = pending.get(destination)
    }
    const task = (async (): Promise<CachedModule> => {
      const digest = await readCachedDigest(destination, source.sha256)
      if (!update && digest !== undefined) {
        return { filename: destination, status: 'unchanged' }
      }
      return await installCandidate(source, destination, digest, update)
    })()
    pending.set(destination, { update, task })
    try {
      return await task
    } finally {
      pending.delete(destination)
    }
  }

  return {
    /** Resolve a valid cached module, installing the bundled or remote source if needed. */
    async ensurePandocModule (source: PandocModuleSource, cacheDirectory: string): Promise<string> {
      return (await resolve(source, cacheDirectory, false)).filename
    },
    /** Always fetch the configured source; retain the installed module on failure. */
    async updatePandocModule (source: PandocModuleSource, cacheDirectory: string): Promise<UpdateStatus> {
      return (await resolve(source, cacheDirectory, true)).status
    },
    async invalidatePandocWasm (filename: string): Promise<void> {
      validated.delete(filename)
      await fs.rm(filename, { force: true })
    }
  }
}

export const { ensurePandocModule, updatePandocModule, invalidatePandocWasm } = createPandocModuleManager()
