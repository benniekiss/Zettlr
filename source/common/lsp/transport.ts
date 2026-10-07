import type { Transport } from '@codemirror/lsp-client'

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
}

const providers: Record<string, string> = {
  'textDocument/completion': 'completionProvider',
  'completionItem/resolve': 'completionProvider',
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
  private readonly pending = new Map<number, { peer: Peer, clientID: number|string|undefined, respond: (message: Message) => void, timer: ReturnType<typeof setTimeout> }>()
  private readonly serverRequests = new Map<string, { peer: Peer, id: number|string }>()

  constructor (transports: Transport[]) {
    for (const transport of transports) {
      const peer: Peer = { transport, capabilities: {}, diagnostics: new Map(), active: true, listener: message => this.receive(peer, JSON.parse(message)) }
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

  private request (peer: Peer, message: Message, respond: (message: Message) => void): void {
    const id = this.nextID++
    const timer = setTimeout(() => {
      this.pending.delete(id)
      respond({ jsonrpc: '2.0', error: { code: -32000, message: 'Language server request timed out' } })
    }, 20000)
    this.pending.set(id, { peer, clientID: message.id, respond, timer })
    try { peer.transport.send(JSON.stringify({ ...message, id })) } catch (err) {
      this.closePeer(peer.transport) 
    }
  }

  send (json: string): void {
    const message: Message = JSON.parse(json)
    if (message.method === undefined) {
      const request = this.serverRequests.get(String(message.id))
      if (request !== undefined) {
        this.serverRequests.delete(String(message.id))
        request.peer.transport.send(JSON.stringify({ ...message, id: request.id }))
      }
    } else if (message.id === undefined) {
      if (message.method === '$/cancelRequest') {
        for (const [ id, pending ] of this.pending) {
          if (pending.clientID === message.params.id) {pending.peer.transport.send(JSON.stringify({ ...message, params: { id } }))}
        }
        return
      }
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
        try { peer.transport.send(json) } catch (err) {
          this.closePeer(peer.transport) 
        }
      }
    } else if (message.method === 'initialize') {
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
        this.request(peer, message, response => {
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
      const provider = providers[message.method]
      const peer = this.peers.find(peer => peer.active && (provider === undefined || peer.capabilities[provider] !== undefined && peer.capabilities[provider] !== null && peer.capabilities[provider] !== false))
      if (peer === undefined) {
        this.emit({ jsonrpc: '2.0', id: message.id, result: null })
      } else {
        this.request(peer, message, response => this.emit({ ...response, id: message.id }))
      }
    }
  }

  private receive (peer: Peer, message: Message): void {
    if (!peer.active) {
      return
    }
    if (message.method === 'textDocument/publishDiagnostics') {
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
      const pending = this.pending.get(Number(message.id))
      if (pending === undefined || pending.peer !== peer) {
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(Number(message.id))
      pending.respond(message)
    } else {
      this.emit(message)
    }
  }

  private publishDiagnostics (uri: string, version?: number): void {
    const diagnostics = this.peers.flatMap(peer => peer.active ? peer.diagnostics.get(uri) ?? [] : [])
    this.emit({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: version ?? this.versions.get(uri), diagnostics } })
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
    for (const [ id, pending ] of this.pending) {
      if (pending.peer !== peer) {
        continue
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.respond({ jsonrpc: '2.0', error: { code: -32000, message: 'Language server disconnected' } })
    }
    for (const uri of new Set([ ...this.versions.keys(), ...peer.diagnostics.keys() ])) {
      this.publishDiagnostics(uri)
    }
    peer.diagnostics.clear()
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
