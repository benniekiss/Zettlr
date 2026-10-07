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
  const exports = WebAssembly.Module.exports(module)
  if (!exports.some(item => item.name === 'memory' && item.kind === 'memory') ||
    ['malloc', 'convert', 'query', '__wasm_call_ctors', 'hs_init_with_rtsopts'].some(name => !exports.some(item => item.name === name && item.kind === 'function'))) {
    throw new Error('The downloaded module does not provide the Pandoc WASM API. Check the Pandoc download URL.')
  }
  let wasi
  const descriptors = new Set()
  const stdio = []
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zettlr-pandoc-'))
  try {
    const cwd = path.resolve(workerData.cwd || process.cwd())
    const roots = process.platform === 'win32'
      ? [...new Set([path.parse(cwd).root, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(root => fs.existsSync(root))])]
      : ['/']
    const guestPath = filename => process.platform === 'win32'
      ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1:')
      : filename
    const guestRoots = roots.map(guestPath)
    // Preopen descriptors start at 3: cwd, filesystem roots, then private IO.
    const ioDescriptor = 4 + roots.length
    const preopens = { '.': cwd, ...Object.fromEntries(guestRoots.map((root, index) => [root, roots[index]])), '/__zettlr_io': temporary }
    const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, /^[A-Za-z]:[\\/]/.test(value) ? guestPath(value) : value]))
    env.PWD = guestPath(cwd)
    const reserved = new Set(['stdin', 'stdout', 'stderr', 'warnings'])
    for (const filename of reserved) fs.writeFileSync(path.join(temporary, filename), '')
    // Lua print/io.stderr and RTS diagnostics use descriptors 1/2 rather than
    // the reactor's named output files. Capture both channels for the caller.
    stdio.push(fs.openSync(path.join(temporary, 'stdin'), 'r'))
    stdio.push(fs.openSync(path.join(temporary, 'wasi-stdout'), 'w'))
    stdio.push(fs.openSync(path.join(temporary, 'wasi-stderr'), 'w'))
    wasi = new WASI({ version: 'preview1', args: [], env, preopens, returnOnExit: true, stdin: stdio[0], stdout: stdio[1], stderr: stdio[2] })
    for (let descriptor = 0; descriptor <= ioDescriptor; descriptor++) descriptors.add(descriptor)
    let instance
    let pathBuffer
    const pathCapacity = 65536
    const encode = value => {
      const bytes = Buffer.from(value)
      const pointer = instance.exports.malloc(bytes.length + 1)
      const target = new Uint8Array(instance.exports.memory.buffer, pointer, bytes.length + 1)
      target.set(bytes)
      target[bytes.length] = 0
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
      let rewritten = false
      if (args[descriptorIndex] === 3 && !path.posix.isAbsolute(filename) && !/^[A-Za-z]:\//.test(filename)) {
        // Resolve from the document directory through a root preopen so ../
        // resources and symlinks outside that directory keep working.
        // Preserve dot segments: resolving them lexically before following a
        // symlink can select a different file from the host filesystem.
        filename = `${guestPath(cwd).replace(/\/$/, '')}/${filename}`
        rewritten = true
      }
      // uvwasi normalizes .. lexically, unlike host filesystem traversal
      // through symlinks. Resolve the parent on the host before handing such
      // paths to WASI. Leave the final component intact for unlink/rename.
      if (filename.split('/').includes('..')) {
        let hostPath = process.platform === 'win32' ? filename.replace(/^\/([A-Za-z]:)/, '$1') : filename
        const descriptor = args[descriptorIndex]
        const base = descriptor === 3 ? cwd : roots[descriptor - 4]
        if (!path.isAbsolute(hostPath) && base !== undefined) hostPath = `${base}/${hostPath}`
        if (path.isAbsolute(hostPath)) {
          try {
            filename = guestPath(path.join(fs.realpathSync.native(path.dirname(hostPath)), path.basename(hostPath)))
            rewritten = true
          } catch (error) {
            // Do not let lexical normalization find a different file through
            // a missing parent or broken symlink. These are preview1 errnos.
            if (error.code === 'ENOENT') return 44
            if (error.code === 'ENOTDIR') return 54
            throw error
          }
        }
      }
      if (rewritten) {
        const encoded = Buffer.from(filename)
        if (encoded.length > pathCapacity) throw new Error('Pandoc resource path is too long.')
        const pointer = pathBuffer + slot * pathCapacity
        new Uint8Array(instance.exports.memory.buffer, pointer, encoded.length).set(encoded)
        args[pointerIndex] = pointer
        args[lengthIndex] = encoded.length
      }
      for (let index = 0; index < guestRoots.length; index++) {
        const root = guestRoots[index]
        const candidate = process.platform === 'win32' ? filename.toLowerCase() : filename
        const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
        const prefix = candidate.startsWith(normalizedRoot) ? root
          : process.platform === 'win32' && candidate.startsWith(normalizedRoot.slice(1)) ? root.slice(1) : undefined
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
      for (const [slot, indices] of (paths[name] || []).entries()) {
        const errno = adapt(args, ...indices, slot)
        if (errno !== undefined) return errno
      }
      const result = fn(...args)
      if (result === 0 && name === 'path_open') descriptors.add(new DataView(instance.exports.memory.buffer).getUint32(args[8], true))
      if (result === 0 && name === 'fd_close') descriptors.delete(args[0])
      return result
    }]))
    instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports })
    // GHC exports both CLI _start and the reactor functions. Initialize only
    // the reactor; invoking _start would enter the command-line program.
    wasi.initialize({ exports: { ...instance.exports, _start: undefined } })
    instance.exports.__wasm_call_ctors()
    // Two slots cover source and destination paths in link/rename syscalls.
    // Allocate once, never by reentering WASM from a syscall callback.
    pathBuffer = instance.exports.malloc(pathCapacity * 2)
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
    // Path adaptation belongs at the filesystem boundary; metadata and other
    // strings that happen to resemble Windows paths must remain unchanged.
    const [pointer, length] = encode(JSON.stringify(workerData.options))
    let failure = ''
    try {
      instance.exports[workerData.query ? 'query' : 'convert'](pointer, length)
    } catch (error) {
      // Keep diagnostics printed before a trap, signal, or Lua os.exit.
      failure = `ERROR: ${error instanceof Error ? error.message : String(error)}`
    }
    const combine = (...parts) => parts.filter(part => part !== '').join('\n')
    const stdout = combine(fs.readFileSync(path.join(temporary, 'stdout'), 'utf8'), fs.readFileSync(path.join(temporary, 'wasi-stdout'), 'utf8'))
    const reactorError = fs.readFileSync(path.join(temporary, 'stderr'), 'utf8')
    const stderr = combine(reactorError, fs.readFileSync(path.join(temporary, 'wasi-stderr'), 'utf8'), failure)
    const warnings = fs.readFileSync(path.join(temporary, 'warnings'), 'utf8')
    // A filter can write arbitrary diagnostics to native stderr, including
    // lines starting with ERROR:. Those alone do not make Pandoc fail.
    return { stdout, stderr, warnings, failed: failure !== '' || /^ERROR:/m.test(reactorError) }
  } finally {
    // Close any handles a failed conversion or Lua filter left open, including
    // preopen directories, before removing the temporary directory on Windows.
    if (wasi !== undefined) {
      for (const descriptor of descriptors) {
        try { wasi.wasiImport.fd_close(descriptor) } catch { /* Initialization may have failed. */ }
      }
    }
    for (const descriptor of stdio) {
      try { fs.closeSync(descriptor) } catch (error) {
        if (error.code !== 'EBADF') throw error // WASI may have already closed it.
      }
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

run().then(result => parentPort.postMessage(result)).catch(error => {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
}).finally(() => parentPort.close())
