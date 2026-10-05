/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CSSProvider
 * CVM-Role:        Service Provider
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Makes the custom CSS available throughout the app.
 *
 * END HEADER
 */

import path from 'path'
import { promises as fs } from 'fs'
import { app, ipcMain } from 'electron'
import EventEmitter from 'events'

import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import ProviderContract, { type IPCAPI } from '../provider-contract'
import type LogProvider from '@providers/log'

export type CssProviderIPCAPI = IPCAPI<{
  'get-custom-css-path': { dir?: string },
  'get-custom-css': { dir?: string },
  'set-custom-css': { css: string, dir?: string }
}>

export default class CssProvider extends ProviderContract {
  private readonly _filePath: string
  private readonly _workspaceCssPath: string
  private readonly _emitter: EventEmitter

  constructor (private readonly _logger: LogProvider) {
    super()
    this._filePath = path.join(app.getPath('userData'), 'custom.css')
    this._workspaceCssPath = path.join('.zettlr', 'custom.css')

    this._emitter = new EventEmitter()

    // Send the Custom CSS Path to whomever requires it
    ipcMain.handle('css-provider', async (event, message: CssProviderIPCAPI) => {
      const { command, payload } = message
      if (command === 'get-custom-css-path') {
        return await this.getPath(payload?.dir)
      } else if (command === 'get-custom-css') {
        return await this.get(payload?.dir)
      } else if (command === 'set-custom-css') {
        return await this.set(payload.css, payload.dir)
      }
    })
  }

  async boot (): Promise<void> {
    this._logger.verbose('CSS provider booting up ...')

    // Check for the existence of the custom CSS file. If it is not existent,
    // create an empty one.
    try {
      await fs.lstat(this._filePath)
    } catch (err: any) {
      // Create an empty file with a nice initial comment in it.
      await fs.writeFile(this._filePath, '/* Enter your custom CSS here */\n\n', { encoding: 'utf8' })
    }
  }

  /**
   * Shuts down the provider
   * @return {boolean} Whether or not the shutdown was successful
   */
  async shutdown (): Promise<void> {
    this._logger.verbose('CSS provider shutting down ...')
  }

  /**
   * Retrieves the content of the custom CSS file
   * @return {string} The custom CSS
   */
  async get (dir?: string): Promise<string> {
    const cssPath = dir !== undefined ? path.join(dir, this._workspaceCssPath) : this._filePath

    try {
      const file = await fs.readFile(cssPath, { encoding: 'utf8' })
      return file
    } catch (err: any) {
      if (dir === undefined) {
        this._logger.error(`[CSS Provider] Could not get custom CSS file: ${String(err.message)}`, err)
      } else {
        this._logger.warning(`[CSS Provider] Could not get custom CSS file for workspace: ${dir}`)
      }
      return ''
    }
  }

  /**
   * The renderer will need this path to dynamically load it in.
   * @return {string} The fully qualified path to the CSS file.
   */
  async getPath (dir?: string): Promise<string> {
    const cssPath = dir !== undefined ? path.join(dir, this._workspaceCssPath) : this._filePath

    try {
      await fs.lstat(cssPath)
      return cssPath
    } catch (err: any) {
      if (dir === undefined) {
        this._logger.error(`[CSS Provider] Could not find custom CSS file path: ${String(err.message)}`, err)
      } else {
        this._logger.warning(`[CSS Provider] Could not find custom CSS file path for workspace: ${dir}`)
      }
      return ''
    }
  }

  /**
   * Writes new data to the custom CSS file, and returns if the call succeeded.
   * @param {string} newContent The new contents
   * @return {boolean} Whether or not the call succeeded.
   */
  async set (newContent: string, dir?: string): Promise<boolean> {
    const cssPath = dir !== undefined ? path.join(dir, this._workspaceCssPath) : this._filePath

    try {
      await fs.writeFile(cssPath, newContent, { encoding: 'utf8' })
      this._emitter.emit('update', cssPath)
      broadcastIpcMessage('css-provider', {
        command: 'set-custom-css',
        payload: { path: cssPath, workspace: dir !== undefined ? path.basename(dir) : undefined }
      })
      broadcastIpcMessage('css-provider', { command: 'custom-css-updated' })
      return true
    } catch (err: any) {
      this._logger.error(`[CSS Provider] Could not set custom css: ${err.message as string}`, err)
      return false
    }
  }
}
