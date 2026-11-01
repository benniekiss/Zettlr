import { Compartment, StateEffect, StateField, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ViewPlugin } from '@codemirror/view'
import { LSPClient, LSPPlugin, languageServerExtensions, type Transport } from '@codemirror/lsp-client'
import { linter, forceLinting, type Diagnostic } from '@codemirror/lint'
import DOMPurify from 'dompurify'
import { parseLanguageServers } from '@common/lsp/config'
import { MultiServerTransport } from '@common/lsp/transport'

const diagnosticsEffect = StateEffect.define<Diagnostic[]>()
const diagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update (diagnostics, transaction) {
    if (transaction.docChanged) {
      diagnostics = diagnostics.map(diagnostic => ({
        ...diagnostic,
        from: transaction.changes.mapPos(diagnostic.from, 1),
        to: transaction.changes.mapPos(diagnostic.to, -1)
      })).filter(diagnostic => diagnostic.from <= diagnostic.to)
    }
    for (const effect of transaction.effects) {
      if (effect.is(diagnosticsEffect)) {
        diagnostics = effect.value
      }
    }
    return diagnostics
  }
})

/** Sessions belong to a view and are released on reconfiguration or destruction. */
export function languageServers (path: string, language: string): Extension {
  const compartment = new Compartment()
  return [ diagnosticsField, linter(view => view.state.field(diagnosticsField), {
    needsRefresh: update => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(diagnosticsEffect)))
  }), compartment.of([]), ViewPlugin.fromClass(class {
    private generation = 0
    private client: LSPClient|undefined
    private transport: MultiServerTransport|undefined
    private readonly sessions = new Set<string>()
    private readonly receivers = new Map<string, { receive: Set<(message: string) => void>, transport: Transport }>()
    private readonly stopMessages: () => void
    private readonly stopConfig: () => void
    private config = ''
    private destroyed = false

    constructor (private readonly view: EditorView) {
      this.stopMessages = window.ipc.on('lsp-message', (_event, payload) => {
        const receiver = this.receivers.get(payload.id)
        if (receiver === undefined) {
          return
        }
        if (payload.closed === true) {
          this.transport?.closePeer(receiver.transport)
          this.receivers.delete(payload.id)
          this.sessions.delete(payload.id)
          console.warn('[LSP] Language server disconnected')
        } else {
          for (const receive of receiver.receive) {
            receive(payload.message)
          }
        }
      })
      this.stopConfig = window.ipc.on('config-provider', () => this.configure())
      this.configure()
    }

    private release (): void {
      this.client?.disconnect()
      this.transport?.destroy()
      this.client = undefined
      this.transport = undefined
      for (const id of this.sessions) {
        this.stop(id)
      }
      this.sessions.clear()
      this.receivers.clear()
    }

    private stop (id: string): void {
      window.ipc.invoke('lsp-provider', { command: 'stop', id }).catch(err => console.error('[LSP]', err))
    }

    private configure (): void {
      const config: string = window.config.get('languageServers') ?? '[]'
      if (config === this.config || this.destroyed) {
        return
      }
      this.config = config
      const generation = ++this.generation
      // Defer dispatch until CodeMirror has finished constructing/updating plugins.
      queueMicrotask(() => {
        if (this.destroyed || generation !== this.generation) {
          return
        }
        this.release()
        this.view.dispatch({ effects: [ compartment.reconfigure([]), diagnosticsEffect.of([]) ] })
        forceLinting(this.view)
        this.connect(config, generation).catch(err => console.error('[LSP]', err))
      })
    }

    private async connect (config: string, generation: number): Promise<void> {
      const servers = parseLanguageServers(config).filter(server => server.enabled !== false && server.languages.includes(language))
      const transports: Transport[] = []
      let uri = ''
      let rootUri = ''
      // Sequential startup lets each successful server survive a failed sibling.
      for (const server of servers) {
        if (this.destroyed || generation !== this.generation) {
          return
        }
        try {
          const session = await window.ipc.invoke('lsp-provider', { command: 'start', name: server.name, path })
          if (this.destroyed || generation !== this.generation) {
            this.stop(session.id)
            return
          }
          uri = session.uri
          rootUri = session.rootUri
          const receive = new Set<(message: string) => void>()
          const transport: Transport = {
            send: message => {
              if (!this.sessions.has(session.id)) {
                throw new Error('Language server disconnected')
              }
              window.ipc.invoke('lsp-provider', { command: 'send', id: session.id, message }).catch(err => {
                console.error(`[LSP ${server.name}]`, err)
                this.transport?.closePeer(transport)
              })
            },
            subscribe: handler => { receive.add(handler) },
            unsubscribe: handler => { receive.delete(handler) }
          }
          this.sessions.add(session.id)
          this.receivers.set(session.id, { receive, transport })
          transports.push(transport)
        } catch (err) { console.error(`[LSP ${server.name}] Could not start server`, err) }
      }
      if (this.destroyed || generation !== this.generation || transports.length === 0) {
        return
      }
      const transport = this.transport = new MultiServerTransport(transports)
      const client = this.client = new LSPClient({
        rootUri,
        timeout: 30000,
        sanitizeHTML: html => DOMPurify.sanitize(html),
        extensions: [{ clientCapabilities: { workspace: { configuration: true } } }, ...languageServerExtensions() ],
        notificationHandlers: {
          'textDocument/publishDiagnostics': (client, params) => {
            const file = client.workspace.getFile(params.uri)
            const plugin = LSPPlugin.get(this.view)
            if (file === null || file === undefined || plugin === null || (params.version !== undefined && params.version !== null && params.version !== file.version)) {
              return true
            }
            const diagnostics: Diagnostic[] = params.diagnostics.map((item: any) => ({
              from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
              to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
              severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info',
              source: item.source,
              message: item.message
            }))
            this.view.dispatch({ effects: diagnosticsEffect.of(diagnostics) })
            forceLinting(this.view)
            return true
          }
        }
      }).connect(transport)
      try {
        await client.initializing
        if (this.destroyed || generation !== this.generation) {
          return
        }
        this.view.dispatch({ effects: compartment.reconfigure(client.plugin(uri, language)) })
      } catch (err) {
        if (generation === this.generation) {
          this.release()
        }
        throw err
      }
    }

    destroy (): void {
      this.destroyed = true
      this.generation++
      this.stopConfig()
      this.stopMessages()
      this.release()
    }
  }) ]
}
