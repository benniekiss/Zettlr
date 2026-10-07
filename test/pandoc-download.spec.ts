import assert from 'assert'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import ZIP from 'adm-zip'
import { downloadPandocWasm } from '../source/app/util/download-pandoc-wasm'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'

// A valid empty WASM module isolates download/cache behavior from conversion.
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])

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

  it('supports local file URLs for offline setup', async function () {
    const source = path.join(directory, 'local.wasm')
    await fs.writeFile(source, wasm)
    const filename = await downloadPandocWasm(pathToFileURL(source).href, path.join(directory, 'cache'))
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('reports network failures and rejects unsupported URL schemes', async function () {
    await assert.rejects(downloadPandocWasm('https://example.org/pandoc.wasm', directory, async () => {
      throw new Error('Network unavailable')
    }), /Network unavailable/)
    await assert.rejects(downloadPandocWasm('ftp://example.org/pandoc.wasm', directory), /HTTP, HTTPS, or file/)
    await assert.rejects(downloadPandocWasm('not a URL', directory), /Invalid URL/)
  })

  it('reports a valid WASM module that does not implement Pandoc', async function () {
    configurePandocWasm(async () => await downloadPandocWasm('https://example.org/other.wasm', directory, async () => wasm))
    const defaults = path.join(directory, 'defaults.yml')
    await fs.writeFile(defaults, 'reader: markdown\nwriter: html\n')
    const result = await runPandoc(defaults)
    assert.notStrictEqual(result.code, 0)
    assert.match(result.stderr.join('\n'), /does not provide the Pandoc WASM API/)
  })
})
