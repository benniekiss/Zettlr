import assert from 'assert'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { promises as fs, readFileSync } from 'fs'
import { pathToFileURL } from 'url'
import ZIP from 'adm-zip'
import { downloadPandocWasm, checkPandocWasmUpdates, invalidatePandocWasm } from '../source/app/util/download-pandoc-wasm'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'
import { DEFAULT_PANDOC_WASM_URL } from '../source/common/pandoc-util/pandoc-wasm-url'

// Small fixtures exercise a real WASI version query, without downloading Pandoc.
const wasm = readFileSync(path.resolve('test/fixtures/pandoc/reactor.wasm'))
// Correct export names alone do not make a working reactor.
const brokenWasm = Buffer.from('AGFzbQEAAAABBAFgAAADBgUAAAAAAAUDAQABB1AGBm1lbW9yeQIABm1hbGxvYwAAB2NvbnZlcnQAAQVxdWVyeQACEV9fd2FzbV9jYWxsX2N0b3JzAAMUaHNfaW5pdF93aXRoX3J0c29wdHMABAoQBQIACwIACwIACwIACwIACw==', 'base64')
const nonPandocWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
const updatedWasm = Buffer.concat([wasm, Buffer.from([0, 1, 0])])

describe('Pandoc WASM download', function () {
  let directory: string
  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-download-'))
  })
  afterEach(async function () {
    await fs.rm(directory, { recursive: true, force: true })
  })

  // Seed an on-disk cache from an earlier session without populating the
  // downloader's current-session state.
  async function seedCache (url: string, metadata: { etag?: string, lastModified?: string } = {}) {
    const filename = path.join(directory, `${createHash('sha256').update(url).digest('hex')}.wasm`)
    await fs.writeFile(filename, wasm)
    await fs.writeFile(`${filename}.json`, JSON.stringify({ ...metadata, digest: createHash('sha256').update(wasm).digest('hex') }))
    return filename
  }

  it('downloads and refreshes through ky while preserving server validators', async function () {
    const originalFetch = globalThis.fetch
    const methods: string[] = []
    let current = { bytes: wasm, etag: 'old' }
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      methods.push(request.method)
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(current.bytes), { headers: { etag: current.etag } })
    }
    try {
      const url = 'https://example.org/latest/pandoc.wasm'
      const filename = await downloadPandocWasm(url, directory)
      assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'old')
      current = { bytes: updatedWasm, etag: 'new' }
      assert.strictEqual(await checkPandocWasmUpdates(url, directory), 'updated')
      assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
      assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'new')
      assert.deepStrictEqual(methods, ['GET', 'HEAD', 'GET'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('updates a stable URL by ETag only once per app session', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    let checks = 0
    let downloads = 0
    const inspect = async () => { checks++; return { etag: 'new' } }
    const request = async () => { downloads++; return { bytes: updatedWasm, etag: 'new' } }
    assert.strictEqual(await downloadPandocWasm(url, directory, request, undefined, inspect), filename)
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
    const metadata = JSON.parse(await fs.readFile(`${filename}.json`, 'utf8'))
    assert.strictEqual(metadata.etag, 'new')
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    assert.strictEqual(checks, 1)
    assert.strictEqual(downloads, 1)
  })

  it('keeps an unchanged Last-Modified source without downloading it', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const lastModified = 'Tue, 13 Oct 2026 12:00:00 GMT'
    const filename = await seedCache(url, { lastModified })
    const request = async () => { throw new Error('Unexpected download') }
    assert.strictEqual(await downloadPandocWasm(url, directory, request, undefined, async () => ({ lastModified })), filename)
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, request, undefined, async () => ({ lastModified })), 'unchanged')
  })

  it('skips automatic downloads without validators but redownloads on manual checks', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url)
    let checks = 0
    let downloads = 0
    const inspect = async () => { checks++; return {} }
    const request = async () => { downloads++; return updatedWasm }
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    assert.strictEqual(checks, 1)
    assert.strictEqual(downloads, 0)
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, request, undefined, inspect), 'updated')
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, request, undefined, inspect), 'unchanged')
    assert.strictEqual(downloads, 2)
  })

  it('lets a manual check detect changes after this session already downloaded the source', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await downloadPandocWasm(url, directory, async () => ({ bytes: wasm, etag: 'old' }))
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, async () => ({ bytes: updatedWasm, etag: 'new' }), undefined, async () => ({ etag: 'new' })), 'updated')
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
  })

  it('runs a manual check after an in-flight initial download', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let downloads = 0
    const request = async () => {
      downloads++
      if (downloads === 1) {
        started()
        await gate
        return { bytes: wasm, etag: 'old' }
      }
      return { bytes: updatedWasm, etag: 'new' }
    }
    const automatic = downloadPandocWasm(url, directory, request)
    await ready
    const manual = checkPandocWasmUpdates(url, directory, request, undefined, async () => ({ etag: 'new' }))
    release()
    const filename = await automatic
    assert.strictEqual(await manual, 'updated')
    assert.strictEqual(downloads, 2)
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
  })

  it('updates a source when only Last-Modified changes', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { lastModified: 'Tue, 13 Oct 2026 12:00:00 GMT' })
    const lastModified = 'Tue, 13 Oct 2026 13:00:00 GMT'
    await downloadPandocWasm(url, directory, async () => ({ bytes: updatedWasm, lastModified }), undefined, async () => ({ lastModified }))
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
  })

  it('saves new validators even when downloaded module bytes are unchanged', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    let downloads = 0
    const request = async () => { downloads++; return { bytes: wasm, etag: 'new' } }
    const inspect = async () => ({ etag: 'new' })
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, request, undefined, inspect), 'unchanged')
    assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'new')
    assert.strictEqual(await checkPandocWasmUpdates(url, directory, request, undefined, inspect), 'unchanged')
    assert.strictEqual(downloads, 1)
  })

  it('handles servers without HEAD support conservatively except on manual checks', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 405 })
    let downloads = 0
    const request = async () => { downloads++; return updatedWasm }
    try {
      await downloadPandocWasm(url, directory, request)
      assert.strictEqual(downloads, 0)
      assert.strictEqual(await checkPandocWasmUpdates(url, directory, request), 'updated')
      assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reads HTTP validators and reports server errors from HEAD checks', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    await seedCache(url, { etag: 'old' })
    const originalFetch = globalThis.fetch
    const request = async () => { throw new Error('Unexpected download') }
    try {
      globalThis.fetch = async () => new Response(null, { status: 200, headers: { etag: ' old ' } })
      assert.strictEqual(await checkPandocWasmUpdates(url, directory, request), 'unchanged')
      globalThis.fetch = async () => new Response(null, { status: 404 })
      await assert.rejects(checkPandocWasmUpdates(url, directory, request), /HTTP 404/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses the cache after a failed automatic check and reports manual failures', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    let checks = 0
    const inspect = async () => { checks++; throw new Error('Offline') }
    const request = async () => { throw new Error('Unexpected download') }
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    assert.strictEqual(checks, 1)
    await assert.rejects(checkPandocWasmUpdates(url, directory, request, undefined, inspect), /Offline/)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('preserves the cached module and its validators when an update is invalid', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    const request = async () => ({ bytes: nonPandocWasm, etag: 'new' })
    const inspect = async () => ({ etag: 'new' })
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    await assert.rejects(checkPandocWasmUpdates(url, directory, request, undefined, inspect), /Pandoc WASM API/)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'old')
  })

  it('rejects runtime-broken updates before replacing the cache or its validators', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const filename = await seedCache(url, { etag: 'old' })
    const request = async () => ({ bytes: brokenWasm, etag: 'new' })
    const inspect = async () => ({ etag: 'new' })
    await downloadPandocWasm(url, directory, request, undefined, inspect)
    await assert.rejects(checkPandocWasmUpdates(url, directory, request, undefined, inspect), /valid Pandoc version/)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'old')
    assert.deepStrictEqual((await fs.readdir(directory)).sort(), [path.basename(filename), `${path.basename(filename)}.json`].sort())
  })

  it('rejects an initial module that cannot initialize a usable reactor', async function () {
    await assert.rejects(downloadPandocWasm('https://example.org/broken.wasm', directory, async () => brokenWasm), /valid Pandoc version/)
    assert.deepStrictEqual(await fs.readdir(directory), [])
  })

  for (const operation of ['writeFile', 'rename'] as const) {
    it(`uses the old cache after an automatic ${operation} failure and reports manual failures`, async function () {
      const url = 'https://example.org/latest/pandoc.wasm'
      const filename = await seedCache(url, { etag: 'old' })
      const original = fs[operation]
      const failure = Object.assign(new Error('Simulated cache commit failure'), { code: 'EACCES' })
      if (operation === 'writeFile') {
        const writeFile = fs.writeFile
        fs.writeFile = async (file, ...args) => {
          if (String(file).startsWith(filename) && String(file).endsWith('.tmp')) throw failure
          return await writeFile(file, ...args)
        }
      } else {
        const rename = fs.rename
        fs.rename = async (source, target) => {
          if (target === filename) throw failure
          return await rename(source, target)
        }
      }
      try {
        const request = async () => ({ bytes: updatedWasm, etag: 'new' })
        const inspect = async () => ({ etag: 'new' })
        assert.strictEqual(await downloadPandocWasm(url, directory, request, undefined, inspect), filename)
        await assert.rejects(checkPandocWasmUpdates(url, directory, request, undefined, inspect), /cache commit failure/)
        assert.deepStrictEqual(await fs.readFile(filename), wasm)
        assert.strictEqual(JSON.parse(await fs.readFile(`${filename}.json`, 'utf8')).etag, 'old')
        assert.deepStrictEqual((await fs.readdir(directory)).sort(), [path.basename(filename), `${path.basename(filename)}.json`].sort())
      } finally {
        Object.assign(fs, { [operation]: original })
      }
    })
  }

  it('keeps SHA-256 pins during manual updates and skips automatic checks for pinned modules', async function () {
    const url = 'https://example.org/latest/pandoc.wasm'
    const digest = createHash('sha256').update(wasm).digest('hex')
    const filename = await downloadPandocWasm(url, directory, async () => ({ bytes: wasm, etag: 'old' }), digest)
    const request = async () => ({ bytes: updatedWasm, etag: 'new' })
    await downloadPandocWasm(url, directory, request, digest, async () => { throw new Error('Unexpected check') })
    await assert.rejects(checkPandocWasmUpdates(url, directory, request, digest, async () => ({ etag: 'new' })), /integrity check/)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('refreshes a local file URL manually and removes its metadata when invalidated', async function () {
    const source = path.join(directory, 'source.wasm')
    const cache = path.join(directory, 'cache')
    const url = pathToFileURL(source).href
    await fs.writeFile(source, wasm)
    const filename = await downloadPandocWasm(url, cache)
    await fs.writeFile(source, updatedWasm)
    assert.strictEqual(await checkPandocWasmUpdates(url, cache), 'updated')
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
    assert.strictEqual(await checkPandocWasmUpdates(url, cache), 'unchanged')
    await invalidatePandocWasm(filename)
    assert.deepStrictEqual(await fs.readdir(cache), [])
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

  it('rejects oversized cached modules and allows retry after correction', async function () {
    const url = 'https://example.org/pandoc.wasm'
    let requests = 0
    const request = async () => { requests++; return wasm }
    const filename = await downloadPandocWasm(url, directory, request)
    // Sparse padding exceeds the limit without allocating a large test buffer.
    await fs.truncate(filename, 512 * 1024 * 1024 + 1)
    await assert.rejects(
      downloadPandocWasm(url, directory, request),
      /cached Pandoc WASM module is larger than the 512 MiB safety limit/
    )
    assert.strictEqual(requests, 1)
    await fs.writeFile(filename, wasm)
    assert.strictEqual(await downloadPandocWasm(url, directory, request), filename)
    assert.strictEqual(requests, 1)
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
    assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
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

  it('invalidates an existing module that fails its runtime query', async function () {
    const filename = path.join(directory, 'broken.wasm')
    await fs.writeFile(filename, brokenWasm)
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
