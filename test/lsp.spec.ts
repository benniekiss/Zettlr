import assert from 'assert'
import { EditorView } from '@codemirror/view'
import { linter, forceLinting, diagnosticCount } from '@codemirror/lint'
import { languageServers } from '../source/common/modules/markdown-editor/plugins/lsp'
import { LSPMessageReader, frameLSPMessage } from '../source/common/lsp/framing'
import { parseLanguageServers } from '../source/common/lsp/config'
import { MultiServerTransport } from '../source/common/lsp/transport'
import { LSPClient } from '@codemirror/lsp-client'
import type { Transport } from '@codemirror/lsp-client'

class MockTransport implements Transport {
  sent: any[] = []
  handlers = new Set<(message: string) => void>()
  send (message: string): void { this.sent.push(JSON.parse(message)) }
  subscribe (handler: (message: string) => void): void { this.handlers.add(handler) }
  unsubscribe (handler: (message: string) => void): void { this.handlers.delete(handler) }
  receive (message: any): void {
    for (const handler of this.handlers) handler(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }
}

describe('LSP stdio framing', () => {
  it('decodes arbitrary byte splits, UTF-8, and coalesced messages', () => {
    const messages = [JSON.stringify({ text: 'é🦀' }), JSON.stringify({ text: 'second' })]
    const bytes = Buffer.from(messages.map(frameLSPMessage).join(''))
    const received: string[] = []
    const reader = new LSPMessageReader(message => received.push(message))
    for (const byte of bytes) reader.push(Buffer.from([byte]))
    assert.deepStrictEqual(received, messages)
  })

  it('rejects missing lengths and oversized messages', () => {
    assert.throws(() => new LSPMessageReader(() => {}).push(Buffer.from('Invalid: header\r\n\r\n')), /Content-Length/)
    assert.throws(() => new LSPMessageReader(() => {}).push(Buffer.from('Content-Length: 999999999\r\n\r\n')), /too large/)
  })
})

describe('Language server configuration', () => {
  it('accepts multiple custom servers and settings', () => {
    assert.strictEqual(parseLanguageServers(JSON.stringify([
      { name: 'grammar', command: '/path with spaces/ltex', languages: ['markdown'], settings: { ltex: { language: 'en-US' } } },
      { name: 'markdown', command: 'panache', args: ['lsp'], languages: ['markdown'], enabled: false }
    ])).length, 2)
  })

  it('rejects malformed or ambiguous definitions', () => {
    const valid = { name: 'server', command: 'server', languages: ['markdown'] }
    for (const value of [ {}, [null], [{ ...valid, languages: [] }], [{ ...valid, args: 'shell arguments' }], [{ ...valid, env: { VAR: 5 } }], [valid, valid] ]) {
      assert.throws(() => parseLanguageServers(JSON.stringify(value)))
    }
  })
})

describe('Multiple language servers', () => {
  let first: MockTransport
  let second: MockTransport
  let transport: MultiServerTransport
  let received: any[]

  beforeEach(() => {
    first = new MockTransport()
    second = new MockTransport()
    transport = new MultiServerTransport([first, second])
    received = []
    transport.subscribe(message => received.push(JSON.parse(message)))
  })
  afterEach(() => transport.destroy())

  function initialize (): void {
    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }))
    first.receive({ id: first.sent[0].id, result: { capabilities: { hoverProvider: true, textDocumentSync: 2 } } })
    second.receive({ id: second.sent[0].id, result: { capabilities: { documentFormattingProvider: true, textDocumentSync: 1 } } })
  }

  it('merges capabilities, routes requests, and fans out document notifications', () => {
    initialize()
    assert.strictEqual(received[0].id, 10)
    assert.strictEqual(received[0].result.capabilities.textDocumentSync.change, 1)
    assert.strictEqual(received[0].result.capabilities.hoverProvider, true)
    transport.send(JSON.stringify({ id: 11, method: 'textDocument/formatting', params: {} }))
    assert.strictEqual(first.sent.length, 1)
    assert.strictEqual(second.sent[1].method, 'textDocument/formatting')
    second.receive({ id: second.sent[1].id, result: [] })
    assert.strictEqual(received[1].id, 11)
    transport.send(JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///test.md', version: 0 } } }))
    assert.strictEqual(first.sent[1].method, 'textDocument/didOpen')
    assert.strictEqual(second.sent[2].method, 'textDocument/didOpen')
  })

  it('keeps provider options in configuration order when servers initialize out of order', () => {
    transport.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
    second.receive({ id: second.sent[0].id, result: { capabilities: { completionProvider: { triggerCharacters: ['b'] } } } })
    first.receive({ id: first.sent[0].id, result: { capabilities: { completionProvider: { triggerCharacters: ['a'] } } } })
    assert.deepStrictEqual(received[0].result.capabilities.completionProvider.triggerCharacters, ['a'])
    transport.send(JSON.stringify({ id: 2, method: 'textDocument/completion', params: {} }))
    assert.strictEqual(first.sent.at(-1).method, 'textDocument/completion')
    first.receive({ id: first.sent.at(-1).id, result: [] })
  })

  it('combines diagnostics, removes disconnected contributions, and rejects stale versions', () => {
    const uri = 'file:///test.md'
    transport.send(JSON.stringify({ method: 'textDocument/didOpen', params: { textDocument: { uri, version: 0 } } }))
    first.receive({ method: 'textDocument/publishDiagnostics', params: { uri, version: 0, diagnostics: [{ message: 'grammar' }] } })
    second.receive({ method: 'textDocument/publishDiagnostics', params: { uri, version: 0, diagnostics: [{ message: 'spelling' }] } })
    assert.deepStrictEqual(received.at(-1).params.diagnostics.map((d: any) => d.message), ['grammar', 'spelling'])
    transport.closePeer(first)
    assert.deepStrictEqual(received.at(-1).params.diagnostics, [{ message: 'spelling' }])
    transport.send(JSON.stringify({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 1 }, contentChanges: [{ text: 'new' }] } }))
    const count = received.length
    second.receive({ method: 'textDocument/publishDiagnostics', params: { uri, version: 0, diagnostics: [{ message: 'stale' }] } })
    assert.strictEqual(received.length, count)
    second.receive({ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [] } })
    assert.deepStrictEqual(received.at(-1).params.diagnostics, [])
  })

  it('keeps a healthy server when another fails initialization', () => {
    transport.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
    transport.closePeer(first)
    second.receive({ id: second.sent[0].id, result: { capabilities: { hoverProvider: true } } })
    assert.strictEqual(received[0].result.capabilities.hoverProvider, true)
    assert.strictEqual(first.handlers.size, 0)
  })

  it('routes server responses back without collisions', () => {
    first.receive({ id: 1, method: 'unsupported' })
    second.receive({ id: 1, method: 'unsupported' })
    assert.notStrictEqual(received[0].id, received[1].id)
    transport.send(JSON.stringify({ id: received[1].id, error: { code: -32601, message: 'Unsupported' } }))
    assert.strictEqual(first.sent.length, 0)
    assert.strictEqual(second.sent[0].id, 1)
  })

  it('initializes the real CodeMirror client through the combined transport', async () => {
    const client = new LSPClient().connect(transport)
    first.receive({ id: first.sent[0].id, result: { capabilities: { textDocumentSync: 2 } } })
    second.receive({ id: second.sent[0].id, result: { capabilities: { hoverProvider: true } } })
    await client.initializing
    assert.strictEqual(client.serverCapabilities?.hoverProvider, true)
    assert.strictEqual(first.sent.at(-1).method, 'initialized')
    assert.strictEqual(second.sent.at(-1).method, 'initialized')
    client.disconnect()
  })
})

describe('Editor LSP lifecycle', () => {
  it('synchronizes documents, preserves other lint sources, reconfigures, and cleans up', async () => {
    window.requestAnimationFrame = global.requestAnimationFrame
    window.cancelAnimationFrame = global.cancelAnimationFrame
    const previousIPC = window.ipc
    const listeners = new Map<string, Set<(...args: any[]) => void>>()
    const calls: any[] = []
    let sessionID = 0
    const emit = (channel: string, payload: any): void => {
      for (const listener of listeners.get(channel) ?? []) listener(undefined, payload)
    }
    window.config.set('languageServers', JSON.stringify([{ name: 'test', command: 'test', languages: ['markdown'] }]))
    window.ipc = {
      ...previousIPC,
      on (channel: string, listener: (...args: any[]) => void) {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
        return () => { listeners.get(channel)!.delete(listener) }
      },
      async invoke (_channel: string, payload: any) {
        calls.push(payload)
        if (payload.command === 'start') return { id: String(++sessionID), uri: 'file:///test.md', rootUri: 'file:///' }
        if (payload.command === 'send') {
          const message = JSON.parse(payload.message)
          if (message.method === 'initialize') queueMicrotask(() => emit('lsp-message', {
            id: payload.id,
            message: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } })
          }))
        }
      }
    } as typeof window.ipc
    const view = new EditorView({ doc: 'hello', extensions: [
      languageServers('/test.md', 'markdown'),
      linter(() => [{ from: 0, to: 1, severity: 'warning', message: 'Existing linter' }], { delay: 0 })
    ] })
    const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 30)) }
    try {
      await settle()
      const sent = (): any[] => calls.filter(call => call.command === 'send').map(call => JSON.parse(call.message))
      assert.strictEqual(sent().find(message => message.method === 'textDocument/didOpen').params.textDocument.languageId, 'markdown')
      const doc = sent().find(message => message.method === 'textDocument/didOpen').params.textDocument
      emit('lsp-message', { id: '1', message: JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
        uri: doc.uri, version: doc.version, diagnostics: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, severity: 2, message: 'Server warning' }]
      } }) })
      forceLinting(view)
      await settle()
      assert.strictEqual(diagnosticCount(view.state), 2)
      view.dispatch({ changes: { from: 5, insert: '!' } })
      await new Promise(resolve => setTimeout(resolve, 600))
      assert.strictEqual(sent().find(message => message.method === 'textDocument/didChange').params.contentChanges[0].text, 'hello!')
      window.config.set('languageServers', '[]')
      emit('config-provider', { command: 'update' })
      await settle()
      assert(calls.some(call => call.command === 'stop' && call.id === '1'))
      forceLinting(view)
      await settle()
      assert.strictEqual(diagnosticCount(view.state), 1)
    } finally {
      view.destroy()
      window.config.set('languageServers', '[]')
      window.ipc = previousIPC
    }
    assert.strictEqual(listeners.get('lsp-message')!.size, 0)
    assert.strictEqual(listeners.get('config-provider')!.size, 0)
  })
})
