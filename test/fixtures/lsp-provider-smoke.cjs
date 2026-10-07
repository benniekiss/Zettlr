// Exercise the actual provider with a real child process and mocked Electron IPC.
const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const handlers = new Map()
const originalLoad = Module._load
Module._load = function (name, ...args) {
  if (name === 'electron') return {
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel)
    }
  }
  return originalLoad.call(this, name, ...args)
}
const LSPProvider = require('../../source/app/service-providers/lsp').default
Module._load = originalLoad

class Owner extends EventEmitter {
  constructor () { super(); this.messages = []; this.destroyed = false }
  isDestroyed () { return this.destroyed }
  send (_channel, payload) { this.messages.push(payload); this.emit('message', payload) }
}

const fakeServer = `
let buffer = Buffer.alloc(0)
function send(value) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...value })
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf('\\r\\n\\r\\n')
    if (end === -1) return
    const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const value = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    if (value.method === 'initialize') {
      send({ id: value.id, result: { capabilities: { textDocumentSync: 1 }, received: value.params, env: process.env.ZETTLR_LSP_TEST } })
    } else if (value.method === 'initialized') {
      send({ id: 'config-request', method: 'workspace/configuration', params: { items: [{ section: 'ltex' }, { section: 'ltex.language' }, { section: 'unknown' }] } })
    } else if (value.id === 'config-request') {
      send({ method: 'test/settings', params: value.result })
    } else if (value.method === 'shutdown') {
      send({ id: value.id, result: null })
    } else if (value.method === 'exit') {
      process.exit(0)
    }
  }
})
`

async function main () {
  const owner = new Owner()
  const stranger = new Owner()
  const config = [{ name: 'test', command: process.execPath, args: ['-e', fakeServer], languages: ['markdown'], cwd: '/tmp', env: { ZETTLR_LSP_TEST: 'passed' }, initializationOptions: { test: true }, settings: { ltex: { language: 'de-DE' } } }]
  const provider = new LSPProvider({ error: console.error, verbose: console.error }, { get: () => JSON.stringify(config) })
  const invoke = handlers.get('lsp-provider')
  const start = () => invoke({ sender: owner }, { command: 'start', name: 'test', path: '/tmp/lsp ä.md' })
  function waitFor (predicate) {
    return new Promise((resolve, reject) => {
      const existing = owner.messages.find(predicate)
      if (existing) return resolve(existing)
      const timer = setTimeout(() => { owner.off('message', listener); reject(new Error('Timed out waiting for server')) }, 5000)
      const listener = message => {
        if (!predicate(message)) return
        clearTimeout(timer)
        owner.off('message', listener)
        resolve(message)
      }
      owner.on('message', listener)
    })
  }
  try {
    await assert.rejects(invoke({ sender: owner }, { command: 'start', name: 'unconfigured', path: '/tmp/test.md' }), /not configured/)
    const session = await start()
    assert.equal(session.uri, pathToFileURL('/tmp/lsp ä.md').href)
    await assert.rejects(invoke({ sender: stranger }, { command: 'send', id: session.id, message: '{}' }), /Unknown LSP session/)
    const send = message => invoke({ sender: owner }, { command: 'send', id: session.id, message: JSON.stringify({ jsonrpc: '2.0', ...message }) })
    await send({ id: 1, method: 'initialize', params: { rootUri: 'incorrect', processId: null } })
    const response = JSON.parse((await waitFor(message => message.message && JSON.parse(message.message).id === 1)).message)
    assert.deepEqual(response.result.received.initializationOptions, { test: true })
    assert.equal(response.result.received.rootUri, pathToFileURL('/tmp').href)
    assert.equal(response.result.received.processId, process.pid)
    assert.equal(response.result.env, 'passed')
    await send({ method: 'initialized', params: {} })
    const settings = JSON.parse((await waitFor(message => message.message && JSON.parse(message.message).method === 'test/settings')).message)
    assert.deepEqual(settings.params, [{ language: 'de-DE' }, 'de-DE', null])
    assert(!owner.messages.some(message => message.message && JSON.parse(message.message).method === 'workspace/configuration'))
    const stopping = waitFor(message => message.id === session.id && message.closed)
    await invoke({ sender: owner }, { command: 'stop', id: session.id })
    await stopping
    const another = await start()
    owner.destroyed = true
    owner.emit('destroyed')
    await assert.rejects(invoke({ sender: owner }, { command: 'send', id: another.id, message: '{}' }), /Unknown LSP session/)
  } finally {
    await provider.shutdown()
  }
  assert(!handlers.has('lsp-provider'))
}
main().catch(err => { console.error(err); process.exitCode = 1 })
