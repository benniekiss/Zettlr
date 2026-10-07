/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        PDF Exporter plugin
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports to PDF by converting to HTML with Pandoc, then
 *                  using Chromium's print API.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import { BrowserWindow } from 'electron'
import type { ExporterOptions, ExporterPlugin, ExporterOutput, ExporterAPI } from './types'
import sanitize from 'sanitize-filename'
import { randomUUID } from 'crypto'
import { parseReaderWriter } from '@common/pandoc-util/parse-reader-writer'

export const plugin: ExporterPlugin = async function (options: ExporterOptions, sourceFiles: string[], ctx: ExporterAPI): Promise<ExporterOutput> {
  // First file determines the name of the output path, EXCEPT a title is
  // explicitly set.
  const firstName = path.basename(options.sourceFiles[0].name, options.sourceFiles[0].ext)
  const title = (options.defaultsOverride?.title !== undefined) ? sanitize(options.defaultsOverride.title, { replacement: '-' }) : firstName
  const pdfFilePath = path.join(options.targetDirectory, `${title}.pdf`)
  // Keep relative resources beside the target, without overwriting a user's
  // existing HTML export or colliding with another PDF conversion.
  const htmlFilePath = path.join(options.targetDirectory, `.zettlr-pdf-${randomUUID()}.html`)

  // Get the corresponding defaults file
  const defaultKeys = {
    'input-files': sourceFiles,
    'output-file': htmlFilePath
  }

  // Now we'll have to get the correct exporting template
  const allDefaults = (await ctx.listDefaults())
    .filter(e => !e.isInvalid && [ 'html', 'html4', 'html5' ].includes(parseReaderWriter(e.writer).name))

  if (allDefaults.length === 0) {
    throw new Error('Simple PDF export requires a valid HTML export profile.')
  }

  if (allDefaults.length > 1) {
    console.warn(`[SimplePDF Export] More than one suitable format for exporting to HTML found - using first one: ${allDefaults[0].name}`)
  }

  let printer: BrowserWindow|undefined
  try {
    const defaultsFile = await ctx.writeDefaults(allDefaults[0].name, defaultKeys)
    const pandocOutput = await ctx.runPandoc(defaultsFile)
    if (pandocOutput.code !== 0) {
      return { ...pandocOutput, targetFile: pdfFilePath }
    }
    printer = new BrowserWindow({ width: 600, height: 800, show: false })
    await printer.loadFile(htmlFilePath)
    const pdfData = await printer.webContents.printToPDF({
      printBackground: false,
      landscape: false,
      pageSize: 'A4'
    })
    await fs.writeFile(pdfFilePath, pdfData)
    return { ...pandocOutput, targetFile: pdfFilePath }
  } finally {
    if (printer !== undefined && !printer.isDestroyed()) {
      printer.destroy()
    }
    await fs.rm(htmlFilePath, { force: true })
  }
}
