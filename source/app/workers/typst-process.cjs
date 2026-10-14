/* eslint-disable @typescript-eslint/no-require-imports -- Standalone utility-process entry. */
const fs = require('node:fs')
const path = require('node:path')
const { fontFiles, systemFontFiles } = require('./typst-fonts.cjs')
const { pathToFileURL } = require('node:url')
const port = process.parentPort
let started = false

const guest = filename => process.platform === 'win32'
  ? '/' + filename.replaceAll('\\', '/').replace(/^\/+/, '') : filename
const host = filename => process.platform === 'win32'
  ? path.normalize(filename.replace(/^\/([A-Za-z]:\/)/, '$1')) : filename
const attempt = fn => { try { return fn() } catch { return undefined } }

async function compile (job) {
  // Explicit wrappers/modules/fonts disable typst.ts's default CDN lookups.
  const { createTypstCompiler } = require(path.join(job.driver, 'compiler.cjs'))
  const { loadFonts, withAccessModel, withPackageRegistry } = require(path.join(job.driver, 'options.init.cjs'))
  const wrapper = await import(pathToFileURL(path.join(job.compiler, 'wasm-pack-shim.mjs')).href)
  const families = new Set()
  const lazyFonts = []
  let unsupportedPackage = false
  const compiler = createTypstCompiler()
  await compiler.init({
    getWrapper: () => wrapper,
    getModule: () => ({ module_or_path: fs.readFileSync(path.join(job.compiler, 'typst_ts_web_compiler_bg.wasm')) }),
    beforeBuild: [
      async () => {
        const fonts = [...new Set([
          ...(job.fontPath.trim() === '' ? [] : fontFiles(path.resolve(job.cwd, job.fontPath), { strict: true })),
          ...systemFontFiles()
        ])]
        const metadata = new wrapper.TypstFontResolverBuilder()
        try {
          for (const filename of fonts) {
            const info = attempt(() => metadata.get_font_info(fs.readFileSync(filename)))
            if (!info?.info?.length) continue
            for (const font of info.info) families.add(font.family)
            lazyFonts.push({ ...info, blob: () => fs.readFileSync(filename) })
          }
        } finally { metadata.free() }
        if (lazyFonts.length === 0) throw new Error('No usable system fonts found. Install fonts or configure an additional Typst fonts folder.')
      },
      loadFonts(lazyFonts, { assets: false }),
      withAccessModel({
        getMTime: filename => attempt(() => fs.statSync(host(filename)).mtime),
        isFile: filename => attempt(() => fs.statSync(host(filename)).isFile()) ?? false,
        getRealPath: filename => attempt(() => guest(fs.realpathSync(host(filename)))),
        readAll: filename => attempt(() => fs.readFileSync(host(filename)))
      }),
      withPackageRegistry({
        resolve () {
          unsupportedPackage = true
          return undefined
        }
      })
    ]
  })
  const main = guest(path.join(job.cwd, '.zettlr-typst-main.typ'))
  const choose = candidates => candidates.find(name => [...families].some(family => family.toLowerCase() === name.toLowerCase()))
  const text = choose(['Libertinus Serif', 'Linux Libertine', 'Times New Roman', 'Times', 'Noto Serif', 'Liberation Serif', 'DejaVu Serif']) ?? [...families][0]
  const mono = choose(['DejaVu Sans Mono', 'Consolas', 'Menlo', 'Liberation Mono', 'Courier New', 'Courier'])
  const math = choose(['New Computer Modern Math', 'Cambria Math', 'STIX Two Math', 'STIX Math', 'Latin Modern Math', 'TeX Gyre Termes Math', 'DejaVu Math TeX Gyre', 'Noto Sans Math'])
  // Establish available defaults before the document's own font settings.
  const defaults = [`#set text(font: ${JSON.stringify(text)})`,
    ...(mono ? [`#show raw: set text(font: ${JSON.stringify(mono)})`] : []),
    ...(math ? [`#show math.equation: set text(font: ${JSON.stringify(math)})`] : [])]
  const document = guest(path.join(job.cwd, '.zettlr-typst-document.typ'))
  compiler.addSource(document, job.source)
  compiler.addSource(main, defaults.join('\n') + '\n#include ' + JSON.stringify(document))
  // compile() reports warnings that the direct PDF shortcut can omit.
  const result = await compiler.runWithWorld({ root: '/', mainFilePath: main, inputs: {} }, async world => {
    const compiled = await world.compile({ diagnostics: 'full' })
    if (compiled.hasError) return { diagnostics: compiled.diagnostics }
    const pdf = await world.pdf({ diagnostics: 'full' })
    return { result: pdf.result, diagnostics: [...(compiled.diagnostics ?? []), ...(pdf.diagnostics ?? [])] }
  })
  const unique = [...new Map((result.diagnostics ?? []).map(diagnostic => [JSON.stringify(diagnostic), diagnostic])).values()]
  const diagnostics = unique.map(diagnostic => ({
    severity: diagnostic.severity,
    text: `${diagnostic.path || main}${diagnostic.range ? ':' + diagnostic.range.replace(/\d+/g, value => String(Number(value) + 1)) : ''}: ${diagnostic.severity}: ${diagnostic.message}`
  }))
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.text)
  if (errors.length > 0 || result.result === undefined || result.result.length === 0) {
    return { warnings: [], error: [...errors, ...(unsupportedPackage ? ['Typst package imports are not supported for PDF export.'] : [])].join('\n') || 'Typst produced no PDF output.' }
  }
  if (Buffer.from(result.result).subarray(0, 5).toString() !== '%PDF-') throw new Error('Typst produced invalid PDF output.')
  const warnings = diagnostics.map(diagnostic => diagnostic.text)
  if (job.failIfWarnings && warnings.length > 0) return { warnings, error: warnings.join('\n') }
  fs.writeFileSync(job.output, result.result)
  return { warnings }
}

function receive (message) {
  if (message.acknowledgement === true) process.exit(0)
  if (started) return
  started = true
  compile(message).catch(error => ({ warnings: [], error: error instanceof Error ? error.message : String(error) }))
    .then(result => { if (port) port.postMessage(result); else process.send(result) })
}
if (port) port.on('message', event => receive(event.data))
else process.on('message', receive)
