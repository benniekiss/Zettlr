/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Module
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This module allows exporting files with Pandoc.
 *
 * END HEADER
 */

// Modules
import path from 'path'
import { runPandoc as runPandocWasm } from '../../../util/run-pandoc'
import YAML from 'yaml'
import { app } from 'electron'
import { promises as fs } from 'fs'

// Utilities
import isFile from '@common/util/is-file'

// Exporters
import type { DefaultsOverride, ExporterAPI, ExporterOptions, ExporterOutput, PandocRunnerOutput } from './types'
import { plugin as DefaultExporter } from './default-exporter'
import { plugin as PDFExporter } from './pdf-exporter'
import { plugin as TextbundleExporter } from './textbundle-exporter'
import type AssetsProvider from '@providers/assets'
import type LogProvider from '@providers/log'
import { type PandocProfileMetadata } from '@providers/assets'
import type ConfigProvider from '@providers/config'
import { enableExtension, parseReaderWriter, readerWriterToString } from '@common/pandoc-util/parse-reader-writer'
import { supportsExtension } from 'source/common/pandoc-util/pandoc-extensions'

/**
 * This function returns faux metadata for the custom export formats the
 * exporter supports which circumvent (or build upon) the Pandoc exporter. These
 * are not defined as regular defaults files, therefore we need to output them
 * here.
 *
 * @return  {PandocProfileMetadata[]}The additional profiles
 */
export function getCustomProfiles (): PandocProfileMetadata[] {
  return [
    {
      name: 'Textbundle.yaml', // Fake name
      reader: 'markdown', // Not completely the truth
      writer: 'textbundle', // Not even supported by Pandoc
      isInvalid: false // IT'S ALL FAKE!
    },
    {
      name: 'Textpack.yaml',
      reader: 'markdown',
      writer: 'textpack',
      isInvalid: false
    },
    {
      name: 'Simple PDF.yaml',
      reader: 'markdown',
      writer: 'simple-pdf',
      isInvalid: false
    }
  ]
}

const PLUGINS = {
  pandoc: DefaultExporter,
  'simple-pdf': PDFExporter,
  textbundle: TextbundleExporter
}

/**
 * Runs the exporter.
 *
 * @param   {ExporterOptions}  options             The options needed to facilitate the export.
 * @param   {any}              [formatOptions={}]  These are options possibly required by a plugin.
 *
 * @return  {Promise<ExporterOutput>}              Resolves with an info object.
 */
export async function makeExport (
  options: ExporterOptions,
  logger: LogProvider,
  config: ConfigProvider,
  assets: AssetsProvider
): Promise<ExporterOutput> {
  // We already know where the exported file will end up, so set the property
  const inputFiles = options.sourceFiles.map(file => file.path)

  // This is basically the "plugin API"
  const temporary = await fs.mkdtemp(path.join(app.getPath('temp'), 'zettlr-export-'))
  const ctx: ExporterAPI = {
    runPandoc: async (defaults: string) => {
      return await runPandoc(logger, defaults, options.cwd)
    },
    writeDefaults: async (filename: string, overrides: Record<string, unknown> = {}) => {
      return await writeDefaults(filename, overrides, config, logger, assets, path.join(temporary, 'defaults.yml'), options.defaultsOverride)
    },
    listDefaults: async () => {
      return await assets.listDefaults()
    }
  }

  try {
    // Search for the correct plugin to run, and run it. First the custom ones ...
    if ([ 'textbundle', 'textpack' ].includes(options.profile.writer)) {
      return await PLUGINS.textbundle(options, inputFiles, ctx)
    } else if (options.profile.writer === 'simple-pdf') {
      return await PLUGINS['simple-pdf'](options, inputFiles, ctx)
    } else {
      // ... otherwise run the regular Pandoc exporter.
      return await PLUGINS.pandoc(options, inputFiles, ctx)
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function runPandoc (logger: LogProvider, defaultsFile: string, cwd?: string): Promise<PandocRunnerOutput> {
  const output = await runPandocWasm(defaultsFile, cwd)

  if (output.stdout.length > 0) {
    logger.info('This Pandoc run produced additional output.', output.stdout)
  }
  if (output.stderr.length > 0) {
    if (output.code === 0) {
      logger.warning('This Pandoc run produced warnings.', output.stderr)
    } else {
      logger.error('This Pandoc run failed.', output.stderr)
    }
  }

  return output
}

// REFERENCE: Full defaults file here: https://pandoc.org/MANUAL.html#default-files

async function writeDefaults (
  filename: string, // The profile to use
  properties: Record<string, unknown>, // Contains properties that will be written to the defaults
  config: ConfigProvider,
  logger: LogProvider,
  assets: AssetsProvider,
  defaultsFile: string,
  defaultsOverride?: DefaultsOverride
): Promise<string> {
  const defaults = await assets.getDefaultsFile(filename)

  const cfg = config.get()
  const { cslLibrary, cslStyle, stripTags, stripLinks, forceEnableExtensions } = cfg.export
  const { linkFormat } = cfg.zkn

  // First step: Reader treatment. Zettlr can modify the reader to align with
  // the user preferences.
  const parsedReader = parseReaderWriter(defaults.reader as string)
  
  // The user can choose to use [[link|title]] or [[title|link]] syntax. In
  // order for the Lua filter to work properly and respect the link removal
  // setting upon export, we need to set the appropriate extension if it is not
  // already set in the `reader` property.
  const linkExt = linkFormat === 'link|title'
    ? 'wikilinks_title_after_pipe'
    : 'wikilinks_title_before_pipe'

  if (supportsExtension(parsedReader, linkExt)) {
    enableExtension(parsedReader, linkExt)
  } else {
    logger.warning(`[Exporter] Cannot enable link extension "${linkExt}" for reader "${parsedReader.name}": It appears unsupported.`)
  }

  // Same for the `mark` and `alerts` extensions which makes Pandoc correctly
  // parse `==mark==` and `> [!ALERT]` blocks.
  if (forceEnableExtensions.mark && supportsExtension(parsedReader, 'mark')) {
    enableExtension(parsedReader, 'mark')
  } else {
    logger.warning(`[Exporter] Cannot enable link extension "mark" for reader "${parsedReader.name}": It appears unsupported.`)
  }

  if (forceEnableExtensions.alerts && supportsExtension(parsedReader, 'alerts')) {
    enableExtension(parsedReader, 'alerts')
  } else {
    logger.warning(`[Exporter] Cannot enable link extension "alerts" for reader "${parsedReader.name}": It appears unsupported.`)
  }

  // Finally, write the modified reader
  defaults.reader = readerWriterToString(parsedReader)

  // In order to facilitate file-only databases, we need to get the currently
  // selected database. This could break in a lot of places, but until Pandoc
  // respects a file-defined bibliography, this is our best shot.
  // const bibliography = global.citeproc.getSelectedDatabase()
  if (isFile(cslLibrary)) {
    if ('bibliography' in defaults) {
      // Ensure the bibliography is an array, not a single string.
      if (!Array.isArray(defaults.bibliography)) {
        defaults.bibliography = [defaults.bibliography]
      }
      defaults.bibliography.push(cslLibrary)
    } else {
      defaults.bibliography = [cslLibrary]
    }
  }

  if (defaultsOverride?.csl !== undefined && isFile(defaultsOverride.csl)) {
    defaults.csl = defaultsOverride.csl
  } else if (isFile(cslStyle)) {
    defaults.csl = cslStyle
  }

  // Now add metadata values for our GUI settings the user can choose. NOTE that
  // users can also add these manually to their files if they prefer. This way
  // any file's metadata will overwrite anything defined programmatically here
  // in the defaults.
  if (!('metadata' in defaults)) {
    defaults.metadata = {}
  }

  if (!('zettlr' in defaults.metadata)) {
    defaults.metadata.zettlr = {}
  }

  defaults.metadata.zettlr.strip_tags = stripTags
  defaults.metadata.zettlr.strip_links = stripLinks

  // Potentially override allowed defaults properties
  if (defaultsOverride?.title !== undefined) {
    defaults.metadata.title = defaultsOverride.title
  }

  if (defaultsOverride?.template !== undefined) {
    defaults.template = defaultsOverride.template
  }

  // Add all filters which are within the userData/lua-filter directory.
  if (!('filters' in defaults)) {
    defaults.filters = []
  }

  const filters = await assets.listFilters(true)
  defaults.filters = defaults.filters.concat(filters)

  // After we have added our default keys, let the plugin add their keys, which
  // enables them to override certain keys if necessary.
  for (const key in properties) {
    defaults[key] = properties[key]
  }

  const YAMLOptions = {
    indent: 4,
    simpleKeys: false
  }
  await fs.writeFile(defaultsFile, YAML.stringify(defaults, YAMLOptions), { encoding: 'utf8' })

  // Return the path to the defaults file
  return defaultsFile
}
