import assert from 'assert'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import YAML from 'yaml'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'
import { validatePandocWasmRuntime } from '../source/app/util/pandoc-reactor'
import { plugin as exportDocument } from '../source/app/service-providers/commands/exporter/default-exporter'

// Run explicitly against a downloaded module, without network access in tests.
const integration = process.env.PANDOC_TEST_WASM === undefined ? describe.skip : describe
integration('Pandoc WASM integration', function () {
  this.timeout(30000)
  let directory: string
  before(function () {
    configurePandocWasm(async () => path.resolve(process.env.PANDOC_TEST_WASM as string))
  })

  beforeEach(async function () {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-wasm-test-'))
  })

  afterEach(async function () {
    await fs.rm(directory, { recursive: true, force: true })
  })

  async function convert (options: Record<string, unknown>) {
    return await runPandoc(options, directory)
  }

  it('exports parsed custom-profile defaults to the configured output path', async function () {
    const input = path.join(directory, 'input.md')
    await fs.writeFile(input, '# Custom profile output')
    await fs.mkdir(path.join(directory, 'custom'))
    const output = await exportDocument({
      profile: { name: 'Custom HTML.yaml', reader: 'markdown', writer: 'html', isInvalid: false, outputFile: 'custom/report.html' },
      sourceFiles: [{ name: 'input.md', ext: '.md', path: input }],
      targetDirectory: directory,
      cwd: directory
    }, [input], {
      loadDefaults: async (_name, overrides) => ({ ...overrides, reader: 'markdown', writer: 'html', 'output-file': 'custom/report.html' }),
      runPandoc: async defaults => await runPandoc(defaults, directory),
      listDefaults: async () => []
    })
    assert.strictEqual(output.code, 0, output.stderr.join('\n'))
    assert.strictEqual(output.targetFile, path.join(directory, 'custom/report.html'))
    assert.match(await fs.readFile(output.targetFile, 'utf8'), /Custom profile output/)
    await assert.rejects(fs.access(path.join(directory, 'input.html')))
    await assert.rejects(fs.access(path.join(directory, 'defaults.yml')))
  })

  it('queries the WASM version without a system Pandoc', async function () {
    assert.match(await validatePandocWasmRuntime(path.resolve(process.env.PANDOC_TEST_WASM as string)), /^\d+\.\d+/)
  })

  it('reads relative resources with Unicode paths and writes outside cwd', async function () {
    const cwd = path.join(directory, 'nested')
    await fs.mkdir(cwd)
    await fs.writeFile(path.join(directory, '文章 with spaces.md'), '# Héllo\n\nOriginal')
    await fs.writeFile(path.join(directory, 'filter.lua'), 'function Str(s) if s.text == "Original" then return pandoc.Str("Filtered") end end')
    // Match the export popover's temporary-directory target.
    const output = path.join(os.tmpdir(), `zettlr-wasm-output-${randomUUID()}.html`)
    try {
      const result = await runPandoc({
        reader: 'markdown', writer: 'html',
        'input-files': ['../文章 with spaces.md'], 'output-file': output,
        filters: ['../filter.lua']
      }, cwd)
      assert.strictEqual(result.code, 0, result.stderr.join('\n'))
      const html = await fs.readFile(output, 'utf8')
      assert.match(html, /Héllo/)
      assert.match(html, /Filtered/)
      // Reactor IO must stay private, even when cwd is writable.
      assert.deepStrictEqual(await fs.readdir(cwd), [])
    } finally {
      await fs.rm(output, { force: true })
    }
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

  it('creates nested output directories alongside Lua side-effect files', async function () {
    await fs.writeFile(path.join(directory, 'input.md'), '# Nested output')
    await fs.mkdir(path.join(directory, 'new'))
    await fs.writeFile(path.join(directory, 'filter.lua'), `function Pandoc(doc)
      local sibling = io.open("new/sibling.html", "w")
      assert(sibling ~= nil, "Lua side-effect write was denied")
      sibling:write("Sibling output")
      sibling:close()
      return doc
    end`)
    const outputDirectory = path.join(directory, 'new', 'nested', 'destination')
    const result = await convert({
      reader: 'markdown', writer: 'html', 'input-files': ['input.md'], filters: ['filter.lua'],
      'output-file': path.join(outputDirectory, 'out.html')
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(outputDirectory, 'out.html'), 'utf8'), /Nested output/)
    assert.strictEqual(await fs.readFile(path.join(directory, 'new', 'sibling.html'), 'utf8'), 'Sibling output')
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

  it('follows host symlink semantics when an input path contains ..', async function () {
    const cwd = path.join(directory, 'work')
    await fs.mkdir(cwd)
    await fs.mkdir(path.join(directory, 'actual', 'inner'), { recursive: true })
    await fs.symlink(path.join(directory, 'actual', 'inner'), path.join(cwd, 'link'), 'junction')
    await fs.writeFile(path.join(directory, 'actual', 'input.md'), 'Physical target')
    await fs.writeFile(path.join(cwd, 'input.md'), 'Lexical target')
    const result = await runPandoc({
      reader: 'markdown', writer: 'html',
      'input-files': ['link/../input.md'], 'output-file': 'link/../out.html'
    }, cwd)
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'actual', 'out.html'), 'utf8'), /Physical target/)
    await fs.symlink(path.join(directory, 'actual', 'out.html'), path.join(cwd, 'output-link.html'), 'file')
    const symlinkOutput = await runPandoc({
      reader: 'markdown', writer: 'html', 'input-files': ['input.md'], 'output-file': 'output-link.html'
    }, cwd)
    assert.strictEqual(symlinkOutput.code, 0, symlinkOutput.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'actual', 'out.html'), 'utf8'), /Lexical target/)
    await fs.rmdir(path.join(directory, 'actual', 'inner'))
    const broken = await runPandoc({
      reader: 'markdown', writer: 'html', 'input-files': ['link/../input.md'], 'output-file': 'out.html'
    }, cwd)
    assert.strictEqual(broken.code, 1)
    assert.ok(broken.stderr.length > 0)
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
      const result = await runPandoc({ reader: 'markdown', writer: 'html', 'input-files': ['input.md'], 'output-file': 'out.html' }, cwd)
      assert.strictEqual(result.code, 0, result.stderr.join('\n'))
      return await fs.readFile(path.join(cwd, 'out.html'), 'utf8')
    }))
    assert.deepStrictEqual(results, ['<p>first</p>\n', '<p>second</p>\n'])
  })

  it('allows Lua filesystem access outside cwd while filtering environment variables', async function () {
    const cwd = path.join(directory, 'work')
    await fs.mkdir(cwd)
    await fs.writeFile(path.join(directory, 'secret.txt'), 'host secret')
    await fs.writeFile(path.join(cwd, 'input.md'), 'Safe input')
    await fs.writeFile(path.join(cwd, 'filter.lua'), `function Pandoc(doc)
      local input = io.open("../secret.txt", "r")
      assert(input ~= nil, "filter could not read a file outside cwd")
      assert(input:read("a") == "host secret")
      input:close()
      local output = io.open("../escaped.txt", "w")
      assert(output ~= nil, "filter could not write a file outside cwd")
      output:write("Side-effect output")
      output:close()
      assert(os.getenv("ZETTLR_WASM_TEST_SECRET") == nil, "filter read a host environment secret")
      return doc
    end`)
    const previousSecret = process.env.ZETTLR_WASM_TEST_SECRET
    process.env.ZETTLR_WASM_TEST_SECRET = 'host secret'
    try {
      const result = await runPandoc({
        reader: 'markdown', writer: 'html', filters: ['filter.lua'],
        'input-files': ['input.md'], 'output-file': 'out.html'
      }, cwd)
      assert.strictEqual(result.code, 0, result.stderr.join('\n'))
      assert.strictEqual(await fs.readFile(path.join(directory, 'escaped.txt'), 'utf8'), 'Side-effect output')
    } finally {
      if (previousSecret === undefined) {
        delete process.env.ZETTLR_WASM_TEST_SECRET
      } else {
        process.env.ZETTLR_WASM_TEST_SECRET = previousSecret
      }
    }
  })

  it('allows a custom Lua reader to rewrite its input while exporting DOCX', async function () {
    const input = path.join(directory, 'meeting.minutes.md')
    await fs.writeFile(input, 'Original source')
    await fs.writeFile(path.join(directory, 'minutes.lua'), `function ByteStringReader(input, opts)
      local minutes = "Rendered minutes"
      pandoc.system.write_file(PANDOC_STATE.input_files[1]:gsub("reviewed", "minutes"), minutes)
      return pandoc.read(minutes, "markdown", opts)
    end`)
    const result = await convert({
      reader: path.join(directory, 'minutes.lua'), writer: 'docx',
      'input-files': [input], 'output-file': 'out.docx'
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.strictEqual(await fs.readFile(input, 'utf8'), 'Rendered minutes')
    assert.strictEqual((await fs.readFile(path.join(directory, 'out.docx'))).subarray(0, 2).toString(), 'PK')
  })

  it('preserves working-directory files with reactor IO names', async function () {
    await fs.writeFile(path.join(directory, 'stdin'), '# User input')
    await fs.writeFile(path.join(directory, 'stdout'), 'Previous export')
    await fs.writeFile(path.join(directory, 'stderr'), 'User diagnostics')
    await fs.writeFile(path.join(directory, 'warnings'), 'User warnings')
    await fs.writeFile(path.join(directory, 'filter.lua'), `function Pandoc(doc)
      local warnings = assert(io.open("warnings", "r"))
      assert(warnings:read("*a") == "User warnings")
      warnings:close()
      local diagnostics = assert(io.open("stderr", "w"))
      diagnostics:write("Updated diagnostics")
      diagnostics:close()
      return doc
    end`)
    const result = await convert({
      reader: 'markdown', writer: 'html', filters: ['filter.lua'],
      'input-files': ['stdin'], 'output-file': 'stdout'
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.deepStrictEqual(result.stderr, [])
    assert.match(await fs.readFile(path.join(directory, 'stdout'), 'utf8'), /User input/)
    assert.strictEqual(await fs.readFile(path.join(directory, 'warnings'), 'utf8'), 'User warnings')
    assert.strictEqual(await fs.readFile(path.join(directory, 'stderr'), 'utf8'), 'Updated diagnostics')
  })

  it('captures Lua stdout/stderr and preserves informational diagnostics', async function () {
    await fs.writeFile(path.join(directory, 'input.md'), 'Body text')
    await fs.writeFile(path.join(directory, 'log.lua'), `function Pandoc(doc)
      print("Lua stdout marker")
      io.stdout:write("Buffered marker")
      io.stdout:flush()
      io.stderr:write("ERROR: diagnostic only\\n")
      pandoc.log.info("Info marker")
      assert(pandoc.utils.stringify(doc.meta.literal) == [[C:\\Users\\literal]])
      return doc
    end`)
    const result = await convert({
      reader: 'markdown', writer: 'html', verbosity: 'INFO', 'fail-if-warnings': true,
      filters: ['log.lua'], metadata: { literal: 'C:\\Users\\literal' },
      'input-files': ['input.md'], 'output-file': 'out.html'
    })
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.ok(result.stdout.includes('Lua stdout marker'))
    assert.ok(result.stdout.includes('Buffered marker'))
    assert.match(result.stdout.join('\n'), /Info marker/)
    assert.ok(result.stderr.includes('ERROR: diagnostic only'))
    assert.doesNotMatch(result.stderr.join('\n'), /Info marker/)
    assert.match(await fs.readFile(path.join(directory, 'out.html'), 'utf8'), /Body text/)
  })

  it('reports Lua exit requests without losing earlier diagnostics', async function () {
    await fs.writeFile(path.join(directory, 'input.md'), 'Body text')
    await fs.writeFile(path.join(directory, 'exit.lua'), 'function Pandoc(doc) print("Before exit") io.stderr:write("Exit diagnostic\\n") os.exit(7) end')
    const result = await convert({
      reader: 'markdown', writer: 'html', filters: ['exit.lua'],
      'input-files': ['input.md'], 'output-file': 'out.html'
    })
    assert.strictEqual(result.code, 1)
    assert.ok(result.stdout.includes('Before exit'))
    assert.match(result.stderr.join('\n'), /Exit diagnostic/)
    assert.match(result.stderr.join('\n'), /exited with code 7/)
  })
})
