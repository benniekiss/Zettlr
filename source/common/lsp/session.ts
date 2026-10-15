import {
  LSPClient, LSPPlugin, serverCompletion, hoverTooltips, signatureHelp, serverDiagnostics,
  closeReferencePanel, type Transport
} from '@codemirror/lsp-client'
import { keymap, type EditorView, type ViewUpdate } from '@codemirror/view'
import DOMPurify from 'dompurify'
import { parseLanguageServers, type LanguageServerConfig } from './config'
import { MultiServerTransport } from './transport'
import { applyWorkspaceEdit } from './code-actions'
import { EditorDiagnostics, type ServerDiagnostics } from './diagnostics'
import { EditorWorkspace, authorityChanged } from './workspace'
import { DP_EVENTS } from '@dts/common/documents'

// Renderer-local: IPC ownership remains isolated between application windows.
const sessions = new Map<string, EditorSession>()

interface Consumer { uri: string, path: string, leases: Set<symbol>, diagnostics?: EditorDiagnostics }

export class EditorSession {
  private readonly ipc = window.ipc
  readonly ready: Promise<void>
  client!: LSPClient
  private transport?: MultiServerTransport
  private readonly consumers = new Map<EditorView, Consumer>()
  private readonly receivers = new Map<string, { transport: Transport, listeners: Set<(message: string) => void> }>()
  private readonly diagnostics = new Map<string, ServerDiagnostics>()
  private readonly stopMessages: () => void
  private readonly stopSaves: () => void
  private readonly stopFiles: () => void
  private closed = false
  private idle?: ReturnType<typeof setTimeout>
  private syncTimer?: ReturnType<typeof setTimeout>

  constructor (private readonly key: string, servers: LanguageServerConfig[], path: string, rootUri: string) {
    this.stopMessages = this.ipc.on('lsp-message', (_event, payload) => {
      const receiver = this.receivers.get(payload.id)
      if (receiver === undefined) {return}
      if (payload.closed === true) {
        this.receivers.delete(payload.id)
        this.transport?.closePeer(receiver.transport)
      } else {
        for (const listener of receiver.listeners) {listener(payload.message)}
      }
    })
    this.stopSaves = this.ipc.on('documents-update', (_event, { event, context }) => {
      if (event !== DP_EVENTS.FILE_SAVED) {return}
      const consumer = [...this.consumers.values()].find(consumer => consumer.path === context?.filePath)
      if (consumer === undefined) {return}
      void this.ready.then(() => {
        if (this.closed || this.client.workspace.getFile(consumer.uri) === null) {return}
        this.client.sync()
        // A save may finish after newer edits. Sending its old text would roll
        // back servers (such as codebook) that update their buffer on didSave.
        if (context.savedContent !== this.client.workspace.getFile(consumer.uri)?.doc.toString()) {return}
        this.client.notification('textDocument/didSave', { textDocument: { uri: consumer.uri }, text: context.savedContent })
      }).catch(err => console.error('[LSP]', err))
    })
    this.stopFiles = this.ipc.on('fsal-watch-event', (_event, { event, uri }) => {
      const type = ({ add: 1, addDir: 1, change: 2, unlink: 3, unlinkDir: 3 } as Record<string, number>)[event]
      if (type === undefined) {return}
      void this.ready.then(() => {
        if (!this.closed) {this.client.notification('workspace/didChangeWatchedFiles', { changes: [{ uri, type }] })}
      }).catch(err => console.error('[LSP]', err))
    })
    this.ready = this.start(servers, path, rootUri).catch(err => { this.destroy(); throw err })
    // A view can disappear before initialization finishes.
    void this.ready.catch(() => {})
  }

  retain (view: EditorView, uri: string, path: string): () => void {
    clearTimeout(this.idle)
    const token = Symbol()
    let consumer = this.consumers.get(view)
    if (consumer === undefined) {
      consumer = { uri, path, leases: new Set() }
      this.consumers.set(view, consumer)
    }
    consumer.leases.add(token)
    return () => this.release(view, token)
  }

  attach (view: EditorView): void {
    const consumer = this.consumers.get(view)
    if (consumer === undefined || this.closed) {return}
    consumer.diagnostics = new EditorDiagnostics(view, this.client, this.transport!)
  }

  replay (view: EditorView): void {
    const consumer = this.consumers.get(view)
    const diagnostics = consumer && this.diagnostics.get(consumer.uri)
    if (diagnostics !== undefined) {consumer?.diagnostics?.publish(diagnostics)}
  }

  update (view: EditorView, update: ViewUpdate): void {
    if (update.docChanged) {
      this.consumers.get(view)?.diagnostics?.clear()
      queueMicrotask(() => {
        const consumer = this.consumers.get(view)
        const file = consumer && this.client?.workspace.getFile(consumer.uri)
        if (file !== undefined && file !== null && file.doc.eq(view.state.doc)) {
          LSPPlugin.get(view)?.clear()
          this.replay(view)
        }
      })
    }
    if (authorityChanged(update)) {
      clearTimeout(this.syncTimer)
      this.syncTimer = setTimeout(() => {
        if (!this.closed) {
          this.client?.sync()
          for (const view of this.consumers.keys()) {this.replay(view)}
        }
      }, 500)
    }
  }

  private release (view: EditorView, token: symbol): void {
    const consumer = this.consumers.get(view)
    if (this.closed || consumer === undefined || !consumer.leases.delete(token) || consumer.leases.size > 0) {return}
    consumer.diagnostics?.destroy()
    this.consumers.delete(view)
    if (this.consumers.size === 0) {
      // Let native plugin teardown send didClose before disconnecting.
      this.idle = setTimeout(() => { if (this.consumers.size === 0) {this.destroy()} }, 0)
    }
  }

  private stop (id: string): void {
    this.receivers.delete(id)
    void this.ipc.invoke('lsp-provider', { command: 'stop', id }).catch(err => console.error('[LSP]', err))
  }

  private async start (servers: LanguageServerConfig[], path: string, rootUri: string): Promise<void> {
    const transports: Transport[] = []
    const languages: string[][] = []
    const roots: string[] = []
    for (const server of servers) {
      if (this.closed) {throw new Error('Language server session released')}
      try {
        const session = await this.ipc.invoke('lsp-provider', { command: 'start', name: server.name, path })
        if (this.closed) { this.stop(session.id); throw new Error('Language server session released') }
        const listeners = new Set<(message: string) => void>()
        const transport: Transport = {
          send: message => {
            if (!this.receivers.has(session.id)) {throw new Error('Language server disconnected')}
            void this.ipc.invoke('lsp-provider', { command: 'send', id: session.id, message }).catch(err => {
              console.error(`[LSP ${server.name}]`, err)
              this.transport?.closePeer(transport)
            })
          },
          subscribe: listener => { listeners.add(listener) },
          unsubscribe: listener => { listeners.delete(listener) }
        }
        this.receivers.set(session.id, { transport, listeners })
        transports.push(transport)
        languages.push(server.languages)
        roots.push(session.rootUri)
      } catch (err) {
        if (this.closed) {throw err}
        console.error(`[LSP ${server.name}] Could not start server`, err)
      }
    }
    if (transports.length === 0) {throw new Error('No language server could be started')}
    this.transport = new MultiServerTransport(transports, params => {
      try { applyWorkspaceEdit(this.client, params.edit); return { applied: true } } catch (err) {
        return { applied: false, failureReason: err instanceof Error ? err.message : String(err) }
      }
    }, closed => {
      for (const [ id, receiver ] of this.receivers) {if (receiver.transport === closed) {this.stop(id)}}
      // The router must finish reporting failed initialization before teardown
      // removes the native response listener.
      if (this.receivers.size === 0) {queueMicrotask(() => this.destroy())}
    }, languages, roots)
    this.client = new LSPClient({
      rootUri, timeout: 30000,
      workspace: client => new EditorWorkspace(client, uri => { this.diagnostics.delete(uri) }),
      sanitizeHTML: html => DOMPurify.sanitize(html),
      extensions: [{
        clientCapabilities: {
          window: { workDoneProgress: false },
          workspace: { configuration: true, applyEdit: true, didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true } },
          textDocument: { synchronization: { didSave: true }, codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
            dataSupport: true, resolveSupport: { properties: [ 'edit', 'command' ] }, disabledSupport: true
          } }
        },
        notificationHandlers: { 'textDocument/publishDiagnostics': (_client, params: ServerDiagnostics) => {
          this.diagnostics.set(params.uri, params)
          for (const consumer of this.consumers.values()) {if (consumer.uri === params.uri) {consumer.diagnostics?.publish(params)}}
          return true
        } }
      }, serverCompletion(), hoverTooltips(),
      signatureHelp(), serverDiagnostics(),
      keymap.of([{ key: 'Escape', run: closeReferencePanel }]) ]
    }).connect(this.transport)
    await this.client.initializing
  }

  private destroy (): void {
    if (this.closed) {return}
    this.closed = true
    if (sessions.get(this.key) === this) {sessions.delete(this.key)}
    clearTimeout(this.idle)
    clearTimeout(this.syncTimer)
    for (const consumer of this.consumers.values()) {consumer.diagnostics?.destroy()}
    this.consumers.clear()
    this.transport?.destroy()
    // Closing peers rejects the native initialization request. Let its promise
    // settle before disconnect() replaces it, including interrupted startup.
    if (this.client !== undefined) {
      void this.client.initializing.then(() => this.client.disconnect(), () => this.client.disconnect())
    }
    for (const id of this.receivers.keys()) {this.stop(id)}
    this.stopMessages()
    this.stopSaves()
    this.stopFiles()
    this.diagnostics.clear()
  }
}

export interface SessionLease { session: EditorSession, uri: string, release: () => void }

export async function acquireSession (view: EditorView, path: string, language: string, config: string, bundled: boolean, current: () => boolean): Promise<SessionLease|undefined> {
  const servers = parseLanguageServers(config).filter(server => server.enabled !== false)
  if (!servers.some(server => server.languages.includes(language))) {return undefined}
  const { uri, rootUri } = await window.ipc.invoke('lsp-provider', { command: 'resolve', path })
  if (!current()) {return undefined}
  const key = JSON.stringify([ rootUri, config, bundled ])
  let session = sessions.get(key)
  if (session === undefined) {
    session = new EditorSession(key, servers, path, rootUri)
    sessions.set(key, session)
  }
  const release = session.retain(view, uri, path)
  return { session, uri, release }
}
