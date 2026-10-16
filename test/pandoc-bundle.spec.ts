import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import webpack from 'webpack'
import ZIP from 'adm-zip'
import { BundlePandocPlugin } from '../scripts/bundle-pandoc'

describe('Bundled Pandoc WASM', function () {
  this.timeout(10000)
  let directory: string
  let wasm: Buffer
  const originalUrl = process.env.PANDOC_WASM_URL
  const originalHash = process.env.PANDOC_WASM_SHA256

  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-bundle-'))
    wasm = await fs.readFile('test/fixtures/pandoc/reactor.wasm')
    await fs.writeFile(path.join(directory, 'entry.js'), '')
    await fs.writeFile(path.join(directory, 'pandoc.wasm'), wasm)
    process.env.PANDOC_WASM_URL = pathToFileURL(path.join(directory, 'pandoc.wasm')).href
    process.env.PANDOC_WASM_SHA256 = createHash('sha256').update(wasm).digest('hex')
  })

  afterEach(async function () {
    for (const [key, value] of Object.entries({ PANDOC_WASM_URL: originalUrl, PANDOC_WASM_SHA256: originalHash })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(directory, { recursive: true, force: true })
  })

  async function build () {
    const compiler = webpack({
      mode: 'development', context: directory, entry: './entry.js',
      output: { path: path.join(directory, 'output') },
      plugins: [new BundlePandocPlugin()]
    })!
    await new Promise<void>((resolve, reject) => {
      compiler.run((error, stats) => {
        compiler.close(closeError => {
          if (error ?? closeError) reject(error ?? closeError)
          else if (stats?.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
          else resolve()
        })
      })
    })
  }

  it('emits a validated local module and reuses its build cache offline', async function () {
    await build()
    assert.deepStrictEqual(await fs.readFile(path.join(directory, 'output/assets/pandoc.wasm')), wasm)
    await fs.rm(path.join(directory, 'pandoc.wasm'))
    await build()
    assert.deepStrictEqual(await fs.readFile(path.join(directory, 'output/assets/pandoc.wasm')), wasm)
  })

  it('extracts the module from an archive before bundling', async function () {
    const zip = new ZIP()
    zip.addFile('release/pandoc.wasm', wasm)
    await fs.writeFile(path.join(directory, 'pandoc.wasm'), zip.toBuffer())
    await build()
    assert.deepStrictEqual(await fs.readFile(path.join(directory, 'output/assets/pandoc.wasm')), wasm)
  })

  it('omits the module when the build URL is none', async function () {
    process.env.PANDOC_WASM_URL = 'none'
    await build()
    await assert.rejects(fs.stat(path.join(directory, 'output/assets/pandoc.wasm')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(directory, 'build/pandoc-wasm')), { code: 'ENOENT' })
  })

  it('allows builds to omit the hash pin', async function () {
    process.env.PANDOC_WASM_SHA256 = 'none'
    await build()
    assert.deepStrictEqual(await fs.readFile(path.join(directory, 'output/assets/pandoc.wasm')), wasm)
  })

  it('fails the build if the module fails its integrity check', async function () {
    process.env.PANDOC_WASM_SHA256 = 'a'.repeat(64)
    await assert.rejects(build(), /integrity check/)
    await assert.rejects(fs.stat(path.join(directory, 'output/assets/pandoc.wasm')), { code: 'ENOENT' })
  })
})
