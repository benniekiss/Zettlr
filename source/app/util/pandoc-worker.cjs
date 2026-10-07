/* eslint-disable @typescript-eslint/no-require-imports -- Copied as a standalone CommonJS worker. */
// Pandoc's reactor API uses defaults-file options and four named IO files.
// Run it in a worker so compilation and conversion do not block Electron.
const { parentPort, workerData } = require('node:worker_threads')
const { WASI } = require('node:wasi')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

async function run () {
  const module = await WebAssembly.compile(fs.readFileSync(workerData.wasmPath))
  const exports = new Set(WebAssembly.Module.exports(module).filter(item => item.kind === 'function').map(item => item.name))
  if (['malloc', 'convert', 'query', '__wasm_call_ctors', 'hs_init_with_rtsopts'].some(name => !exports.has(name))) {
    throw new Error('The downloaded module does not provide the Pandoc WASM API. Check the Pandoc download URL.')
  }
  let wasi
  let ioDescriptor
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zettlr-pandoc-'))
  try {
    const cwd = workerData.cwd || process.cwd()
    const roots = process.platform === 'win32'
      ? [...new Set([path.parse(cwd).root, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(root => fs.existsSync(root))])]
      : ['/']
    const guestPath = filename => process.platform === 'win32'
      ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1:')
      : filename
    const guestRoots = roots.map(guestPath)
    // Preopen descriptors start at 3: cwd, filesystem roots, then private IO.
    ioDescriptor = 4 + roots.length
    const preopens = { '.': cwd, ...Object.fromEntries(guestRoots.map((root, index) => [root, roots[index]])), '/__zettlr_io': temporary }
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, /^[A-Za-z]:[\\/]/.test(value) ? guestPath(value) : value]))
    env.PWD = guestPath(cwd)
    const reserved = new Set(['stdin', 'stdout', 'stderr', 'warnings'])
    for (const filename of reserved) fs.writeFileSync(path.join(temporary, filename), '')
    wasi = new WASI({ version: 'preview1', args: [], env, preopens, returnOnExit: true })
    let instance
    let pathBuffer
    const pathCapacity = 65536
    const encode = value => {
      const bytes = Buffer.from(value)
      const pointer = instance.exports.malloc(bytes.length + 1)
      new Uint8Array(instance.exports.memory.buffer, pointer, bytes.length + 1).set(bytes)
      return [pointer, bytes.length]
    }
    const adapt = (args, descriptorIndex, pointerIndex, lengthIndex, slot) => {
      const bytes = new Uint8Array(instance.exports.memory.buffer, args[pointerIndex], args[lengthIndex])
      let filename = Buffer.from(bytes).toString()
      if (process.platform === 'win32') {
        filename = filename.replaceAll('\\', '/')
        bytes.set(Buffer.from(filename))
      }
      if (reserved.has(filename)) {
        args[descriptorIndex] = ioDescriptor
        return
      }
      if (args[descriptorIndex] === 3 && !path.posix.isAbsolute(filename) && !/^[A-Za-z]:\//.test(filename)) {
        // Resolve from the document directory through a root preopen so ../
        // resources and symlinks outside that directory keep working.
        filename = guestPath(path.resolve(cwd, filename))
        const encoded = Buffer.from(filename)
        if (encoded.length > pathCapacity) throw new Error('Pandoc resource path is too long.')
        const pointer = pathBuffer + slot * pathCapacity
        new Uint8Array(instance.exports.memory.buffer, pointer, encoded.length).set(encoded)
        args[pointerIndex] = pointer
        args[lengthIndex] = encoded.length
      }
      for (let index = 0; index < guestRoots.length; index++) {
        const root = guestRoots[index]
        const prefix = filename.startsWith(root) ? root
          : process.platform === 'win32' && filename.startsWith(root.slice(1)) ? root.slice(1) : undefined
        if (prefix !== undefined) {
          args[descriptorIndex] = 4 + index
          // Reuse the caller's buffer without allocating in a WASI callback.
          const length = Buffer.byteLength(prefix)
          args[pointerIndex] += length
          args[lengthIndex] -= length
          return
        }
      }
    }
    const paths = {
      path_open: [[0, 2, 3]], path_filestat_get: [[0, 2, 3]], path_filestat_set_times: [[0, 2, 3]],
      path_create_directory: [[0, 1, 2]], path_unlink_file: [[0, 1, 2]], path_remove_directory: [[0, 1, 2]],
      path_readlink: [[0, 1, 2]], path_rename: [[0, 1, 2], [3, 4, 5]],
      path_link: [[0, 2, 3], [4, 5, 6]], path_symlink: [[2, 3, 4]]
    }
    const imports = Object.fromEntries(Object.entries(wasi.wasiImport).map(([name, fn]) => [name, (...args) => {
      // Keep a JS wrapper around EVERY import, including fd_read/fd_write.
      // Direct native imports can crash Node 22/V8 during WASI-triggered GC.
      if (name === 'proc_raise') throw new Error(`Pandoc WASM requested signal ${args[0]}.`)
      if (name === 'proc_exit') throw new Error(`Pandoc WASM exited with code ${args[0]}.`)
      for (const [slot, indices] of (paths[name] || []).entries()) adapt(args, ...indices, slot)
      return fn(...args)
    }]))
    instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports })
    // GHC exports both CLI _start and the reactor functions. Initialize only
    // the reactor; invoking _start would enter the command-line program.
    wasi.initialize({ exports: { ...instance.exports, _start: undefined } })
    // Two slots cover source and destination paths in link/rename syscalls.
    // Allocate once, never by reentering WASM from a syscall callback.
    pathBuffer = instance.exports.malloc(pathCapacity * 2)
    instance.exports.__wasm_call_ctors()
    const argv = ['pandoc.wasm', '+RTS', '-H64m', '-RTS']
    const argcPointer = instance.exports.malloc(4)
    const argvPointer = instance.exports.malloc(4 * (argv.length + 1))
    for (let i = 0; i < argv.length; i++) {
      const [pointer] = encode(argv[i])
      new DataView(instance.exports.memory.buffer).setUint32(argvPointer + 4 * i, pointer, true)
    }
    const argvReference = instance.exports.malloc(4)
    const view = new DataView(instance.exports.memory.buffer)
    view.setUint32(argcPointer, argv.length, true)
    view.setUint32(argvPointer + 4 * argv.length, 0, true)
    view.setUint32(argvReference, argvPointer, true)
    instance.exports.hs_init_with_rtsopts(argcPointer, argvReference)
    const [pointer, length] = encode(JSON.stringify(workerData.options, (_key, value) => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) ? guestPath(value) : value))
    instance.exports[workerData.query ? 'query' : 'convert'](pointer, length)
    const stdout = fs.readFileSync(path.join(temporary, 'stdout'), 'utf8')
    const stderr = fs.readFileSync(path.join(temporary, 'stderr'), 'utf8')
    const warnings = fs.readFileSync(path.join(temporary, 'warnings'), 'utf8')
    return { stdout, stderr, warnings }
  } finally {
    // Close preopen directory handles before deleting the IO directory on Windows.
    if (wasi !== undefined) {
      for (let descriptor = 3; descriptor <= ioDescriptor; descriptor++) {
        try { wasi.wasiImport.fd_close(descriptor) } catch { /* Initialization may have failed. */ }
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

run().then(result => parentPort.postMessage(result)).catch(error => {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
}).finally(() => parentPort.close())
