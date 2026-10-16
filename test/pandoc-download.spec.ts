import assert from 'assert'
import { createHash } from 'crypto'
import path from 'path'
import os from 'os'
import { promises as fs, readFileSync } from 'fs'
import { pathToFileURL } from 'url'
import ZIP from 'adm-zip'
import { createPandocModuleManager } from '../source/app/util/download-pandoc-wasm'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'

// Small fixtures exercise real WASI initialization and version queries.
const wasm = readFileSync(path.resolve('test/fixtures/pandoc/reactor.wasm'))
const brokenWasm = Buffer.from('AGFzbQEAAAABBAFgAAADBgUAAAAAAAUDAQABB1AGBm1lbW9yeQIABm1hbGxvYwAAB2NvbnZlcnQAAQVxdWVyeQACEV9fd2FzbV9jYWxsX2N0b3JzAAMUaHNfaW5pdF93aXRoX3J0c29wdHMABAoQBQIACwIACwIACwIACwIACw==', 'base64')
const nonPandocWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])
const updatedWasm = Buffer.concat([wasm, Buffer.from([0, 1, 0])])
const sha256 = createHash('sha256').update(wasm).digest('hex')
const source = { url: 'https://example.org/pandoc.wasm' }

describe('Pandoc module manager', function () {
  let directory: string
  let download: () => Promise<Buffer>
  let manager: ReturnType<typeof createPandocModuleManager>
  let invalidatePandocWasm: typeof manager.invalidatePandocWasm

  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-download-'))
    download = async () => wasm
    manager = createPandocModuleManager({ download: async () => await download() })
    invalidatePandocWasm = manager.invalidatePandocWasm
  })
  afterEach(async function () {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('downloads once and reuses the cache across sessions without contacting the source', async function () {
    let requests = 0
    download = async () => { requests++; return wasm }
    const filename = await manager.ensurePandocModule(source, directory)
    const offline = createPandocModuleManager({ download: async () => { throw new Error('Offline') } })
    assert.strictEqual(await manager.ensurePandocModule(source, directory), filename)
    assert.strictEqual(await offline.ensurePandocModule(source, directory), filename)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
    assert.strictEqual(requests, 1)
  })

  it('seeds from the bundle offline, then uses the remote source for manual updates', async function () {
    const bundledPath = path.join(directory, 'bundled.wasm')
    await fs.writeFile(bundledPath, wasm)
    const bundledSource = { ...source, bundledPath }
    download = async () => { throw new Error('Unexpected network request') }
    const filename = await manager.ensurePandocModule(bundledSource, directory)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    download = async () => updatedWasm
    assert.strictEqual(await manager.updatePandocModule(bundledSource, directory), 'updated')
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
    assert.strictEqual(await manager.ensurePandocModule(bundledSource, directory), filename)
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
  })

  it('fetches the remote source for a manual update even before a bundle is installed', async function () {
    const bundledPath = path.join(directory, 'missing.wasm')
    assert.strictEqual(await manager.updatePandocModule({ ...source, bundledPath }, directory), 'downloaded')
  })

  it('validates bundled modules and checks their configured hash before installing', async function () {
    const bundledPath = path.join(directory, 'bundled.wasm')
    await fs.writeFile(bundledPath, brokenWasm)
    await assert.rejects(manager.ensurePandocModule({ ...source, bundledPath }, directory), /valid Pandoc version/)
    await fs.writeFile(bundledPath, wasm)
    await assert.rejects(manager.ensurePandocModule({ ...source, bundledPath, sha256: 'a'.repeat(64) }, directory), /integrity check/)
    assert.deepStrictEqual(await fs.readdir(directory), ['bundled.wasm'])
  })

  it('uses GET for initial loading and every manual check, without trusting validators', async function () {
    const originalFetch = globalThis.fetch
    const methods: string[] = []
    let current = wasm
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      methods.push(request.method)
      // Even an unchanged ETag must not conceal different module bytes.
      return new Response(new Uint8Array(current), { headers: { etag: 'same' } })
    }
    try {
      const remote = createPandocModuleManager()
      const filename = await remote.ensurePandocModule(source, directory)
      current = updatedWasm
      await remote.ensurePandocModule(source, directory)
      assert.deepStrictEqual(await fs.readFile(filename), wasm)
      assert.strictEqual(await remote.updatePandocModule(source, directory), 'updated')
      assert.strictEqual(await remote.updatePandocModule(source, directory), 'unchanged')
      assert.deepStrictEqual(methods, ['GET', 'GET', 'GET'])
      assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
      assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves the installed module after a failed manual download', async function () {
    const filename = await manager.ensurePandocModule(source, directory)
    download = async () => { throw new Error('Offline') }
    await assert.rejects(manager.updatePandocModule(source, directory), /Offline/)
    assert.strictEqual(await manager.ensurePandocModule(source, directory), filename)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  for (const [description, bytes, message] of [
    ['invalid payload', Buffer.from('<html>Error</html>'), /valid WASM/],
    ['missing API', nonPandocWasm, /Pandoc WASM API/],
    ['malformed module', Buffer.concat([nonPandocWasm, Buffer.from([255])]), /could not be compiled/],
    ['broken runtime', brokenWasm, /valid Pandoc version/]
  ] as const) {
    it(`rejects an ${description} without installing it and allows retry`, async function () {
      download = async () => bytes
      await assert.rejects(manager.ensurePandocModule(source, directory), message)
      assert.deepStrictEqual(await fs.readdir(directory), [])
      download = async () => wasm
      await manager.ensurePandocModule(source, directory)
    })

    it(`preserves a working installation when an update contains an ${description}`, async function () {
      const filename = await manager.ensurePandocModule(source, directory)
      download = async () => bytes
      await assert.rejects(manager.updatePandocModule(source, directory), message)
      assert.deepStrictEqual(await fs.readFile(filename), wasm)
      assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
    })
  }

  for (const operation of ['writeFile', 'rename'] as const) {
    it(`preserves the installation and removes temporary files after a ${operation} failure`, async function () {
      const filename = await manager.ensurePandocModule(source, directory)
      download = async () => updatedWasm
      const original = fs[operation]
      const failure = new Error('Simulated cache commit failure')
      if (operation === 'writeFile') {
        const writeFile = fs.writeFile
        fs.writeFile = async (file, ...args) => {
          if (String(file).endsWith('.tmp')) throw failure
          return await writeFile(file, ...args)
        }
      } else {
        const rename = fs.rename
        fs.rename = async (from, to) => {
          if (to === filename) throw failure
          return await rename(from, to)
        }
      }
      try {
        await assert.rejects(manager.updatePandocModule(source, directory), /cache commit failure/)
        assert.deepStrictEqual(await fs.readFile(filename), wasm)
        assert.deepStrictEqual(await fs.readdir(directory), [path.basename(filename)])
      } finally {
        Object.assign(fs, { [operation]: original })
      }
      assert.strictEqual(await manager.updatePandocModule(source, directory), 'updated')
    })
  }

  it('retains hash pins during manual updates', async function () {
    const pinned = { ...source, sha256 }
    const filename = await manager.ensurePandocModule(pinned, directory)
    download = async () => updatedWasm
    await assert.rejects(manager.updatePandocModule(pinned, directory), /integrity check/)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('checks the extracted module hash before compilation and normalizes hash casing', async function () {
    const archive = new ZIP()
    archive.addFile('release/pandoc.wasm', wasm)
    archive.addFile('release/README.md', Buffer.from('README'))
    download = async () => archive.toBuffer()
    const filename = await manager.ensurePandocModule({ ...source, sha256: sha256.toUpperCase() }, directory)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    download = async () => Buffer.concat([nonPandocWasm, Buffer.from([255])])
    await assert.rejects(manager.updatePandocModule({ ...source, sha256 }, directory), /integrity check/)
  })

  it('separates cache entries by URL and expected hash', async function () {
    const filename = await manager.ensurePandocModule(source, directory)
    const pinned = await manager.ensurePandocModule({ ...source, sha256 }, directory)
    const other = await manager.ensurePandocModule({ url: 'https://example.org/other.wasm' }, directory)
    assert.strictEqual(new Set([filename, pinned, other]).size, 3)
    await assert.rejects(manager.ensurePandocModule({ ...source, sha256: 'a'.repeat(64) }, directory), /integrity check/)
    assert.deepStrictEqual(await fs.readFile(pinned), wasm)
  })

  it('shares concurrent initial downloads and manual update downloads', async function () {
    let requests = 0
    download = async () => { requests++; return wasm }
    const filenames = await Promise.all(Array.from({ length: 3 }, async () => await manager.ensurePandocModule(source, directory)))
    assert.strictEqual(requests, 1)
    assert.strictEqual(new Set(filenames).size, 1)
    download = async () => { requests++; return updatedWasm }
    const statuses = await Promise.all(Array.from({ length: 3 }, async () => await manager.updatePandocModule(source, directory)))
    assert.deepStrictEqual(statuses, ['updated', 'updated', 'updated'])
    assert.strictEqual(requests, 2)
  })

  it('runs a manual update after an in-flight initial download', async function () {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let downloads = 0
    download = async () => {
      if (++downloads === 1) {
        started()
        await gate
        return wasm
      }
      return updatedWasm
    }
    const initial = manager.ensurePandocModule(source, directory)
    await ready
    const manual = manager.updatePandocModule(source, directory)
    release()
    const filename = await initial
    assert.strictEqual(await manual, 'updated')
    assert.strictEqual(downloads, 2)
    assert.deepStrictEqual(await fs.readFile(filename), updatedWasm)
  })

  it('lets a waiting manual update recover from a failed initial download', async function () {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let downloads = 0
    download = async () => {
      if (++downloads === 1) {
        started()
        await gate
        throw new Error('Download failed')
      }
      return wasm
    }
    const initial = manager.ensurePandocModule(source, directory)
    const rejected = assert.rejects(initial, /Download failed/)
    await ready
    const manual = manager.updatePandocModule(source, directory)
    release()
    await rejected
    assert.strictEqual(await manual, 'downloaded')
  })

  it('replaces a runtime-broken cache from an earlier session', async function () {
    const filename = await manager.ensurePandocModule(source, directory)
    await fs.writeFile(filename, brokenWasm)
    const nextSession = createPandocModuleManager({ download: async () => wasm })
    assert.strictEqual(await nextSession.ensurePandocModule(source, directory), filename)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  for (const change of ['same size and mtime', 'valid extra section']) {
    it(`redownloads a changed cache with ${change}`, async function () {
      let requests = 0
      download = async () => { requests++; return wasm }
      const filename = await manager.ensurePandocModule(source, directory)
      const stat = await fs.stat(filename)
      if (change === 'same size and mtime') {
        const corrupted = Buffer.from(wasm)
        corrupted[corrupted.indexOf(Buffer.from('convert')) + 6] = 'X'.charCodeAt(0)
        await fs.writeFile(filename, corrupted)
        await fs.utimes(filename, stat.atime, stat.mtime)
      } else {
        await fs.appendFile(filename, Buffer.from([0, 1, 0]))
      }
      await manager.ensurePandocModule(source, directory)
      assert.strictEqual(requests, 2)
      assert.deepStrictEqual(await fs.readFile(filename), wasm)
    })
  }

  it('rejects oversized cached files and allows retry after correction', async function () {
    const filename = await manager.ensurePandocModule(source, directory)
    await fs.truncate(filename, 512 * 1024 * 1024 + 1)
    await assert.rejects(manager.ensurePandocModule(source, directory), /cached Pandoc WASM module is larger/)
    await fs.writeFile(filename, wasm)
    assert.strictEqual(await manager.ensurePandocModule(source, directory), filename)
  })

  it('loads and manually refreshes local files, and invalidates the installed copy', async function () {
    const remote = createPandocModuleManager()
    const localPath = path.join(directory, 'source.wasm')
    const local = { url: pathToFileURL(localPath).href }
    const cache = path.join(directory, 'cache')
    await fs.writeFile(localPath, wasm)
    const filename = await remote.ensurePandocModule(local, cache)
    await fs.writeFile(localPath, updatedWasm)
    await remote.ensurePandocModule(local, cache)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
    assert.strictEqual(await remote.updatePandocModule(local, cache), 'updated')
    assert.strictEqual(await remote.updatePandocModule(local, cache), 'unchanged')
    await remote.invalidatePandocWasm(filename)
    assert.deepStrictEqual(await fs.readdir(cache), [])
  })

  it('accepts local custom modules larger than 128 MiB', async function () {
    const localPath = path.join(directory, 'large.wasm')
    const payloadSize = 128 * 1024 * 1024
    const sectionHeader = Buffer.from([0, 0x80, 0x80, 0x80, 0x40, 0])
    await fs.writeFile(localPath, Buffer.concat([wasm, sectionHeader]))
    await fs.truncate(localPath, wasm.length + sectionHeader.length - 1 + payloadSize)
    const remote = createPandocModuleManager()
    const filename = await remote.ensurePandocModule({ url: pathToFileURL(localPath).href }, path.join(directory, 'cache'))
    assert.strictEqual((await fs.stat(filename)).size, (await fs.stat(localPath)).size)
  }).timeout(10000)

  it('rejects oversized local sources before creating the cache', async function () {
    const localPath = path.join(directory, 'oversized.wasm')
    await fs.writeFile(localPath, wasm)
    await fs.truncate(localPath, 1024 * 1024 * 1024)
    const remote = createPandocModuleManager()
    const cache = path.join(directory, 'cache')
    await assert.rejects(remote.ensurePandocModule({ url: pathToFileURL(localPath).href }, cache), /512 MiB safety limit/)
    await assert.rejects(fs.access(cache))
  })

  it('reports malformed sources and hashes without downloading', async function () {
    download = async () => { throw new Error('Unexpected download') }
    await assert.rejects(manager.ensurePandocModule({ url: '' }, directory), /No Pandoc WASM download URL is configured.*Preferences/)
    for (const url of ['http://example.org/module', 'ftp://example.org/module']) {
      await assert.rejects(manager.ensurePandocModule({ url }, directory), /HTTPS or file/)
    }
    await assert.rejects(manager.ensurePandocModule({ url: 'not a URL' }, directory), /Invalid URL/)
    await assert.rejects(manager.ensurePandocModule({ ...source, sha256: 'not-a-hash' }, directory), /64 hexadecimal/)
  })

  it('reports an uncached module that does not implement Pandoc', async function () {
    const module = path.join(directory, 'other.wasm')
    await fs.writeFile(module, nonPandocWasm)
    configurePandocWasm(async () => module)
    const result = await runPandoc({ reader: 'markdown', writer: 'html' })
    assert.notStrictEqual(result.code, 0)
    assert.match(result.stderr.join('\n'), /does not provide the Pandoc WASM API/)
  })

  it('invalidates an existing module that fails its runtime query', async function () {
    const filename = path.join(directory, 'broken.wasm')
    await fs.writeFile(filename, brokenWasm)
    configurePandocWasm(async () => filename, invalidatePandocWasm)
    const result = await runPandoc({ reader: 'markdown', writer: 'html' })
    assert.strictEqual(result.code, 1)
    assert.match(result.stderr.join('\n'), /valid Pandoc version/)
    await assert.rejects(fs.access(filename))
  })

  it('preserves the cached module after unsupported conversion options', async function () {
    const filename = await manager.ensurePandocModule(source, directory)
    configurePandocWasm(async () => filename, invalidatePandocWasm)
    const result = await runPandoc({ reader: 'markdown', writer: 'pdf' })
    assert.strictEqual(result.code, 1)
    assert.ok(result.stderr.length > 0)
    assert.deepStrictEqual(await fs.readFile(filename), wasm)
  })

  it('does not invalidate the cache after a module read error', async function () {
    const filename = path.join(directory, 'missing.wasm')
    let invalidations = 0
    configurePandocWasm(async () => filename, async () => { invalidations++ })
    const result = await runPandoc({ reader: 'markdown', writer: 'html' })
    assert.strictEqual(result.code, 1)
    assert.match(result.stderr.join('\n'), /could not be read/)
    assert.strictEqual(invalidations, 0)
  })

  it('returns invalid option mappings through the normal failure result', async function () {
    for (const options of [undefined, null, [], 'not-a-mapping', 42]) {
      const result = await runPandoc(options as unknown as Record<string, unknown>)
      assert.strictEqual(result.code, 1)
      assert.match(result.stderr.join('\n'), /mapping of options/)
    }
  })
})
