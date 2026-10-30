import { app } from 'electron'
import path from 'path'
import type { AppServiceContainer } from 'source/app/app-service-container'
import { resolvePandocModuleSource } from '@common/pandoc-util/pandoc-module-source'
import { updatePandocModule } from '../../util/download-pandoc-wasm'
import ZettlrCommand from './zettlr-command'

export default class CheckPandocUpdates extends ZettlrCommand {
  constructor (services: AppServiceContainer) {
    super(services, 'check-pandoc-updates')
  }

  async run (): Promise<{ status?: string, error?: string }> {
    try {
      const source = resolvePandocModuleSource(this._app.config.get().export)
      const status = await updatePandocModule(source, path.join(app.getPath('userData'), 'pandoc-wasm'))
      return { status }
    } catch (error) {
      this._app.log.error('Could not check for Pandoc WASM updates.', error)
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
