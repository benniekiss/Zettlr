import assert from 'assert'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import ZIP from 'adm-zip'
import { downloadPandocWasm, invalidatePandocWasm } from '../source/app/util/download-pandoc-wasm'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'
import { DEFAULT_PANDOC_WASM_URL } from '../source/common/pandoc-util/pandoc-wasm-url'

// A minimal module with the exports provided by Pandoc. The functions are
// intentionally empty: download tests validate the API shape, not conversion.
const wasm = Buffer.from('AGFzbQEAAAABBAFgAAADBgUAAAAAAAUDAQABB1AGBm1lbW9yeQIABm1hbGxvYwAAB2NvbnZlcnQAAQVxdWVyeQACEV9fd2FzbV9jYWxsX2N0b3JzAAMUaHNfaW5pdF93aXRoX3J0c29wdHMABAoQBQIACwIACwIACwIACwIACw==', 'base64')
const nonPandocWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])

describe('Pandoc WASM download', function () {
  let directory: string
  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-download-'))
  })
  afterEach(async function () {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('downloads and caches a raw module for offline reuse', async function () {
    let requests = 0
    const request = async () => { requests++; return wasm }
    const filename = await downloadPandocWasm('https://example.org/pandoc.wasm', directory, request)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.strictEqual(await downloadPandocWasm('https://example.org/pandoc.wasm', directory, request), filename)
    assert.strictEqual(requests, 1)
  })

  it('accepts the release ZIP and extracts only pandoc.wasm', async function () {
    const archive = new ZIP()
    archive.addFile('release/pandoc.wasm', wasm)
    archive.addFile('release/README.md', Buffer.from('README'))
    const filename = await downloadPandocWasm('https://example.org/pandoc.wasm.zip', directory, async () => archive.toBuffer())
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
  })

  it('selects a different cache entry when the user changes the URL', async function () {
    const first = await downloadPandocWasm('https://example.org/first.wasm', directory, async () => wasm)
    const second = await downloadPandocWasm('https://example.org/second.wasm', directory, async () => wasm)
    assert.notStrictEqual(first, second)
  })

  it('shares simultaneous requests for the same URL', async function () {
    let requests = 0
    const request = async () => { requests++; return wasm }
    const files = await Promise.all(Array.from({ length: 3 }, async () => {
      return await downloadPandocWasm('https://example.org/pandoc.wasm', directory, request)
    }))
    assert.strictEqual(requests, 1)
    assert.strictEqual(new Set(files).size, 1)
  })

  it('rejects invalid downloads without poisoning the cache and retries', async function () {
    const url = 'https://example.org/pandoc.wasm'
    await assert.rejects(downloadPandocWasm(url, directory, async () => Buffer.from('<html>Error</html>')), /valid WASM/)
    assert.deepStrictEqual(await fs.readdir(directory), [])
    const filename = await downloadPandocWasm(url, directory, async () => wasm)
    await fs.writeFile(filename, 'corrupted cache')
    await downloadPandocWasm(url, directory, async () => wasm)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('revalidates cached content even when its size and modification time are unchanged', async function () {
    const url = 'https://example.org/pandoc.wasm'
    let requests = 0
    const filename = await downloadPandocWasm(url, directory, async () => { requests++; return wasm })
    const fixedTime = new Date('2024-01-01T00:00:00.000Z')
    await fs.utimes(filename, fixedTime, fixedTime)
    const originalStat = await fs.stat(filename)

    const corrupted = Buffer.from(wasm)
    const exportName = corrupted.indexOf(Buffer.from('convert'))
    assert.notStrictEqual(exportName, -1)
    corrupted[exportName + 6] = 'X'.charCodeAt(0)
    assert.strictEqual(corrupted.length, wasm.length)
    await fs.writeFile(filename, corrupted)
    await fs.utimes(filename, originalStat.atime, originalStat.mtime)
    assert.strictEqual((await fs.stat(filename)).mtimeMs, originalStat.mtimeMs)

    await downloadPandocWasm(url, directory, async () => { requests++; return wasm })
    assert.strictEqual(requests, 2)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('redownloads a changed cache entry instead of trusting a new API-shaped module', async function () {
    const url = 'https://example.org/pandoc.wasm'
    let requests = 0
    const filename = await downloadPandocWasm(url, directory, async () => { requests++; return wasm })
    // A valid custom section changes the bytes without changing the Pandoc API.
    await fs.appendFile(filename, Buffer.from([0, 1, 0]))

    await downloadPandocWasm(url, directory, async () => { requests++; return wasm })
    assert.strictEqual(requests, 2)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('supports local file URLs for offline setup', async function () {
    const source = path.join(directory, 'local.wasm')
    await fs.writeFile(source, wasm)
    const filename = await downloadPandocWasm(pathToFileURL(source).href, path.join(directory, 'cache'))
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('accepts local custom modules larger than 128 MiB', async function () {
    const source = path.join(directory, 'large.wasm')
    // A valid custom section with an empty name and 128 MiB of padding.
    // Truncate creates sparse padding without allocating a huge fixture buffer.
    const payloadSize = 128 * 1024 * 1024
    const sectionHeader = Buffer.from([0, 0x80, 0x80, 0x80, 0x40, 0])
    await fs.writeFile(source, Buffer.concat([wasm, sectionHeader]))
    await fs.truncate(source, wasm.length + sectionHeader.length - 1 + payloadSize)
    const filename = await downloadPandocWasm(pathToFileURL(source).href, path.join(directory, 'cache'))
    assert.strictEqual((await fs.stat(filename)).size, (await fs.stat(source)).size)
  }).timeout(10000)

  it('rejects oversized local files before reading or caching them', async function () {
    const source = path.join(directory, 'oversized.wasm')
    await fs.writeFile(source, wasm)
    await fs.truncate(source, 1024 * 1024 * 1024)
    const cache = path.join(directory, 'cache')
    await assert.rejects(downloadPandocWasm(pathToFileURL(source).href, cache), /512 MiB safety limit/)
    await assert.rejects(fs.access(cache))
  })

  it('reports network failures and rejects unsupported URL schemes', async function () {
    await assert.rejects(downloadPandocWasm('https://example.org/pandoc.wasm', directory, async () => {
      throw new Error('Network unavailable')
    }), /Network unavailable/)
    await assert.rejects(downloadPandocWasm('http://example.org/pandoc.wasm', directory), /HTTPS or file/)
    await assert.rejects(downloadPandocWasm('ftp://example.org/pandoc.wasm', directory), /HTTPS or file/)
    await assert.rejects(downloadPandocWasm('not a URL', directory), /Invalid URL/)
  })

  it('pins the built-in module by its SHA-256 hash', async function () {
    await assert.rejects(downloadPandocWasm(DEFAULT_PANDOC_WASM_URL, directory, async () => wasm), /integrity check/)
    assert.deepStrictEqual(await fs.readdir(directory), [])
  })

  it('checks an optional SHA-256 against the extracted module', async function () {
    const archive = new ZIP()
    archive.addFile('release/pandoc.wasm', wasm)
    const digest = createHash('sha256').update(wasm).digest('hex')
    const filename = await downloadPandocWasm(
      'https://example.org/pandoc.wasm.zip', directory, async () => archive.toBuffer(), digest.toUpperCase()
    )
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('does not reuse a cache entry when the expected SHA-256 changes', async function () {
    const url = 'https://example.org/pandoc.wasm'
    const digest = createHash('sha256').update(wasm).digest('hex')
    const wrongDigest = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
    let requests = 0
    const request = async () => { requests++; return wasm }
    const filename = await downloadPandocWasm(url, directory, request, digest)

    await assert.rejects(downloadPandocWasm(url, directory, request, wrongDigest), /integrity check/)
    assert.strictEqual(requests, 2)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('rejects a source that does not match its optional SHA-256', async function () {
    const digest = createHash('sha256').update(wasm).digest('hex')
    const wrongDigest = `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
    await assert.rejects(
      downloadPandocWasm('https://example.org/pandoc.wasm', directory, async () => wasm, wrongDigest),
      /integrity check/
    )
    assert.deepStrictEqual(await fs.readdir(directory), [])
  })

  it('rejects malformed optional SHA-256 values', async function () {
    await assert.rejects(
      downloadPandocWasm('https://example.org/pandoc.wasm', directory, async () => wasm, 'not-a-hash'),
      /exactly 64 hexadecimal characters/
    )
  })

  it('does not cache a valid WASM module that does not implement Pandoc', async function () {
    const url = 'https://example.org/other.wasm'
    let requests = 0
    await assert.rejects(downloadPandocWasm(url, directory, async () => { requests++; return nonPandocWasm }), /does not provide the Pandoc WASM API/)
    const filename = await downloadPandocWasm(url, directory, async () => { requests++; return wasm })
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.strictEqual(requests, 2)
  })

  it('reports an uncached module that does not implement Pandoc', async function () {
    const module = path.join(directory, 'other.wasm')
    await fs.writeFile(module, nonPandocWasm)
    configurePandocWasm(async () => module)
    const defaults = path.join(directory, 'defaults.yml')
    await fs.writeFile(defaults, 'reader: markdown\nwriter: html\n')
    const result = await runPandoc(defaults)
    assert.notStrictEqual(result.code, 0)
    assert.match(result.stderr.join('\n'), /does not provide the Pandoc WASM API/)
  })

  it('invalidates an API-shaped module that fails its runtime query', async function () {
    const filename = await downloadPandocWasm('https://example.org/fake-pandoc.wasm', directory, async () => wasm)
    configurePandocWasm(async () => filename, invalidatePandocWasm)
    const defaults = path.join(directory, 'defaults.yml')
    await fs.writeFile(defaults, 'reader: markdown\nwriter: html\n')
    const result = await runPandoc(defaults)
    assert.strictEqual(result.code, 1)
    assert.match(result.stderr.join('\n'), /valid Pandoc version/)
    await assert.rejects(fs.access(filename))
  })

  it('preserves the cached module after a defaults parsing error', async function () {
    const filename = await downloadPandocWasm('https://example.org/fake-pandoc.wasm', directory, async () => wasm)
    configurePandocWasm(async () => filename, invalidatePandocWasm)
    const defaults = path.join(directory, 'defaults.yml')
    // Parse errors occur before the worker uses the module, so they must not
    // invalidate an otherwise cached file.
    await fs.writeFile(defaults, 'reader: [\n')
    const result = await runPandoc(defaults)
    assert.strictEqual(result.code, 1)
    assert.ok(result.stderr.length > 0)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('does not invalidate the cache after a module read error', async function () {
    const filename = path.join(directory, 'missing.wasm')
    let invalidations = 0
    configurePandocWasm(async () => filename, async () => { invalidations++ })
    const defaults = path.join(directory, 'defaults.yml')
    await fs.writeFile(defaults, 'reader: markdown\nwriter: html\n')
    const result = await runPandoc(defaults)
    assert.strictEqual(result.code, 1)
    assert.match(result.stderr.join('\n'), /could not be read/)
    assert.strictEqual(invalidations, 0)
  })

  it('returns defaults-file errors through the normal failure result', async function () {
    const defaults = path.join(directory, 'defaults.yml')
    const missing = await runPandoc(defaults)
    assert.strictEqual(missing.code, 1)
    assert.match(missing.stderr.join('\n'), /ENOENT/)
    for (const contents of ['', 'null', '- html', 'writer: [']) {
      await fs.writeFile(defaults, contents)
      const result = await runPandoc(defaults)
      assert.strictEqual(result.code, 1)
      assert.ok(result.stderr.length > 0)
    }
  })
})
