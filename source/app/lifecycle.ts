/**
 * @ignore
 * BEGIN HEADER
 *
 * CVM-Role:        <none>
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains lifecycle functions for boot and shutdown
 *                  that boot up things like the service providers, and shut
 *                  them down appropriately.
 *
 * END HEADER
 */

// Helper/Utility functions
import registerCustomProtocols from './util/custom-protocols'
import environmentCheck from './util/environment-check'
import resolveTimespanMs from './util/resolve-timespan-ms'
import { configurePandocWasm } from './util/run-pandoc'
import { downloadPandocWasm, invalidatePandocWasm } from './util/download-pandoc-wasm'
import { DEFAULT_PANDOC_WASM_URL, DEFAULT_PANDOC_WASM_SHA256 } from '@common/pandoc-util/pandoc-wasm-url'
import { warmTypstFontCache } from './util/compile-typst'
import path from 'path'

// Developer tools
import installExtension, { VUEJS_DEVTOOLS } from 'electron-devtools-installer'
import { AppServiceContainer, getAppServiceContainer, setAppServiceContainer } from './app-service-container'
import { app } from 'electron'
import { attachAppNavigationHandlers } from './util/attach-app-navigation-handlers'

// Statistics: Record the uptime of the application
let upTimestamp: number

/**
 * Boots the application
 *
 * @return  {void}    Nothing to return
 */
export async function bootApplication (): Promise<AppServiceContainer> {
  upTimestamp = Date.now()

  // First of all we MUST perform the environment check, since everything else
  // depends on this.
  await environmentCheck()

  // We need to instantiate the service container right away to have access to
  // the log and config providers. Then we just need to remember to boot it
  // before we access anything important.
  const appServiceContainer = new AppServiceContainer()
  const log = appServiceContainer.log

  log.info(`こんにちは！ Booting Zettlr at ${(new Date()).toString()}.`)

  // Before we begin, let's load the Vue.js DevTools for debugging
  if (!app.isPackaged) {
    try {
      // Load Vue developer extension
      log.info('Installing developer extensions ...')
      const extension = await installExtension(VUEJS_DEVTOOLS)
      log.info(`Added extension: ${extension.name} v${extension.version}`)
    } catch (err: unknown) {
      log.error(`Could not install extension: ${err instanceof Error ? err.message : 'unknown error'}`, err)
    }
  }

  registerCustomProtocols(log)

  // Prevent navigation away from our main windows and the creation of arbitrary
  // browser windows with external URLs
  attachAppNavigationHandlers(log)

  // Now boot up the service container
  await appServiceContainer.boot()

  // Now make the service container available for the rest of the main process.
  setAppServiceContainer(appServiceContainer)

  configurePandocWasm(async () => {
    const exportConfig = appServiceContainer.config.get().export
    const configuredUrl = exportConfig.pandocWasmUrl.trim()
    const url = configuredUrl || DEFAULT_PANDOC_WASM_URL
    const hash = configuredUrl === '' ? '' : exportConfig.pandocWasmSha256.trim().toLowerCase()
    return await downloadPandocWasm(
      url,
      path.join(app.getPath('userData'), 'pandoc-wasm'),
      undefined,
      configuredUrl === '' ? undefined : exportConfig.pandocWasmSha256,
      undefined,
      url !== '' && url === DEFAULT_PANDOC_WASM_URL && (hash === '' || hash === DEFAULT_PANDOC_WASM_SHA256)
        ? path.join(__dirname, 'assets/pandoc.wasm') : undefined
    )
  }, invalidatePandocWasm)

  // Prepare fonts without delaying window creation or requiring an export.
  void warmTypstFontCache(appServiceContainer.config.get().export.typstFontPath).catch(error => {
    log.warning('Could not prepare Typst fonts at startup; they will be loaded on export.', error)
  })

  return appServiceContainer
}

/**
 * Shuts the application down and performs cleanup operations
 *
 * @return  {Promise<void>}  Resolves always
 */
export async function shutdownApplication (): Promise<void> {
  const appServiceContainer = getAppServiceContainer()
  const log = appServiceContainer.log
  log.info(`さようなら！ Shutting down at ${(new Date()).toString()}`)

  const downTimestamp = Date.now()

  // Get a nice resolved timespan with right properties
  const span = resolveTimespanMs(downTimestamp - upTimestamp)

  // Now construct the message. Always include minutes, seconds, and milliseconds
  let uptimeMessage: string = `${span.minutes} minutes, and ${span.seconds}.${span.ms} seconds`
  if (span.hours > 0) {
    uptimeMessage = `${span.hours} hours, ${uptimeMessage}`
  }
  if (span.days > 0) {
    uptimeMessage = `${span.days} days, ${uptimeMessage}`
  }
  if (span.weeks > 0) {
    uptimeMessage = `${span.weeks} weeks, ${uptimeMessage}`
  }

  log.info(`Application uptime was: ${uptimeMessage}.`)

  if (span.days > 0 || span.weeks > 0) {
    log.warning('Zettlr has run for more than one day. Please make sure to regularly reboot your computer.')
  }

  await appServiceContainer.shutdown()
}
