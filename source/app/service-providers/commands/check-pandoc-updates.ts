import { app } from 'electron'
import path from 'path'
import type { AppServiceContainer } from 'source/app/app-service-container'
import { DEFAULT_PANDOC_WASM_URL } from '@common/pandoc-util/pandoc-wasm-url'
import { checkPandocWasmUpdates } from '../../util/download-pandoc-wasm'
import ZettlrCommand from './zettlr-command'

export default class CheckPandocUpdates extends ZettlrCommand {
  constructor (services: AppServiceContainer) {
    super(services, 'check-pandoc-updates')
  }

  async run (): Promise<{ status?: string, error?: string }> {
    const config = this._app.config.get().export
    const url = config.pandocWasmUrl.trim()
    try {
      const status = await checkPandocWasmUpdates(
        url || DEFAULT_PANDOC_WASM_URL,
        path.join(app.getPath('userData'), 'pandoc-wasm'),
        undefined,
        url === '' ? undefined : config.pandocWasmSha256
      )
      return { status }
    } catch (error) {
      this._app.log.error('Could not check for Pandoc WASM updates.', error)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
