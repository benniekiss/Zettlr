/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        IPC API
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file specifies the API to communicate with the central
 *                  document authority via an IPC bridge (used for Electron).
 *
 * END HEADER
 */

import { DP_EVENTS, type DocumentType } from '@dts/common/documents'
import { type Update } from '@codemirror/collab'
import { type DocumentAuthorityAPI } from '..'
import type { DocumentAuthorityIPCAPI } from 'source/app/service-providers/documents'

async function pullUpdates (filePath: string, version: number, signal?: AbortSignal): Promise<false|Update[]> {
  // Requests new updates from the authority. It may be that the returned
  // promise pends for minutes or even hours -- until new changes are available.
  // Notice how we're not returning the promise from the IPC channel. The reason
  // is mainly to prevent pollution -- I don't want to try out what happens if
  // a dozen IPC calls are hanging in the air with no resolution in sight.
  return await new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve([])
      return
    }
    let pending = false
    let settled = false
    const cleanup = (): void => {
      settled = true
      stopListening()
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      resolve([])
    }
    // Begin listening for the correct event
    const stopListening = window.ipc.on('documents-update', (evt, payload) => {
      const { event, context } = payload
      if (pending || settled || event !== DP_EVENTS.CHANGE_FILE_STATUS || context.filePath !== filePath) {
        return
      }

      pending = true
      window.ipc.invoke('documents-authority', {
        command: 'pull-updates',
        payload: { filePath, version }
      } as DocumentAuthorityIPCAPI)
        .then((result: false|Update[]) => {
          // Clean up to not pollute the event listener with millions of callbacks
          cleanup()
          resolve(result)
        })
        .catch(err => {
          cleanup()
          reject(err)
        })
    })
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function pushUpdates (filePath: string, version: number, updates: any): Promise<boolean> {
  // Submits new updates to the authority, returns true if successful
  return await window.ipc.invoke('documents-authority', {
    command: 'push-updates',
    payload: { filePath, version, updates }
  } as DocumentAuthorityIPCAPI)
}

async function fetchDoc (filePath: string): Promise<{ content: string, type: DocumentType, startVersion: number }> {
  // Fetches a fresh document
  return await window.ipc.invoke('documents-authority', {
    command: 'get-document',
    payload: { filePath }
  } as DocumentAuthorityIPCAPI)
}

/**
 * This API can be passed in to an instance of MainEditor to allow it to
 * communicate with the central document authority via an IPC bridge.
 *
 * @var {DocumentAuthorityAPI}
 */
export const documentAuthorityIPCAPI: DocumentAuthorityAPI = {
  fetchDoc,
  pushUpdates,
  pullUpdates
}
