'use strict'

/* eslint @typescript-eslint/no-require-imports: off */

// yaml-language-server's Node IPC transport is adapted to Electron's utility
// process MessagePort so the bundled server can run without enabling
// ELECTRON_RUN_AS_NODE or giving a renderer Node.js access.
const { parentPort } = process
const path = require('node:path')

if (parentPort === null) {
  throw new Error('YAML language server must run in an Electron utility process')
}

parentPort.on('message', event => { process.emit('message', event.data) })
Object.defineProperty(process, 'send', {
  configurable: true,
  value: message => parentPort.postMessage(message)
})

const serverCLI = path.join(__dirname, 'node_modules', 'yaml-language-server', 'bin', 'yaml-language-server')
process.argv = [ process.argv[0], serverCLI, ...process.argv.slice(2) ]
require(serverCLI)
