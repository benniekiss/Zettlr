import { strictEqual, rejects, deepStrictEqual } from 'assert'
import { effectScope, onScopeDispose } from 'vue'
import { useDisposables } from 'source/common/vue/use-disposables'
import { documentAuthorityIPCAPI } from 'source/common/modules/markdown-editor/util/ipc-api'
import { DP_EVENTS } from 'source/types/common/documents'
import { EditorState } from '@codemirror/state'
import type { EditorView, PluginValue } from '@codemirror/view'
import { hookDocumentAuthority } from 'source/common/modules/markdown-editor/plugins/remote-doc'

describe('Scoped resource disposal', () => {
  it('uses Vue directly for listeners registered during setup', () => {
    let active = 0
    const ipc: Pick<Window['ipc'], 'on'> = {
      on: () => { active++; return () => { active-- } }
    }
    const scope = effectScope()
    scope.run(() => { onScopeDispose(ipc.on('setup', () => {})) })
    strictEqual(active, 1)
    scope.stop()
    strictEqual(active, 0)
  })

  it('unsubscribes once on scope disposal and immediately cleans up late registrations', () => {
    let active = 0
    const ipc: Pick<Window['ipc'], 'on'> = {
      on: () => { active++; return () => { active-- } }
    }
    const scope = effectScope()
    const dispose = scope.run(() => useDisposables())!
    const stop = dispose(ipc.on('first', () => {}))
    dispose(ipc.on('second', () => {}))
    stop()
    stop()
    strictEqual(active, 1)
    scope.stop()
    strictEqual(active, 0)
    dispose(ipc.on('late', () => {}))()
    strictEqual(active, 0)
  })

  it('runs remaining destructors and reports failures without interrupting disposal', () => {
    const scope = effectScope()
    const dispose = scope.run(() => useDisposables())!
    const calls: string[] = []
    const error = new Error('Destructor failure')
    const original = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const stop = dispose(() => { calls.push('first'); throw error })
      dispose(() => { calls.push('second') })
      scope.stop()
      stop()
      dispose(() => { calls.push('late'); throw error })()
      deepStrictEqual(calls, ['first', 'second', 'late'])
      strictEqual(errors.length, 2)
      strictEqual(errors[0][1], error)
    } finally {
      console.error = original
    }
  })
})

describe('Document authority IPC pulls', () => {
  let original: Window['ipc']
  let listeners: Set<Parameters<Window['ipc']['on']>[1]>
  let calls: number
  let finish: (value: unknown) => void
  let fail: (reason: Error) => void

  beforeEach(() => {
    original = window.ipc
    listeners = new Set()
    calls = 0
    window.ipc = {
      ...original,
      on: (_channel, listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      invoke: async () => {
        calls++
        return await new Promise((resolve, reject) => { finish = resolve; fail = reject })
      }
    }
  })

  afterEach(() => { window.ipc = original })

  function announce (path = 'test.md'): void {
    for (const listener of listeners) {
      listener(undefined, { event: DP_EVENTS.CHANGE_FILE_STATUS, context: { filePath: path } })
    }
  }

  it('cancels an idle pull without waiting for another document event', async () => {
    const controller = new AbortController()
    const pull = documentAuthorityIPCAPI.pullUpdates('test.md', 0, controller.signal)
    strictEqual(listeners.size, 1)
    controller.abort()
    deepStrictEqual(await pull, [])
    strictEqual(listeners.size, 0)
    strictEqual(calls, 0)
  })

  it('does not register a pull that was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    deepStrictEqual(await documentAuthorityIPCAPI.pullUpdates('test.md', 0, controller.signal), [])
    strictEqual(listeners.size, 0)
  })

  it('sends one request during an event burst and removes its listener on success', async () => {
    const pull = documentAuthorityIPCAPI.pullUpdates('test.md', 0)
    announce('another.md')
    strictEqual(calls, 0)
    for (let i = 0; i < 20; i++) announce()
    strictEqual(calls, 1)
    finish([])
    deepStrictEqual(await pull, [])
    strictEqual(listeners.size, 0)
  })

  it('removes its listener when a request rejects', async () => {
    const pull = documentAuthorityIPCAPI.pullUpdates('test.md', 0)
    announce()
    fail(new Error('IPC failure'))
    await rejects(pull, /IPC failure/)
    strictEqual(listeners.size, 0)
  })

  it('cancels while a request is in flight and ignores its eventual result', async () => {
    const controller = new AbortController()
    const pull = documentAuthorityIPCAPI.pullUpdates('test.md', 0, controller.signal)
    announce()
    controller.abort()
    deepStrictEqual(await pull, [])
    finish(false)
    strictEqual(listeners.size, 0)
  })

  it('destroys a document plugin without retaining its idle pull or reading its destroyed view', async () => {
    const extensions = hookDocumentAuthority('test.md', 0, documentAuthorityIPCAPI.pullUpdates, async () => true)
    const state = EditorState.create({ doc: 'Test', extensions })
    let reads = 0
    const view = { get state () { reads++; return state } } as EditorView
    const plugin = (extensions as unknown as [unknown, { create: (view: EditorView) => PluginValue }])[1].create(view)
    strictEqual(listeners.size, 1)
    const initialReads = reads
    plugin.destroy?.()
    await new Promise(resolve => setImmediate(resolve))
    strictEqual(listeners.size, 0)
    strictEqual(reads, initialReads)
  })
})
