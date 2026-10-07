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
import { configurePandocWasm, getPandocVersion } from './util/run-pandoc'
import { downloadPandocWasm } from './util/download-pandoc-wasm'
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
    return await downloadPandocWasm(
      appServiceContainer.config.get().export.pandocWasmUrl,
      path.join(app.getPath('userData'), 'pandoc-wasm')
    )
  })

  try {
    process.env.PANDOC_VERSION = await getPandocVersion()
  } catch (err) {
    log.error('Could not initialize Pandoc WASM.', err)
  }

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
