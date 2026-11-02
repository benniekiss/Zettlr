import path from 'path'
import { promises as fs } from 'fs'
import sanitize from 'sanitize-filename'
import normalizePath from '@common/util/normalize-path'
import { compileTypst } from '../../../util/compile-typst'
import type { ExporterPlugin } from './types'

export const plugin: ExporterPlugin = async (options, sourceFiles, ctx) => {
  const first = options.sourceFiles[0]
  const title = options.defaultsOverride?.title === undefined
    ? path.basename(first.name, first.ext) : sanitize(options.defaultsOverride.title, { replacement: '-' })
  let target = path.join(options.targetDirectory, `${title}.pdf`)
  let directory: string|undefined
  let output = { code: 0, stdout: [] as string[], stderr: [] as string[] }
  try {
    const defaults = await ctx.loadDefaults(options.profile.name, { 'input-files': sourceFiles })
    if (typeof defaults['output-file'] === 'string' && defaults['output-file'] !== '') {
      target = normalizePath(defaults['output-file'], options.targetDirectory)
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    directory = await fs.mkdtemp(path.join(path.dirname(target), '.zettlr-typst-'))
    const source = path.join(directory, 'input.typ')
    const pdf = path.join(directory, 'output.pdf')
    defaults.writer = 'typst'
    defaults.standalone = true
    defaults['output-file'] = source
    defaults['extract-media'] ??= path.join(directory, 'media')
    output = await ctx.runPandoc(defaults)
    if (output.code !== 0) {
      return { ...output, targetFile: target }
    }
    const warnings = await compileTypst(await fs.readFile(source, 'utf8'), pdf,
      options.cwd ?? path.dirname(first.path), { fontPath: ctx.typstFontPath, failIfWarnings: defaults['fail-if-warnings'] === true })
    await fs.rename(pdf, target)
    return { ...output, stderr: [ ...output.stderr, ...warnings ], targetFile: target }
  } catch (error) {
    return { code: 1, stdout: output.stdout, stderr: [ ...output.stderr, error instanceof Error ? error.message : String(error) ], targetFile: target }
  } finally {
    if (directory !== undefined) {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
