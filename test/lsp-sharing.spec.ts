import assert from 'assert'
import { EditorView } from '@codemirror/view'
import { LSPPlugin } from '@codemirror/lsp-client'
import { collab, receiveUpdates, sendableUpdates } from '@codemirror/collab'
import { forEachDiagnostic } from '@codemirror/lint'
import { pathToFileURL } from 'url'
import { languageServers } from '../source/common/modules/markdown-editor/plugins/lsp'
import { languageServerRoot } from '../source/app/service-providers/lsp/workspace-root'
import type { LanguageServerConfig } from '../source/common/lsp/config'

const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 30)) }
const markdownServers = ['panache', 'codebook', 'ltex'].map(name => ({ name, command: name, languages: ['markdown'] }))

describe('Shared editor LSP sessions', () => {
  let previousIPC: typeof window.ipc
  let previousConfig: string
  let previousRoots: unknown
  let delayResolve: boolean
  let resolveQueue: Array<(value: any) => void>
  let views: EditorView[]
  let calls: any[]
  let listeners: Map<string, Set<(...args: any[]) => void>>
  let processes: Map<string, string>
  let initialize: boolean
  let failInit: boolean
  let holdHover: boolean
  let holdStart: ((value: any) => void)|undefined

  const emit = (id: string, message: any): void => {
    for (const listener of listeners.get('lsp-message') ?? []) listener(undefined, { id, message: JSON.stringify({ jsonrpc: '2.0', ...message }) })
  }
  const configure = (servers: LanguageServerConfig[]): void => { window.config.set('languageServers', JSON.stringify(servers)) }
  const sent = (method: string): any[] => calls.filter(call => call.command === 'send').map(call => ({ id: call.id, value: JSON.parse(call.message) })).filter(call => call.value.method === method)
  const create = (path: string, doc = 'hello', clientID?: string): EditorView => {
    const view = new EditorView({ doc, extensions: [clientID === undefined ? [] : collab({ clientID }), languageServers(path, path.endsWith('.json') ? 'json' : 'markdown')] })
    views.push(view)
    return view
  }

  beforeEach(() => {
    previousIPC = window.ipc
    previousConfig = window.config.get('languageServers')
    previousRoots = window.config.get('app.openWorkspaces')
    delayResolve = false; resolveQueue = []
    views = []; calls = []; processes = new Map(); listeners = new Map(); initialize = true; failInit = false; holdHover = false; holdStart = undefined
    configure(markdownServers)
    window.requestAnimationFrame = global.requestAnimationFrame
    window.cancelAnimationFrame = global.cancelAnimationFrame
    window.Range.prototype.getClientRects = () => [] as any
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect
    window.ipc = {
      ...previousIPC,
      on (channel: string, listener: (...args: any[]) => void) {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
        return () => listeners.get(channel)!.delete(listener)
      },
      async invoke (_channel: string, payload: any) {
        calls.push(payload)
        if (payload.command === 'resolve' && delayResolve) return await new Promise(resolve => resolveQueue.push(resolve))
        if (payload.command === 'resolve') return { uri: pathToFileURL(payload.path).href, rootUri: payload.path.startsWith('/other/') ? 'file:///other' : 'file:///workspace' }
        if (payload.command === 'start') {
          const id = `${payload.name}-${processes.size}`
          processes.set(id, payload.name)
          if (holdStart !== undefined) return await new Promise(resolve => { holdStart = resolve })
          return { id, uri: pathToFileURL(payload.path).href, rootUri: 'file:///workspace' }
        }
        if (payload.command === 'send') {
          const message = JSON.parse(payload.message)
          if (message.method === 'initialize' && initialize) queueMicrotask(() => emit(payload.id, { id: message.id, ...(failInit ? { error: { code: -32603, message: 'Failed initialization' } } : { result: { capabilities: { textDocumentSync: 1, hoverProvider: true, completionProvider: {}, codeActionProvider: true } } }) }))
          if (message.method === 'textDocument/codeAction') queueMicrotask(() => emit(payload.id, { id: message.id, result: [{ title: 'Add word', command: { title: 'Add word', command: 'codebook.addWord' } }] }))
          if (message.method === 'textDocument/completion') queueMicrotask(() => emit(payload.id, { id: message.id, result: [{ label: processes.get(payload.id) }] }))
          if (message.method === '$/cancelRequest') {
            const request = sent('textDocument/hover').find(request => request.id === payload.id && request.value.id === message.params.id)
            if (request) queueMicrotask(() => emit(payload.id, { id: request.value.id, result: null }))
          }
          if (message.method === 'completionItem/resolve') queueMicrotask(() => emit(payload.id, { id: message.id, result: message.params }))
          if (message.method === 'textDocument/hover' && !holdHover) queueMicrotask(() => emit(payload.id, { id: message.id, result: null }))
        }
      }
    } as typeof window.ipc
  })

  afterEach(async () => {
    for (const view of views) view.destroy()
    await settle()
    assert.strictEqual(listeners.get('lsp-message')?.size ?? 0, 0)
    window.ipc = previousIPC
    window.config.set('languageServers', previousConfig)
    window.config.set('app.openWorkspaces', previousRoots)
  })

  it('shares processes and native clients across documents and split panes, closing only the final consumer', async () => {
    const first = create('/workspace/first.md')
    const second = create('/workspace/nested/second.md')
    const duplicate = create('/workspace/nested/second.md')
    await settle()
    assert.strictEqual(calls.filter(call => call.command === 'start').length, 3)
    assert.strictEqual(sent('initialize').length, 3)
    assert.strictEqual(sent('textDocument/didOpen').length, 6)
    const client = LSPPlugin.get(first)!.client
    assert.strictEqual(LSPPlugin.get(second)!.client, client)
    assert.strictEqual(LSPPlugin.get(duplicate)!.client, client)
    first.destroy(); views = views.filter(view => view !== first)
    await settle()
    assert.strictEqual(sent('textDocument/didClose').length, 3)
    assert.strictEqual(calls.filter(call => call.command === 'stop').length, 0)
    second.dispatch({ changes: { from: 5, insert: '!' } })
    client.sync(); await settle()
    assert.strictEqual(sent('textDocument/didChange').length, 3)
    client.sync(); await settle()
    assert.strictEqual(sent('textDocument/didChange').length, 3)
    const uri = pathToFileURL('/workspace/nested/second.md').href
    const codebook = [...processes].find(([, name]) => name === 'codebook')![0]
    emit(codebook, { method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'Shared warning' }] } })
    await settle()
    const messages = (view: EditorView): string[] => { const result: string[] = []; forEachDiagnostic(view.state, diagnostic => result.push(diagnostic.message)); return result }
    assert(messages(second).includes('Shared warning'))
    assert(!messages(duplicate).includes('Shared warning'))
    duplicate.dispatch({ changes: { from: 5, insert: '!' } })
    await settle()
    assert(messages(duplicate).includes('Shared warning'))
    assert.strictEqual(sent('textDocument/didChange').length, 3)
    second.destroy(); views = views.filter(view => view !== second)
    await settle()
    assert.strictEqual(sent('textDocument/didClose').length, 3)
    duplicate.destroy(); views = []
    await settle()
    assert.strictEqual(sent('textDocument/didClose').length, 6)
    assert.strictEqual(calls.filter(call => call.command === 'stop').length, 3)
  })

  it('isolates workspace roots and restarts each shared group once on configuration changes', async () => {
    const first = create('/workspace/first.md')
    create('/workspace/second.md')
    const other = create('/other/third.md')
    await settle()
    assert.strictEqual(calls.filter(call => call.command === 'start').length, 6)
    assert.notStrictEqual(LSPPlugin.get(first)!.client, LSPPlugin.get(other)!.client)
    configure([markdownServers[0]])
    for (const listener of listeners.get('config-provider') ?? []) listener(undefined, { command: 'update' })
    await settle()
    assert.strictEqual(calls.filter(call => call.command === 'start').length, 8)
    assert.strictEqual(calls.filter(call => call.command === 'stop').length, 6)
    assert.strictEqual(sent('initialize').length, 8)
  })

  it('routes document notifications, native feature requests, and completion resolution by language', async () => {
    configure([{ name: 'markdown', command: 'md', languages: ['markdown'] }, { name: 'json', command: 'json', languages: ['json'] }])
    const markdown = create('/workspace/first.md')
    const json = create('/workspace/config.json', '{}')
    await settle()
    assert.strictEqual(calls.filter(call => call.command === 'start').length, 2)
    assert.strictEqual(LSPPlugin.get(markdown)!.client, LSPPlugin.get(json)!.client)
    assert.deepStrictEqual(sent('textDocument/didOpen').map(call => [processes.get(call.id), call.value.params.textDocument.languageId]), [['markdown', 'markdown'], ['json', 'json']])
    const client = LSPPlugin.get(json)!.client
    const params = { textDocument: { uri: pathToFileURL('/workspace/config.json').href }, position: { line: 0, character: 0 } }
    await client.request('textDocument/hover', params)
    assert.strictEqual(processes.get(sent('textDocument/hover')[0].id), 'json')
    const completions = await client.request<typeof params, any[]>('textDocument/completion', params)
    await client.request('completionItem/resolve', completions[0])
    assert.strictEqual(processes.get(sent('completionItem/resolve')[0].id), 'json')
    assert(!('zettlrServer' in sent('completionItem/resolve')[0].value.params))
  })

  it('uses acknowledged authority versions and never rolls a document back from a lagging pane', async () => {
    configure([markdownServers[0]])
    const first = create('/workspace/shared.md', 'hello', 'first')
    const second = create('/workspace/shared.md', 'hello', 'second')
    await settle()
    const client = LSPPlugin.get(first)!.client
    first.dispatch({ changes: { from: 5, insert: '!' } })
    const changes = sendableUpdates(first.state)
    client.sync(); await settle()
    assert.strictEqual(sent('textDocument/didChange').length, 1)
    first.dispatch(receiveUpdates(first.state, changes))
    client.sync(); await settle()
    assert.strictEqual(sent('textDocument/didChange').length, 1)
    assert.strictEqual(client.workspace.files[0].doc.toString(), 'hello!')
    client.sync(); await settle()
    assert.strictEqual(client.workspace.files[0].doc.toString(), 'hello!')
    second.dispatch(receiveUpdates(second.state, changes))
    client.sync(); await settle()
    assert.strictEqual(sent('textDocument/didChange').length, 1)
    second.dispatch({ changes: { from: 6, insert: '?' } })
    const next = sendableUpdates(second.state)
    second.dispatch(receiveUpdates(second.state, next))
    client.sync(); await settle()
    assert.strictEqual(client.workspace.files[0].doc.toString(), 'hello!?')
    first.dispatch(receiveUpdates(first.state, next))
    client.sync(); await settle()
    assert.deepStrictEqual(sent('textDocument/didChange').map(call => call.value.params.textDocument.version), [1, 2])
  })

  it('uses native request cancellation and workspace position mappings', async () => {
    const view = create('/workspace/first.md')
    await settle()
    const client = LSPPlugin.get(view)!.client
    const uri = pathToFileURL('/workspace/first.md').href
    holdHover = true
    const params = { textDocument: { uri }, position: { line: 0, character: 0 } }
    const request = client.request('textDocument/hover', params)
    await settle()
    client.cancelRequest(params)
    assert.strictEqual(await request, null)
    assert(sent('$/cancelRequest').every(call => call.value.params.id === sent('textDocument/hover')[0].value.id))
    await client.withMapping(async mapping => {
      view.dispatch({ changes: { from: 0, insert: 'new ' } })
      client.sync()
      assert.strictEqual(mapping.mapPosition(uri, { line: 0, character: 2 }), 6)
    })
  })

  it('evicts failed shared sessions so a new view can retry initialization', async () => {
    configure([markdownServers[0]])
    failInit = true
    const originalError = console.error
    console.error = () => {}
    try {
      create('/workspace/failed.md')
      await settle()
      assert.strictEqual(calls.filter(call => call.command === 'stop').length, 1)
      failInit = false
      const retry = create('/workspace/retry.md')
      await settle()
      assert.strictEqual(calls.filter(call => call.command === 'start').length, 2)
      assert(LSPPlugin.get(retry))
    } finally { console.error = originalError }
  })

  it('rejects a loaded action when another pane advances the shared document', async () => {
    configure([markdownServers[0]])
    const first = create('/workspace/shared.md')
    const second = create('/workspace/shared.md')
    await settle()
    const uri = pathToFileURL('/workspace/shared.md').href
    emit([...processes.keys()][0], { method: 'textDocument/publishDiagnostics', params: { uri, version: 0, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: 'Warning' }] } })
    await settle()
    forEachDiagnostic(first.state, diagnostic => diagnostic.actions?.[0].apply(first, 0, 5))
    await settle()
    let fix: import('@codemirror/lint').Action|undefined
    forEachDiagnostic(first.state, diagnostic => { fix = diagnostic.actions?.[0] })
    assert.strictEqual(fix?.name, 'Add word')
    let errors = 0
    LSPPlugin.get(first)!.reportError = () => { errors++ }
    second.dispatch({ changes: { from: 5, insert: '!' } })
    LSPPlugin.get(second)!.client.sync()
    fix!.apply(first, 0, 5)
    await settle()
    assert.strictEqual(errors, 1)
    assert.strictEqual(sent('workspace/executeCommand').length, 0)
  })

  it('ignores stale root lookups after a configuration update', async () => {
    configure([markdownServers[0]])
    delayResolve = true
    const view = create('/workspace/first.md')
    await settle()
    window.config.set('app.openWorkspaces', ['/workspace', '/unrelated'])
    for (const listener of listeners.get('config-provider') ?? []) listener(undefined, { command: 'update' })
    await settle()
    assert.strictEqual(resolveQueue.length, 2)
    const root = { uri: pathToFileURL('/workspace/first.md').href, rootUri: 'file:///workspace' }
    resolveQueue[1](root)
    await settle()
    resolveQueue[0](root)
    await settle()
    assert(LSPPlugin.get(view))
    assert.strictEqual(calls.filter(call => call.command === 'start').length, 1)
    assert.strictEqual(calls.filter(call => call.command === 'stop').length, 0)
  })

  it('releases processes even if their spawn response arrives after the last view closes', async () => {
    configure([markdownServers[0]])
    holdStart = () => {}
    const view = create('/workspace/pending.md')
    await settle()
    view.destroy(); views = []
    await settle()
    holdStart!({ id: [...processes.keys()][0], uri: 'file:///workspace/pending.md', rootUri: 'file:///workspace' })
    await settle()
    assert.strictEqual(calls.filter(call => call.command === 'stop').length, 1)
  })
})

describe('LSP workspace root selection', () => {
  it('uses the longest matching workspace and rejects path-prefix siblings', () => {
    const { resolve, join } = require('path')
    const base = resolve('test-workspace')
    assert.strictEqual(languageServerRoot(join(base, 'nested', 'file.md'), [base, join(base, 'nested')]), join(base, 'nested'))
    assert.strictEqual(languageServerRoot(join(base + '-other', 'file.md'), [base]), base + '-other')
  })
})
