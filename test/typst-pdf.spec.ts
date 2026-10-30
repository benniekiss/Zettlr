import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import YAML from 'yaml'
import { fontFiles, systemFontFiles, systemFontRoots } from '../source/app/processes/typst-fonts.cjs'
import { compileTypst, warmTypstFontCache } from '../source/app/util/compile-typst'
import { plugin as exportTypstPDF } from '../source/app/service-providers/commands/exporter/typst-pdf-exporter'
import { configurePandocWasm, runPandoc } from '../source/app/util/run-pandoc'
import { PANDOC_WRITERS, WRITER2EXT } from '../source/common/pandoc-util/pandoc-maps'

describe('Typst WASM PDF', function () {
  this.timeout(60000)
  let directory: string
  beforeEach(async function () { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-typst-test-')) })
  afterEach(async function () { await fs.rm(directory, { recursive: true, force: true }) })

  it('discovers platform system and user font directories', function () {
    assert.deepStrictEqual(systemFontRoots('darwin', '/home/test', {}), ['/System/Library/Fonts', '/Library/Fonts', path.join('/home/test', 'Library/Fonts')])
    assert.deepStrictEqual(systemFontRoots('win32', '/home/test', { WINDIR: '/windows', LOCALAPPDATA: '/local' }), [path.join('/windows', 'Fonts'), path.join('/local', 'Microsoft/Windows/Fonts')])
    assert.ok(systemFontRoots('linux', '/home/test', { XDG_DATA_HOME: '/data', XDG_DATA_DIRS: '/extra:/other' }).includes(path.join('/extra', 'fonts')))
  })

  it('handles missing font directories and symlink cycles', async function () {
    const fonts = path.join(directory, 'fonts')
    await fs.mkdir(fonts)
    await fs.writeFile(path.join(fonts, 'example.ttf'), 'font')
    await fs.symlink(fonts, path.join(fonts, 'cycle'), 'junction')
    assert.deepStrictEqual(fontFiles(fonts), [path.join(fonts, 'example.ttf')])
    assert.deepStrictEqual(fontFiles(path.join(directory, 'missing')), [])
    assert.throws(() => fontFiles(path.join(directory, 'missing'), { strict: true }), /ENOENT/)
  })

  it('warms system and additional font metadata without creating a document', async function () {
    const fonts = path.join(directory, 'fonts')
    await fs.mkdir(fonts)
    const installed = systemFontFiles()[0]
    assert.ok(installed, 'This test requires installed system fonts')
    await fs.copyFile(installed, path.join(fonts, path.basename(installed)))
    await warmTypstFontCache(fonts, directory)
    assert.deepStrictEqual(await fs.readdir(directory), ['fonts'])
  })

  it('shares startup work with early exports while respecting their deadlines', async function () {
    const warming = warmTypstFontCache('', directory)
    const duplicate = warmTypstFontCache('', directory)
    const target = path.join(directory, 'output.pdf')
    const exporting = compileTypst('Body', target, directory)
    await assert.rejects(compileTypst('Body', path.join(directory, 'timed-out.pdf'), directory, { timeoutMs: 1 }), /compilation timed out/)
    await Promise.all([warming, duplicate, exporting])
    assert.strictEqual((await fs.readFile(target)).subarray(0, 5).toString(), '%PDF-')
    assert.deepStrictEqual(await fs.readdir(directory), ['output.pdf'])
  })

  it('allows exports to retry after startup font preparation fails', async function () {
    const warming = warmTypstFontCache('missing-fonts', directory)
    const target = path.join(directory, 'output.pdf')
    await Promise.all([
      assert.rejects(warming, /missing-fonts/),
      compileTypst('Body', target, directory)
    ])
    assert.strictEqual((await fs.readFile(target)).subarray(0, 5).toString(), '%PDF-')
    await warmTypstFontCache('', directory)
  })

  it('compiles text, math, tables, footnotes, and local image/include resources offline', async function () {
    await fs.writeFile(path.join(directory, 'section.typ'), '= Included section\nHéllo #footnote[Footnote text]')
    await fs.writeFile(path.join(directory, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')
    const target = path.join(directory, 'output.pdf')
    const warnings = await compileTypst('#include "section.typ"\nMath $x^2 + y^2$.\n#table(columns: 2, [One], [Two])\n#image("pixel.svg")', target, directory)
    assert.deepStrictEqual(warnings, [])
    const pdf = await fs.readFile(target)
    assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-')
    assert.match(pdf.toString('latin1'), /\/Type \/Page/)
    assert.deepStrictEqual((await fs.readdir(path.dirname(target))).sort(), ['output.pdf', 'pixel.svg', 'section.typ'])
  })

  it('keeps the previous PDF after compilation errors and cleans its temporary files', async function () {
    const target = path.join(directory, 'output.pdf')
    await fs.writeFile(target, 'previous PDF')
    await assert.rejects(compileTypst('#unknown_function()', target, directory), /\.zettlr-typst-document\.typ:1:.*unknown_function/)
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'previous PDF')
    assert.deepStrictEqual(await fs.readdir(directory), ['output.pdf'])
  })

  it('reports font warnings and respects fail-if-warnings before replacing a PDF', async function () {
    const target = path.join(directory, 'output.pdf')
    const source = '#set text(font: "Zettlr nonexistent test font")\nBody'
    const warnings = await compileTypst(source, target, directory)
    assert.match(warnings.join('\n'), /unknown font family/i)
    const previous = await fs.readFile(target)
    await assert.rejects(compileTypst(source, target, directory, { failIfWarnings: true }), /unknown font family/i)
    assert.deepStrictEqual(await fs.readFile(target), previous)
    assert.deepStrictEqual(await fs.readdir(directory), ['output.pdf'])
  })

  it('loads additional fonts and reports an invalid configured font folder', async function () {
    const target = path.join(directory, 'output.pdf')
    const fonts = path.join(directory, 'fonts', 'nested')
    await fs.mkdir(fonts, { recursive: true })
    const installed = systemFontFiles()[0]
    assert.ok(installed, 'This test requires installed system fonts')
    await fs.copyFile(installed, path.join(fonts, path.basename(installed)))
    await compileTypst('Body', target, directory, { fontPath: path.dirname(fonts) })
    await assert.rejects(compileTypst('Body', target, directory, { fontPath: 'missing-fonts' }), /missing-fonts/)
    assert.deepStrictEqual((await fs.readdir(directory)).sort(), ['fonts', 'output.pdf'])
  })

  it('enforces the compilation deadline, preserves the previous PDF, and removes work files', async function () {
    const target = path.join(directory, 'output.pdf')
    await fs.writeFile(target, 'previous PDF')
    await assert.rejects(compileTypst('Body', target, directory, { timeoutMs: 1 }), /Typst WASM compilation timed out/)
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'previous PDF')
    assert.deepStrictEqual(await fs.readdir(directory), ['output.pdf'])
  })

  it('rejects package imports without attempting a download', async function () {
    await assert.rejects(compileTypst('#import "@preview/zettlr-nonexistent-test:1.0.0": *', path.join(directory, 'output.pdf'), directory), /package imports are not supported/)
    assert.deepStrictEqual(await fs.readdir(directory), [])
  })

  it('keeps concurrent Typst compilations isolated', async function () {
    await Promise.all(['first', 'second'].map(async name => {
      const cwd = path.join(directory, name)
      await fs.mkdir(cwd)
      await fs.writeFile(path.join(cwd, 'body.typ'), `= ${name}`)
      const target = path.join(cwd, 'output.pdf')
      await compileTypst('#include "body.typ"', target, cwd)
      assert.strictEqual((await fs.readFile(target)).subarray(0, 5).toString(), '%PDF-')
      assert.deepStrictEqual((await fs.readdir(cwd)).sort(), ['body.typ', 'output.pdf'])
    }))
  })

  it('preserves Pandoc failure diagnostics and leaves the existing PDF intact', async function () {
    const input = path.join(directory, 'input.md')
    const target = path.join(directory, 'input.pdf')
    await fs.writeFile(target, 'previous PDF')
    const result = await exportTypstPDF({
      profile: { name: 'Typst PDF.yaml', reader: 'markdown', writer: 'typst-pdf', isInvalid: false, outputFile: '' },
      sourceFiles: [{ path: input, name: 'input.md', ext: '.md' }],
      targetDirectory: directory, cwd: directory
    }, [input], {
      loadDefaults: async (_name, overrides) => ({ ...overrides }),
      runPandoc: async () => ({ code: 23, stdout: ['additional output'], stderr: ['reader failed'] }),
      listDefaults: async () => [],
      resolveTargetPath: async target => path.resolve(directory, target),
      confirmTargetOverwrite: async () => true
    })
    assert.deepStrictEqual(result, { status: 'completed', output: { code: 23, stdout: ['additional output'], stderr: ['reader failed'], targetFile: target } })
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'previous PDF')
    assert.deepStrictEqual(await fs.readdir(directory), ['input.pdf'])
  })

  it('keeps the previous PDF and cleans the single job directory after Typst errors or warning failures', async function () {
    const input = path.join(directory, 'input.md')
    const target = path.join(directory, 'input.pdf')
    await fs.writeFile(target, 'previous PDF')
    for (const source of ['#unknown_function()', '#set text(font: "Zettlr nonexistent test font")\nBody']) {
      const result = await exportTypstPDF({
        profile: { name: 'Custom PDF.yaml', reader: 'markdown', writer: 'typst-pdf', isInvalid: false, outputFile: '' },
        sourceFiles: [{ path: input, name: 'input.md', ext: '.md' }],
        targetDirectory: directory, cwd: directory
      }, [input], {
        loadDefaults: async (name, overrides) => {
          assert.strictEqual(name, 'Custom PDF.yaml')
          return { ...overrides, 'fail-if-warnings': true }
        },
        runPandoc: async defaults => {
          const jobs = (await fs.readdir(directory)).filter(name => name.startsWith('.zettlr-typst-'))
          assert.strictEqual(jobs.length, 1)
          assert.strictEqual(path.basename(defaults['output-file'] as string), 'input.typ')
          await fs.writeFile(defaults['output-file'] as string, source)
          return { code: 0, stdout: ['additional output'], stderr: ['Pandoc warning'] }
        },
        listDefaults: async () => [],
        resolveTargetPath: async target => path.resolve(directory, target),
        confirmTargetOverwrite: async () => true
      })
      assert.strictEqual(result.status, 'completed')
      assert.strictEqual(result.output.code, 1)
      assert.deepStrictEqual(result.output.stdout, ['additional output'])
      assert.strictEqual(result.output.stderr[0], 'Pandoc warning')
      assert.match(result.output.stderr.join('\n'), /unknown_function|unknown font family/)
      assert.strictEqual(await fs.readFile(target, 'utf8'), 'previous PDF')
      assert.deepStrictEqual(await fs.readdir(directory), ['input.pdf'])
    }
  })

  const integration = process.env.PANDOC_TEST_WASM === undefined ? it.skip : it
  integration('exports Markdown through the Typst profile and WASM compiler to the configured PDF path', async function () {
    this.timeout(30000)
    assert.strictEqual(PANDOC_WRITERS.typst, 'Typst')
    assert.strictEqual(WRITER2EXT['typst-pdf'], 'pdf')
    const input = path.join(directory, 'minutes.md')
    await fs.writeFile(input, '# Meeting minutes\n\nHéllo. Math: $x^2$.\n\nCitation [@book].\n\nFootnote.[^one]\n\n[^one]: A note.')
    await fs.writeFile(path.join(directory, 'refs.bib'), '@book{book, title={Example Book}, author={Doe, Jane}, year={2026}}')
    configurePandocWasm(async () => path.resolve(process.env.PANDOC_TEST_WASM as string))
    const profile = YAML.parse(await fs.readFile('static/defaults/Typst PDF.yaml', 'utf8'))
    const result = await exportTypstPDF({
      profile: { name: 'Typst PDF.yaml', reader: 'markdown', writer: 'typst-pdf', isInvalid: false, outputFile: '' },
      sourceFiles: [{ path: input, name: 'minutes.md', ext: '.md' }],
      targetDirectory: directory, cwd: directory
    }, [input], {
      loadDefaults: async (name, overrides) => {
        assert.strictEqual(name, 'Typst PDF.yaml')
        return { ...profile, ...overrides, bibliography: ['refs.bib'], 'output-file': 'custom/report.pdf' }
      },
      runPandoc: async defaults => await runPandoc(defaults, directory),
      listDefaults: async () => [],
      resolveTargetPath: async target => path.resolve(directory, target),
      confirmTargetOverwrite: async () => true
    })
    assert.strictEqual(result.status, 'completed')
    assert.strictEqual(result.output.code, 0, result.output.stderr.join('\n'))
    assert.strictEqual(result.output.targetFile, path.join(directory, 'custom/report.pdf'))
    assert.strictEqual((await fs.readFile(result.output.targetFile)).subarray(0, 5).toString(), '%PDF-')
    assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.zettlr-typst-')))
  })
})
