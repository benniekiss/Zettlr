import assert from 'assert'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { LSPClient, LSPPlugin, type Transport } from '@codemirror/lsp-client'
import { openLintPanel, setDiagnostics } from '@codemirror/lint'
import type { CodeAction, Diagnostic, WorkspaceEdit } from 'vscode-languageserver-types'
import { MultiServerTransport } from '../source/common/lsp/transport'
import { DiagnosticActions, applyWorkspaceEdit } from '../source/common/lsp/code-actions'

class Server implements Transport {
  handlers = new Set<(message: string) => void>()
  sent: any[] = []
  actions: CodeAction[] = []
  resolve: ((action: CodeAction) => CodeAction)|undefined
  send (raw: string): void {
    const message = JSON.parse(raw)
    this.sent.push(message)
    if (message.id === undefined || message.method === undefined) return
    queueMicrotask(() => {
      const result = message.method === 'initialize'
        ? { capabilities: { textDocumentSync: 1, codeActionProvider: { resolveProvider: true } } }
        : message.method === 'textDocument/codeAction' ? this.actions
          : message.method === 'codeAction/resolve' ? this.resolve?.(message.params) ?? message.params : null
      this.receive({ id: message.id, result })
    })
  }
  subscribe (handler: (message: string) => void): void { this.handlers.add(handler) }
  unsubscribe (handler: (message: string) => void): void { this.handlers.delete(handler) }
  receive (message: any): void { for (const handler of this.handlers) handler(JSON.stringify({ jsonrpc: '2.0', ...message })) }
}

const uri = 'file:///test.md'
const diagnostic: Diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, message: 'Misspelled word', source: 'codebook', data: { original: true } }
const editorDiagnostic = { from: 0, to: 7, severity: 'warning' as const, message: 'Misspelled word' }
const replacement: WorkspaceEdit = { changes: { [uri]: [{ range: diagnostic.range, newText: 'spelling' }] } }
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 20)) }

describe('LSP native diagnostic actions', () => {
  let first: Server
  let second: Server
  let transport: MultiServerTransport
  let client: LSPClient
  let view: EditorView
  let actions: DiagnosticActions

  beforeEach(async () => {
    window.Range.prototype.getClientRects = () => [] as any
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect
    window.requestAnimationFrame = global.requestAnimationFrame
    window.cancelAnimationFrame = global.cancelAnimationFrame
    first = new Server()
    second = new Server()
    transport = new MultiServerTransport([first, second], params => {
      try { applyWorkspaceEdit(client, params.edit); return { applied: true } } catch (err) {
        return { applied: false, failureReason: String(err) }
      }
    })
    client = new LSPClient().connect(transport)
    await client.initializing
    view = new EditorView({ doc: 'speling', extensions: [client.plugin(uri, 'markdown'), history()] })
    actions = new DiagnosticActions(client, transport, view)
  })
  afterEach(() => { view.destroy(); client.disconnect(); transport.destroy() })

  it('shows native lint-panel buttons, applies replacements, and supports undo', async () => {
    second.actions = [{ title: "Replace with 'spelling'", edit: replacement }, { title: 'Disabled', disabled: { reason: 'Unavailable' } }]
    const loaded = await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    assert.strictEqual(loaded[0].actions?.length, 1)
    const request = second.sent.find(message => message.method === 'textDocument/codeAction')
    assert.deepStrictEqual(request.params.context.diagnostics, [diagnostic])
    assert(!first.sent.some(message => message.method === 'textDocument/codeAction'))
    view.dispatch(setDiagnostics(view.state, loaded))
    openLintPanel(view)
    const button = view.dom.querySelector<HTMLButtonElement>('.cm-diagnosticAction')!
    assert.strictEqual(button.textContent, "Replace with 'spelling'")
    button.click()
    await settle()
    assert.strictEqual(view.state.doc.toString(), 'spelling')
    assert(undo(view))
    assert.strictEqual(view.state.doc.toString(), 'speling')
  })

  it('resolves and executes dictionary commands on the originating server, preserving opaque data', async () => {
    const data = { word: 'speling', token: 12 }
    second.actions = [{ title: 'Add to dictionary', data }]
    second.resolve = action => ({ ...action, command: { title: action.title, command: 'codebook.addWord', arguments: ['speling'] } })
    const loaded = await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    loaded[0].actions![0].apply(view, 0, 7)
    await settle()
    assert.deepStrictEqual(second.sent.find(message => message.method === 'codeAction/resolve').params.data, data)
    assert.deepStrictEqual(second.sent.find(message => message.method === 'workspace/executeCommand').params, { command: 'codebook.addWord', arguments: ['speling'] })
    assert(!first.sent.some(message => message.method === 'workspace/executeCommand'))
  })

  it('supports command-only responses and deduplicates action requests for unchanged diagnostics', async () => {
    second.actions = [{ title: 'Ignore', command: { title: 'Ignore', command: 'codebook.ignoreFile', arguments: [uri] } }]
    await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    const loaded = await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    assert.strictEqual(second.sent.filter(message => message.method === 'textDocument/codeAction').length, 1)
    // A plain LSP Command is also a valid code-action response.
    second.actions = [{ title: 'Ignore', command: 'codebook.ignoreFile', arguments: [uri] } as any]
    view.dispatch({ changes: { from: 7, insert: '!' } })
    const fresh = await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    fresh[0].actions![0].apply(view, 0, 7)
    await settle()
    assert(second.sent.some(message => message.method === 'workspace/executeCommand'))
    assert.strictEqual(loaded[0].actions?.length, 1)
  })

  it('rejects stale actions after editing, including edits during asynchronous resolution', async () => {
    second.actions = [{ title: 'Fix', edit: replacement }]
    const loaded = await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    let errors = 0
    LSPPlugin.get(view)!.reportError = () => { errors++ }
    loaded[0].actions![0].apply(view, 0, 7)
    view.dispatch({ changes: { from: 7, insert: '!' } })
    await settle()
    assert.strictEqual(view.state.doc.toString(), 'speling!')
    assert.strictEqual(errors, 1)
    loaded[0].actions![0].apply(view, 0, 7)
    await settle()
    assert.strictEqual(errors, 2)
  })

  it('answers server applyEdit requests and rejects unsupported edits without partial changes', () => {
    second.receive({ id: 'edit', method: 'workspace/applyEdit', params: { edit: replacement } })
    assert.strictEqual(view.state.doc.toString(), 'spelling')
    assert.deepStrictEqual(second.sent.at(-1), { jsonrpc: '2.0', id: 'edit', result: { applied: true } })
    const mixed: WorkspaceEdit = { changes: { [uri]: [{ range: diagnostic.range, newText: 'wrong' }], 'file:///unopened.md': [] } }
    second.receive({ id: 'bad-edit', method: 'workspace/applyEdit', params: { edit: mixed } })
    assert.strictEqual(second.sent.at(-1).result.applied, false)
    assert.strictEqual(view.state.doc.toString(), 'spelling')
    assert.throws(() => applyWorkspaceEdit(client, { documentChanges: [{ kind: 'delete', uri }] }), /not supported/)
    assert.throws(() => applyWorkspaceEdit(client, { documentChanges: [{ textDocument: { uri, version: 99 }, edits: [] }] }), /document changed/)
    assert.throws(() => applyWorkspaceEdit(client, { changes: { [uri]: [{ range: { start: { line: 0, character: 99 }, end: { line: 0, character: 100 } }, newText: '' }] } }), /Invalid code action range/)
  })

  it('bounds cached action responses and drops them when the document is cleared', async () => {
    for (let index = 0; index < 9; index++) {
      await actions.load(uri, [{ ...diagnostic, message: String(index) }], [1], [editorDiagnostic], () => true)
    }
    await actions.load(uri, [{ ...diagnostic, message: '0' }], [1], [editorDiagnostic], () => true)
    assert.strictEqual(second.sent.filter(message => message.method === 'textDocument/codeAction').length, 10)
    actions.clear()
    await actions.load(uri, [{ ...diagnostic, message: '0' }], [1], [editorDiagnostic], () => true)
    assert.strictEqual(second.sent.filter(message => message.method === 'textDocument/codeAction').length, 11)
  })

  it('does not cache oversized edits', async () => {
    second.actions = [{ title: 'Large edit', edit: { changes: { [uri]: [{ range: diagnostic.range, newText: 'x'.repeat(600000) }] } } }]
    await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    await actions.load(uri, [diagnostic], [1], [editorDiagnostic], () => true)
    assert.strictEqual(second.sent.filter(message => message.method === 'textDocument/codeAction').length, 2)
  })

  it('bounds pending requests even across overlapping diagnostic loads', async () => {
    const original = second.send.bind(second)
    const requests: any[] = []
    second.send = raw => {
      const message = JSON.parse(raw)
      if (message.method === 'textDocument/codeAction') requests.push(message)
      else original(raw)
    }
    const loads = Array.from({ length: 4 }, (_, index) => actions.load(uri, [{ ...diagnostic, message: String(index) }], [1], [editorDiagnostic], () => true))
    assert.strictEqual(requests.length, 4)
    await assert.rejects(actions.load(uri, [{ ...diagnostic, message: 'overflow' }], [1], [editorDiagnostic], () => true), /still loading/)
    for (const request of requests) second.receive({ id: request.id, result: [] })
    await Promise.all(loads)
  })

  it('preserves server provenance without changing diagnostic data', () => {
    const messages: any[] = []
    transport.subscribe(raw => messages.push(JSON.parse(raw)))
    first.receive({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [diagnostic] } })
    second.receive({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [diagnostic] } })
    assert.deepStrictEqual(messages.at(-1).params.zettlrServers, [0, 1])
    assert.deepStrictEqual(messages.at(-1).params.diagnostics, [diagnostic, diagnostic])
  })
})
