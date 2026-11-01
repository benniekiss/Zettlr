import type { LSPClient, Transport } from '@codemirror/lsp-client'
import type { Diagnostic, CodeAction, Command, WorkspaceEdit } from 'vscode-languageserver-types'
import { matchesWatcher, type FileEvent, type FileSystemWatcher } from './file-watching'

interface Message {
  jsonrpc: string
  id?: number|string
  method?: string
  params?: any
  result?: any
  error?: { code: number, message: string }
}

interface Peer {
  transport: Transport
  capabilities: Record<string, any>
  diagnostics: Map<string, any[]>
  listener: (message: string) => void
  active: boolean
  languages?: readonly string[]
  documents: Set<string>
  watchers: Map<string, FileSystemWatcher[]>
  rootUri: string
}

const providers: Record<string, string> = {
  'textDocument/completion': 'completionProvider',
  'textDocument/hover': 'hoverProvider',
  'textDocument/signatureHelp': 'signatureHelpProvider',
  'textDocument/formatting': 'documentFormattingProvider',
  'textDocument/rename': 'renameProvider',
  'textDocument/prepareRename': 'renameProvider',
  'textDocument/definition': 'definitionProvider',
  'textDocument/declaration': 'declarationProvider',
  'textDocument/typeDefinition': 'typeDefinitionProvider',
  'textDocument/implementation': 'implementationProvider',
  'textDocument/references': 'referencesProvider'
}

/**
 * CodeMirror has one LSP plugin per view. Combine diagnostics from every server,
 * while routing interactive requests to the first server advertising support.
 */
export class MultiServerTransport implements Transport {
  private readonly peers: Peer[] = []
  private readonly handlers = new Set<(message: string) => void>()
  private nextID = 1
  private readonly versions = new Map<string, number>()
  private readonly initializations = new Map<number|string, { peer: Peer, respond: (message: Message) => void, timer: ReturnType<typeof setTimeout> }>()
  private readonly serverRequests = new Map<string, { peer: Peer, id: number|string }>()

  constructor (transports: Transport[], private readonly applyEdit?: (params: { edit: WorkspaceEdit }) => { applied: boolean, failureReason?: string }, private readonly onClose?: (transport: Transport) => void, languages?: readonly (readonly string[])[], roots?: readonly string[]) {
    for (const [ index, transport ] of transports.entries()) {
      const peer: Peer = { transport, capabilities: {}, diagnostics: new Map(), active: true, languages: languages?.[index], documents: new Set(), watchers: new Map(), rootUri: roots?.[index] ?? 'file:///', listener: message => this.receive(peer, JSON.parse(message)) }
      this.peers.push(peer)
      transport.subscribe(peer.listener)
    }
  }

  subscribe (handler: (message: string) => void): void { this.handlers.add(handler) }
  unsubscribe (handler: (message: string) => void): void { this.handlers.delete(handler) }
  private emit (message: Message): void {
    for (const handler of this.handlers) {
      handler(JSON.stringify(message))
    }
  }

  private initializePeer (peer: Peer, message: Message, respond: (message: Message) => void): void {
    const id = `initialize-${this.nextID++}`
    const timer = setTimeout(() => {
      this.initializations.delete(id)
      respond({ jsonrpc: '2.0', error: { code: -32000, message: 'Language server request timed out' } })
    }, 20000)
    this.initializations.set(id, { peer, respond, timer })
    try { peer.transport.send(JSON.stringify({ ...message, id })) } catch (err) {
      this.closePeer(peer.transport) 
    }
  }

  supportsCodeActions (server: number): boolean {
    const peer = this.peers[server]
    return peer !== undefined && peer.active && peer.capabilities.codeActionProvider !== undefined && peer.capabilities.codeActionProvider !== null && peer.capabilities.codeActionProvider !== false
  }

  private requestServer<T> (client: LSPClient, server: number, method: string, params: unknown): Promise<T> {
    return client.request('zettlr/request', { server, method, params })
  }

  requestCodeActions (client: LSPClient, server: number, uri: string, diagnostic: Diagnostic): Promise<Array<CodeAction|Command>|null> {
    return this.requestServer(client, server, 'textDocument/codeAction', {
      textDocument: { uri }, range: diagnostic.range,
      context: { diagnostics: [diagnostic], triggerKind: 2 }
    })
  }

  resolveCodeAction (client: LSPClient, server: number, action: CodeAction): Promise<CodeAction> {
    if (this.peers[server]?.capabilities.codeActionProvider?.resolveProvider !== true) {return Promise.resolve(action)}
    return this.requestServer(client, server, 'codeAction/resolve', action)
  }

  executeCommand (client: LSPClient, server: number, command: Command): Promise<unknown> {
    return this.requestServer(client, server, 'workspace/executeCommand', { command: command.command, arguments: command.arguments })
  }

  send (json: string): void {
    let message: Message = JSON.parse(json)
    let target: Peer|undefined
    let targeted = false
    if (message.method === 'zettlr/request') {
      targeted = true
      target = this.peers[message.params.server]
      message = { ...message, method: message.params.method, params: message.params.params }
    }
    if (message.method === undefined) {
      const request = this.serverRequests.get(String(message.id))
      if (request !== undefined) {
        this.serverRequests.delete(String(message.id))
        request.peer.transport.send(JSON.stringify({ ...message, id: request.id }))
      }
    } else if (message.id === undefined) {
      if (message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') {
        const { uri, version } = message.params.textDocument
        this.versions.set(uri, version)
        // Old ranges from a slower server must not be relabeled with a newer version.
        if (message.method === 'textDocument/didChange') {
          for (const peer of this.peers) {
            peer.diagnostics.delete(uri)
          }
        }
      }
      if (message.method === 'textDocument/didClose') {
        this.versions.delete(message.params.textDocument.uri)
        for (const peer of this.peers) {
          peer.diagnostics.delete(message.params.textDocument.uri)
        }
      }
      for (const peer of this.peers.filter(peer => peer.active)) {
        if (message.method === 'workspace/didChangeWatchedFiles') {
          const watchers = [...peer.watchers.values()].flat()
          const changes = (message.params.changes as FileEvent[]).filter(event => watchers.some(watcher => matchesWatcher(event, watcher, peer.rootUri)))
          if (changes.length > 0) {
            try {peer.transport.send(JSON.stringify({ ...message, params: { changes } }))} catch {this.closePeer(peer.transport)}
          }
          continue
        }
        const uri = message.params?.textDocument?.uri
        if (message.method === 'textDocument/didOpen') {
          if (peer.languages !== undefined && !peer.languages.includes(message.params.textDocument.languageId)) {continue}
          peer.documents.add(uri)
        } else if (uri !== undefined && peer.languages !== undefined && !peer.documents.has(uri)) {continue}
        if (message.method === 'textDocument/didClose') {peer.documents.delete(uri)}
        let outgoing = json
        if (message.method === 'textDocument/didSave') {
          const save = peer.capabilities.textDocumentSync?.save
          if (save !== true && (typeof save !== 'object' || save === null)) {continue}
          outgoing = JSON.stringify({ ...message, params: { textDocument: message.params.textDocument, ...(save.includeText === true ? { text: message.params.text } : {}) } })
        }
        try { peer.transport.send(outgoing) } catch (err) {
          this.closePeer(peer.transport) 
        }
      }
    } else if (message.method === 'initialize') {
      // CodeMirror 6.3 advertises pull diagnostics but only handles push reports.
      // Avoid making custom servers select a protocol the client never requests.
      const textDocument = { ...message.params?.capabilities?.textDocument }
      delete textDocument.diagnostic
      message = { ...message, params: { ...message.params, capabilities: { ...message.params?.capabilities, textDocument } } }
      const peers = this.peers.filter(peer => peer.active)
      let remaining = peers.length
      const capabilities: Record<string, any> = { textDocumentSync: { openClose: true, change: 1 } }
      let successes = 0
      const done = (): void => {
        // Match capability options to the same configured server used for requests,
        // regardless of the order in which initialization responses arrive.
        for (const peer of peers.filter(peer => peer.active)) {
          for (const [ key, value ] of Object.entries(peer.capabilities)) {
            if (key !== 'textDocumentSync' && value !== false && value !== null && value !== undefined && capabilities[key] === undefined) {
              capabilities[key] = value
            }
          }
        }
        this.emit(successes > 0
          ? { jsonrpc: '2.0', id: message.id, result: { capabilities } }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'No language server initialized' } })
      }
      if (remaining === 0) {
        done()
      }
      for (const peer of peers) {
        this.initializePeer(peer, message, response => {
          if (response.error === undefined) {
            peer.capabilities = response.result?.capabilities ?? {}
            successes++
          } else {
            this.closePeer(peer.transport)
          }
          if (--remaining === 0) {
            done()
          }
        })
      }
    } else {
      const provider = providers[message.method!]
      const uri = message.params?.textDocument?.uri
      const peer = targeted ? target : this.peers.find(peer => peer.active &&
        (uri === undefined || peer.languages === undefined || peer.documents.has(uri)) &&
        (provider === undefined || peer.capabilities[provider] !== undefined && peer.capabilities[provider] !== null && peer.capabilities[provider] !== false))
      if (peer?.active !== true) {
        this.emit(targeted
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Language server disconnected' } }
          : { jsonrpc: '2.0', id: message.id, result: null })
      } else {
        // The native client owns request IDs, deadlines, and cancellation.
        try { peer.transport.send(JSON.stringify(message)) } catch {
          this.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Language server disconnected' } })
          this.closePeer(peer.transport)
        }
      }
    }
  }

  private receive (peer: Peer, message: Message): void {
    if (!peer.active) {
      return
    }
    if (message.method === 'client/registerCapability' && message.id !== undefined) {
      const registrations = message.params.registrations as Array<{ id: string, method: string, registerOptions: { watchers: FileSystemWatcher[] } }>
      if (registrations.some(registration => registration.method !== 'workspace/didChangeWatchedFiles')) {
        peer.transport.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Only file-watcher registration is supported' } }))
      } else {
        for (const registration of registrations) {peer.watchers.set(registration.id, registration.registerOptions.watchers)}
        peer.transport.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }))
      }
    } else if (message.method === 'client/unregisterCapability' && message.id !== undefined) {
      for (const registration of message.params.unregisterations as Array<{ id: string }>) {peer.watchers.delete(registration.id)}
      peer.transport.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }))
    } else if (message.method === 'workspace/applyEdit' && message.id !== undefined && this.applyEdit !== undefined) {
      let result: { applied: boolean, failureReason?: string }
      try { result = this.applyEdit(message.params) } catch (err) {
        result = { applied: false, failureReason: err instanceof Error ? err.message : String(err) }
      }
      peer.transport.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } else if (message.method === 'textDocument/publishDiagnostics') {
      if (peer.languages !== undefined && !peer.documents.has(message.params.uri)) {return}
      const version = this.versions.get(message.params.uri)
      if (message.params.version !== undefined && message.params.version !== null && version !== undefined && message.params.version !== version) {
        return
      }
      peer.diagnostics.set(message.params.uri, message.params.diagnostics)
      this.publishDiagnostics(message.params.uri, message.params.version)
    } else if (message.method !== undefined && message.id !== undefined) {
      const id = `server-${this.nextID++}`
      this.serverRequests.set(id, { peer, id: message.id })
      this.emit({ ...message, id })
    } else if (message.id !== undefined) {
      const pending = this.initializations.get(message.id)
      if (pending !== undefined) {
        if (pending.peer !== peer) {return}
        clearTimeout(pending.timer)
        this.initializations.delete(message.id)
        pending.respond(message)
      } else if (typeof message.id === 'number') {
        this.emit(message)
      }
    } else {
      this.emit(message)
    }
  }

  private publishDiagnostics (uri: string, version?: number): void {
    const diagnostics: Diagnostic[] = []
    const zettlrServers: number[] = []
    this.peers.forEach((peer, server) => {
      for (const diagnostic of peer.active ? peer.diagnostics.get(uri) ?? [] : []) {
        diagnostics.push(diagnostic)
        zettlrServers.push(server)
      }
    })
    this.emit({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: version ?? this.versions.get(uri), diagnostics, zettlrServers } })
  }

  closePeer (transport: Transport): void {
    const peer = this.peers.find(peer => peer.transport === transport)
    if (peer === undefined || !peer.active) {
      return
    }
    peer.active = false
    for (const [ id, request ] of this.serverRequests) {
      if (request.peer === peer) {this.serverRequests.delete(id)}
    }
    peer.transport.unsubscribe(peer.listener)
    for (const [ id, pending ] of this.initializations) {
      if (pending.peer !== peer) {
        continue
      }
      clearTimeout(pending.timer)
      this.initializations.delete(id)
      pending.respond({ jsonrpc: '2.0', error: { code: -32000, message: 'Language server disconnected' } })
    }
    for (const uri of new Set([ ...this.versions.keys(), ...peer.diagnostics.keys() ])) {
      this.publishDiagnostics(uri)
    }
    peer.diagnostics.clear()
    peer.watchers.clear()
    this.onClose?.(transport)
  }

  destroy (): void {
    for (const peer of this.peers) {
      this.closePeer(peer.transport)
    }
    this.handlers.clear()
    this.serverRequests.clear()
    this.versions.clear()
  }
}
