import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import got from 'got'
import ZIP from 'adm-zip'

type Download = (url: URL) => Promise<Buffer>
const pending = new Map<string, Promise<string>>()

async function download (url: URL): Promise<Buffer> {
  if (url.protocol === 'file:') {
    return await fs.readFile(url)
  }
  return await got(url, { timeout: { request: 60000 }, retry: { limit: 1 } }).buffer()
}

function isWasm (bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([ 0, 97, 115, 109, 1, 0, 0, 0 ])) && WebAssembly.validate(new Uint8Array(bytes))
}

/** Download raw WASM or extract the module from a Pandoc release ZIP. */
function extractWasm (bytes: Buffer): Buffer {
  if (isWasm(bytes)) {
    return bytes
  }
  if (bytes.subarray(0, 2).toString() === 'PK') {
    const archive = new ZIP(bytes)
    const entry = archive.getEntries().find(entry => !entry.isDirectory && path.posix.basename(entry.entryName) === 'pandoc.wasm')
    if (entry !== undefined) {
      const wasm = entry.getData()
      if (isWasm(wasm)) {
        return wasm
      }
    }
  }
  throw new Error('The Pandoc download must be a valid WASM module or a ZIP containing pandoc.wasm.')
}

/** Cache by source URL, sharing concurrent downloads and committing atomically. */
export async function downloadPandocWasm (urlString: string, cacheDirectory: string, request: Download = download): Promise<string> {
  const url = new URL(urlString.trim())
  if (![ 'http:', 'https:', 'file:' ].includes(url.protocol)) {
    throw new Error('The Pandoc download URL must use HTTP, HTTPS, or file.')
  }
  const filename = `${createHash('sha256').update(url.href).digest('hex')}.wasm`
  const destination = path.join(cacheDirectory, filename)
  const existing = pending.get(destination)
  if (existing !== undefined) {
    return await existing
  }

  const task = (async () => {
    try {
      if (isWasm(await fs.readFile(destination))) {
        return destination
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    const wasm = extractWasm(await request(url))
    await fs.mkdir(cacheDirectory, { recursive: true })
    const temporary = path.join(cacheDirectory, `${filename}.${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, wasm, { flag: 'wx' })
      await fs.rename(temporary, destination)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return destination
  })()
  pending.set(destination, task)
  try {
    return await task
  } finally {
    pending.delete(destination)
  }
}
