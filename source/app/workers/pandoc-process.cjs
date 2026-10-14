/* eslint-disable @typescript-eslint/no-require-imports -- Copied as a standalone CommonJS process entry. */
// Keep native WASI descriptors in a disposable process, even when its worker
// cannot unwind (for example, an infinite Lua loop or a native crash).
const { Worker } = require('node:worker_threads')
const path = require('node:path')
const port = process.parentPort
let started = false

function send (message) {
  if (port !== undefined && port !== null) port.postMessage(message)
  else process.send(message)
}

function receive (message) {
  if (message.acknowledgement === true) process.exit(0)
  if (started) return
  started = true
  let result
  const worker = new Worker(path.join(__dirname, 'pandoc-worker.cjs'), { workerData: message })
  worker.on('message', message => { result = message })
  worker.on('error', error => { result = { error: error.message } })
  worker.on('exit', code => {
    send(result ?? { error: `Pandoc WASM worker exited without a result (code ${code}).` })
  })
}

if (port !== undefined && port !== null) port.on('message', event => receive(event.data))
else process.on('message', receive)
