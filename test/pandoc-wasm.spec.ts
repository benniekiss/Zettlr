import assert from 'assert'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import YAML from 'yaml'
import { configurePandocWasm, getPandocVersion, runPandoc } from '../source/app/util/run-pandoc'
import { downloadPandocWasm } from '../source/app/util/download-pandoc-wasm'

// Run explicitly against a downloaded module, without network access in tests.
const integration = process.env.PANDOC_TEST_WASM === undefined ? describe.skip : describe
integration('Pandoc WASM integration', function () {
  this.timeout(30000)
  let directory: string
  let cacheDirectory: string

  before(async function () {
    cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-module-'))
    const source = pathToFileURL(path.resolve(process.env.PANDOC_TEST_WASM as string)).href
    configurePandocWasm(async () => await downloadPandocWasm(source, cacheDirectory))
  })

  after(async function () {
    await fs.rm(cacheDirectory, { recursive: true, force: true })
  })

  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-wasm-test-'))
  })

  afterEach(async function () {
    await fs.rm(directory, { recursive: true, force: true })
  })

  async function convert (options: Record<string, unknown>) {
    const defaults = path.join(directory, 'defaults.yml')
    await fs.writeFile(defaults, YAML.stringify(options))
    return await runPandoc(defaults, directory)
  }

  it('queries the bundled version without a system Pandoc', async function () {
    assert.match(await getPandocVersion(), /^\d+\.\d+/)
  })

  it('preserves profiles, relative paths, Unicode, and local Lua filters', async function () {
    await fs.writeFile(path.join(directory, '文章 with spaces.md'), '# Héllo\n\nOriginal')
    await fs.writeFile(path.join(directory, 'filter.lua'), 'function Str(s) if s.text == "Original" then return pandoc.Str("Filtered") end end')
    const result = await convert({
      reader: 'markdown', writer: 'html',
      'input-files': ['文章 with spaces.md'], 'output-file': 'out.html',
      filters: ['filter.lua']
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    const html = await fs.readFile(path.join(directory, 'out.html'), 'utf8')
    assert.match(html, /Héllo/)
    assert.match(html, /Filtered/)
  })

  it('uses the existing HTML profile and local bibliography', async function () {
    await fs.writeFile(path.join(directory, 'input.md'), '---\ntitle: Example\n---\n\nCitation [@example].')
    await fs.writeFile(path.join(directory, 'references.bib'), '@book{example, title={Example Book}, author={Doe, Jane}, year={2020}}')
    const profile = YAML.parse(await fs.readFile(path.resolve('static/defaults/HTML.yaml'), 'utf8'))
    const result = await convert({
      ...profile, 'input-files': ['input.md'], 'output-file': 'out.html', bibliography: ['references.bib']
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    const html = await fs.readFile(path.join(directory, 'out.html'), 'utf8')
    assert.match(html, /Example Book/)
    assert.match(html, /2020/)
  })

  it('reads parent-directory resources and writes an absolute output path', async function () {
    const nested = path.join(directory, 'nested')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(directory, 'input.md'), '# Outside directory\n\nOriginal')
    await fs.writeFile(path.join(directory, 'filter.lua'), 'function Str(s) if s.text == "Original" then return pandoc.Str("Filtered") end end')
    const output = path.join(directory, 'out.html')
    const defaults = path.join(nested, 'defaults.yml')
    await fs.writeFile(defaults, YAML.stringify({
      reader: 'markdown', writer: 'html', 'input-files': ['../input.md'],
      filters: ['../filter.lua'], 'output-file': output
    }))
    const result = await runPandoc(defaults, nested)
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.match(await fs.readFile(output, 'utf8'), /Filtered/)
    // Reactor IO must stay private, even when cwd is writable.
    assert.deepStrictEqual((await fs.readdir(nested)).sort(), ['defaults.yml'])
  })

  it('round trips binary DOCX and extracts embedded media', async function () {
    // A one-pixel PNG, embedded into a Word document and extracted on import.
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
    await fs.writeFile(path.join(directory, 'pixel.png'), image)
    await fs.writeFile(path.join(directory, 'input.md'), '# Round trip\n\n![Pixel](pixel.png)')
    const exported = await convert({ reader: 'markdown', writer: 'docx', 'input-files': ['input.md'], 'output-file': 'out.docx' })
    assert.strictEqual(exported.code, 0, exported.stderr.join('\n'))
    assert.strictEqual((await fs.readFile(path.join(directory, 'out.docx'))).subarray(0, 2).toString(), 'PK')
    const imported = await convert({ reader: 'docx', writer: 'markdown', 'input-files': ['out.docx'], 'output-file': 'out.md', 'extract-media': './assets' })
    assert.strictEqual(imported.code, 0, imported.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'out.md'), 'utf8'), /Round trip/)
    const mediaDirectory = path.join(directory, 'assets/media')
    const media = await fs.readdir(mediaDirectory)
    assert.strictEqual(media.length, 1)
    assert.deepStrictEqual(await fs.readFile(path.join(mediaDirectory, media[0])), image)
  })

  it('reports conversion errors and unsupported engines and filters', async function () {
    for (const options of [
      { reader: 'markdown', writer: 'html', 'input-files': ['missing.md'] },
      { writer: 'pdf' },
      { writer: 'html', filters: [{ type: 'json', path: 'filter.py' }] }
    ]) {
      const result = await convert(options)
      assert.notStrictEqual(result.code, 0)
      assert.ok(result.stderr.length > 0)
    }
  })

  it('preserves templates and fail-if-warnings', async function () {
    await fs.writeFile(path.join(directory, 'input.md'), 'Body text')
    await fs.writeFile(path.join(directory, 'template.html'), '$body$<footer>$title$</footer>')
    const result = await convert({
      reader: 'markdown', writer: 'html', standalone: true,
      template: 'template.html', metadata: { title: 'Custom title' },
      'input-files': ['input.md'], 'output-file': 'out.html'
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'out.html'), 'utf8'), /<footer>Custom title<\/footer>/)
    await fs.writeFile(path.join(directory, 'warning.lua'), 'function Pandoc(doc) pandoc.log.warn("Test warning") return doc end')
    const warned = await convert({
      reader: 'markdown', writer: 'html', standalone: true,
      'input-files': ['input.md'], 'output-file': 'warning.html', 'fail-if-warnings': true,
      filters: ['warning.lua']
    })
    assert.notStrictEqual(warned.code, 0)
    assert.match(warned.stderr.join('\n'), /Test warning/)
  })

  it('runs concurrent conversions with isolated working directories', async function () {
    const results = await Promise.all(['first', 'second'].map(async name => {
      const cwd = path.join(directory, name)
      await fs.mkdir(cwd)
      await fs.writeFile(path.join(cwd, 'input.md'), name)
      const defaults = path.join(cwd, 'defaults.yml')
      await fs.writeFile(defaults, YAML.stringify({ reader: 'markdown', writer: 'html', 'input-files': ['input.md'], 'output-file': 'out.html' }))
      const result = await runPandoc(defaults, cwd)
      assert.strictEqual(result.code, 0, result.stderr.join('\n'))
      return await fs.readFile(path.join(cwd, 'out.html'), 'utf8')
    }))
    assert.deepStrictEqual(results, ['<p>first</p>\n', '<p>second</p>\n'])
  })
})
