import assert from 'assert'
import { randomUUID } from 'crypto'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import YAML from 'yaml'
import { configurePandocWasm, getPandocVersion, runPandoc } from '../source/app/util/run-pandoc'
import { downloadPandocWasm } from '../source/app/util/download-pandoc-wasm'
import { Worker } from 'worker_threads'
import { plugin as exportDocument } from '../source/app/service-providers/commands/exporter/default-exporter'

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

  it('reads parent-directory resources and writes into the OS temp directory', async function () {
    const nested = path.join(directory, 'nested')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(directory, 'input.md'), '# Outside directory\n\nOriginal')
    await fs.writeFile(path.join(directory, 'filter.lua'), 'function Str(s) if s.text == "Original" then return pandoc.Str("Filtered") end end')
    // Match the export popover's temporary-directory target: output lives in
    // the OS temp directory, outside the conversion's working directory.
    const output = path.join(os.tmpdir(), `zettlr-wasm-output-${randomUUID()}.html`)
    const defaults = path.join(nested, 'defaults.yml')
    await fs.writeFile(defaults, YAML.stringify({
      reader: 'markdown', writer: 'html', 'input-files': ['../input.md'],
      filters: ['../filter.lua'], 'output-file': output
    }))
    try {
      const result = await runPandoc(defaults, nested)
      assert.strictEqual(result.code, 0, result.stderr.join('\n'))
      assert.match(await fs.readFile(output, 'utf8'), /Filtered/)
      // Reactor IO must stay private, even when cwd is writable.
      assert.deepStrictEqual((await fs.readdir(nested)).sort(), ['defaults.yml'])
    } finally {
      await fs.rm(output, { force: true })
    }
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
    const defaults = path.join(cwd, 'defaults.yml')
    await fs.writeFile(defaults, YAML.stringify({
      reader: 'markdown', writer: 'html',
      'input-files': ['link/../input.md'], 'output-file': 'link/../out.html'
    }))
    const result = await runPandoc(defaults, cwd)
    assert.strictEqual(result.code, 0, result.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'actual', 'out.html'), 'utf8'), /Physical target/)
    await fs.symlink(path.join(directory, 'actual', 'out.html'), path.join(cwd, 'output-link.html'), 'file')
    await fs.writeFile(defaults, YAML.stringify({
      reader: 'markdown', writer: 'html', 'input-files': ['input.md'], 'output-file': 'output-link.html'
    }))
    const symlinkOutput = await runPandoc(defaults, cwd)
    assert.strictEqual(symlinkOutput.code, 0, symlinkOutput.stderr.join('\n'))
    assert.match(await fs.readFile(path.join(directory, 'actual', 'out.html'), 'utf8'), /Lexical target/)
    await fs.rmdir(path.join(directory, 'actual', 'inner'))
    await fs.writeFile(defaults, YAML.stringify({
      reader: 'markdown', writer: 'html', 'input-files': ['link/../input.md'], 'output-file': 'out.html'
    }))
    const broken = await runPandoc(defaults, cwd)
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
      const defaults = path.join(cwd, 'defaults.yml')
      await fs.writeFile(defaults, YAML.stringify({ reader: 'markdown', writer: 'html', 'input-files': ['input.md'], 'output-file': 'out.html' }))
      const result = await runPandoc(defaults, cwd)
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
      const defaults = path.join(cwd, 'defaults.yml')
      await fs.writeFile(defaults, YAML.stringify({
        reader: 'markdown', writer: 'html', filters: ['filter.lua'],
        'input-files': ['input.md'], 'output-file': 'out.html'
      }))
      const result = await runPandoc(defaults, cwd)
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

  it('can replace the filesystem policy with read-only source access', async function () {
    const input = path.join(directory, 'input.md')
    const output = path.join(directory, 'out.html')
    await fs.writeFile(input, 'Original source')
    await fs.writeFile(path.join(directory, 'readonly.lua'), `function Pandoc(doc)
      local file = assert(io.open(PANDOC_STATE.input_files[1], "r+"))
      file:setvbuf("no")
      assert(file:write("Changed") == nil, "policy allowed a descriptor write")
      file:close()
      assert(os.rename(PANDOC_STATE.input_files[1], "moved.md") == nil, "policy allowed a rename")
      return doc
    end`)
    const workerPath = path.resolve('source/app/util/pandoc-worker.cjs')
    const policyPath = path.resolve('source/app/util/pandoc-filesystem-policy.cjs')
    const wrapper = path.join(directory, 'readonly-worker.cjs')
    // Replace the policy module in this worker only, leaving the reactor and
    // production default untouched. This exercises the pluggable contract.
    await fs.writeFile(wrapper, `
      const create = require(${JSON.stringify(policyPath)})
      require.cache[${JSON.stringify(policyPath)}].exports = context => ({
        ...create(context),
        allows: request => request.access === 'read' || request.path === ${JSON.stringify(output)}
      })
      require(${JSON.stringify(workerPath)})
    `)
    const result = await new Promise<{ failed?: boolean, error?: string, stderr: string }>((resolve, reject) => {
      const worker = new Worker(wrapper, {
        workerData: {
          wasmPath: path.resolve(process.env.PANDOC_TEST_WASM as string), cwd: directory,
          options: { reader: 'markdown', writer: 'html', filters: ['readonly.lua'], 'input-files': [input], 'output-file': output }
        }
      })
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited with code ${code}`)) })
    })
    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.failed, false, result.stderr)
    assert.strictEqual(await fs.readFile(input, 'utf8'), 'Original source')
    assert.match(await fs.readFile(output, 'utf8'), /Original source/)
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
