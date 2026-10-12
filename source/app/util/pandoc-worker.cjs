/* eslint-disable @typescript-eslint/no-require-imports -- Copied as a standalone CommonJS worker. */
// Pandoc's reactor API uses defaults-file options and four named IO files.
// Run it in a worker so compilation and conversion do not block Electron.
const { parentPort, workerData } = require('node:worker_threads')
const { WASI } = require('node:wasi')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const createFilesystemPolicy = require('./pandoc-filesystem-policy.cjs')

const PASSTHROUGH_ENVIRONMENT = new Set(['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SOURCE_DATE_EPOCH'])
const NOT_CAPABLE = 76

function isWithin (filename, directory) {
  const relative = path.relative(directory, filename)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalPath (filename, followFinal = true) {
  // Keep dot-segments intact until realpath resolves symlink components. For
  // example, link/../file is not always the same as the lexical parent/file.
  const absolute = path.isAbsolute(filename) ? filename : `${process.cwd()}${path.sep}${filename}`
  if (!followFinal) {
    return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute))
  }
  let current = absolute
  const missing = []
  while (true) {
    try {
      // Resolve the existing prefix so symlink components retain host
      // filesystem semantics, then append only the not-yet-created suffix.
      return path.join(fs.realpathSync.native(current), ...missing)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      // A dangling symlink is an inaccessible path component, not a missing
      // directory that may safely be treated as a future destination.
      let componentExists = false
      try {
        fs.lstatSync(current)
        componentExists = true
      } catch (statError) {
        if (statError.code !== 'ENOENT' && statError.code !== 'ENOTDIR') throw statError
      }
      if (componentExists) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

class InvalidPandocModuleError extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvalidPandocModuleError'
  }
}

function invalidModuleError (message, error) {
  const detail = error instanceof Error ? ` ${error.message}` : ''
  return new InvalidPandocModuleError(`${message}${detail}`)
}

async function run () {
  let bytes
  try {
    bytes = fs.readFileSync(workerData.wasmPath)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new Error(`The cached Pandoc WASM module could not be read.${detail}`)
  }
  let module
  try {
    module = await WebAssembly.compile(bytes)
  } catch (error) {
    throw invalidModuleError('The downloaded Pandoc WASM module could not be compiled.', error)
  }
  const exports = WebAssembly.Module.exports(module)
  if (!exports.some(item => item.name === 'memory' && item.kind === 'memory') ||
    ['malloc', 'convert', 'query', '__wasm_call_ctors', 'hs_init_with_rtsopts'].some(name => !exports.some(item => item.name === name && item.kind === 'function'))) {
    throw new InvalidPandocModuleError('The downloaded module does not provide the Pandoc WASM API. Check the Pandoc download URL.')
  }
  let wasi
  const descriptors = new Set()
  const stdio = []
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zettlr-pandoc-'))
  try {
    // Queries retain private preopens; conversions use a replaceable policy.
    const cwd = canonicalPath(workerData.query ? temporary : path.resolve(workerData.cwd || process.cwd()))
    const policy = createFilesystemPolicy({ cwd, options: workerData.options, query: workerData.query })
    const roots = [...new Set(policy.roots.map(directory => canonicalPath(directory)))]
      .map(directory => ({ directory })).sort((a, b) => b.directory.length - a.directory.length)
    const guestPath = filename => process.platform === 'win32'
      ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1:')
      : filename
    const guestRoots = roots.map(root => guestPath(root.directory))
    // Preopen descriptors start at 3: cwd, filesystem roots, then private IO.
    const ioDescriptor = 4 + roots.length
    const preopens = { '.': cwd, ...Object.fromEntries(guestRoots.map((root, index) => [root, roots[index].directory])), '/__zettlr_io': temporary }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => PASSTHROUGH_ENVIRONMENT.has(key) && value !== undefined)
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
    const descriptorPaths = new Map([[3, cwd], ...roots.map((root, index) => [4 + index, root.directory]), [ioDescriptor, temporary]])
    const canAccess = (filename, write, operation, target) => policy.allows({
      path: filename, access: write ? 'write' : 'read', operation, target
    })
    const hostPath = (descriptor, filename) => {
      if (process.platform === 'win32') filename = filename.replaceAll('\\', '/').replace(/^\/([A-Za-z]:)/, '$1')
      const base = descriptorPaths.get(descriptor)
      if (path.isAbsolute(filename)) return filename
      if (base === undefined) return undefined
      // path.join normalizes `..` before the host filesystem follows symlinks.
      return `${base}${base.endsWith(path.sep) ? '' : path.sep}${filename}`
    }
    const resolvePath = (descriptor, filename, operation, args, slot) => {
      const unresolved = hostPath(descriptor, filename)
      if (unresolved === undefined) return NOT_CAPABLE

      const followsFinal = operation === 'path_link' ? slot === 0 && (args[1] & 1) !== 0
        : !['path_readlink', 'path_unlink_file', 'path_remove_directory', 'path_create_directory', 'path_rename', 'path_symlink'].includes(operation)
      const write = ['path_create_directory', 'path_filestat_set_times', 'path_unlink_file', 'path_remove_directory', 'path_rename'].includes(operation) ||
        operation === 'path_symlink' || (operation === 'path_link' && slot === 1) ||
        (operation === 'path_open' && (args[4] & 9) !== 0)
      if (operation === 'path_create_directory') {
        try {
          if (fs.statSync(unresolved).isDirectory()) {
            const directory = fs.realpathSync.native(unresolved)
            // mkdir -p on an existing directory performs no mutation. A
            // read-only policy must still permit writes to an allowed file
            // inside an already-existing parent directory.
            if (canAccess(directory, false, 'path_filestat_get') ||
              canAccess(directory, true, operation)) return { noOp: true }
          }
        } catch { /* Missing directories continue through normal resolution. */ }
      }
      let resolved
      try {
        resolved = canonicalPath(unresolved, followsFinal)
      } catch (error) {
        if (error.code === 'ENOENT') return 44
        if (error.code === 'ENOTDIR') return 54
        throw error
      }
      const target = operation === 'path_symlink'
        ? Buffer.from(instance.exports.memory.buffer, args[0], args[1]).toString() : undefined
      return canAccess(resolved, write, operation, target) ? { path: resolved, write } : NOT_CAPABLE
    }

    const adapt = (args, descriptorIndex, pointerIndex, lengthIndex, slot, operation) => {
      const bytes = new Uint8Array(instance.exports.memory.buffer, args[pointerIndex], args[lengthIndex])
      let filename = Buffer.from(bytes).toString()
      if (process.platform === 'win32') {
        filename = filename.replaceAll('\\', '/')
      }
      if (reserved.has(filename)) {
        args[descriptorIndex] = ioDescriptor
        return operation === 'path_open' ? { openedPath: path.join(temporary, filename) } : undefined
      }
      const access = resolvePath(args[descriptorIndex], filename, operation, args, slot)
      if (typeof access === 'number') return access
      if (access.noOp === true) return access
      const { path: resolved, write } = access
      if (operation === 'path_open') {
        // WASI preview1 rights that permit writes or filesystem mutation.
        const writeRights = (1n << 0n) | (1n << 4n) | (1n << 6n) | (1n << 8n) | (1n << 9n) |
          (1n << 10n) | (1n << 11n) | (1n << 12n) | (1n << 16n) | (1n << 17n) |
          (1n << 19n) | (1n << 20n) | (1n << 22n) | (1n << 23n) | (1n << 24n) |
          (1n << 25n) | (1n << 26n)
        const createsOrTruncates = write
        if (!canAccess(resolved, true, operation)) {
          if (createsOrTruncates) return NOT_CAPABLE
          // Some runtimes request broad rights even for a read-only open.
          // Restrict the resulting descriptor rather than denying the open;
          // subsequent fd_write/mutation calls will then fail at WASI itself.
          args[5] = BigInt(args[5]) & ~writeRights
          args[6] = BigInt(args[6]) & ~writeRights
        }
      }

      const rootIndex = roots.findIndex(root => isWithin(resolved, root.directory))
      if (rootIndex === -1) return NOT_CAPABLE
      const relative = path.relative(roots[rootIndex].directory, resolved) || '.'
      const encoded = Buffer.from(guestPath(relative))
      if (encoded.length > pathCapacity) throw new Error('Pandoc resource path is too long.')
      const pointer = pathBuffer + slot * pathCapacity
      new Uint8Array(instance.exports.memory.buffer, pointer, encoded.length).set(encoded)
      args[descriptorIndex] = 4 + rootIndex
      args[pointerIndex] = pointer
      args[lengthIndex] = encoded.length
      return operation === 'path_open' ? { openedPath: resolved } : undefined
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
      if (name === 'fd_readdir') {
        const directory = descriptorPaths.get(args[0])
        if (directory !== undefined && !canAccess(directory, false, name)) return NOT_CAPABLE
      }
      let openedPath
      let noOp = false
      for (const [slot, indices] of (paths[name] || []).entries()) {
        const result = adapt(args, ...indices, slot, name)
        if (typeof result === 'number') return result
        if (result?.openedPath !== undefined) openedPath = result.openedPath
        if (result?.noOp === true) noOp = true
      }
      if (noOp) return 0
      const result = fn(...args)
      if (result === 0 && name === 'path_open') {
        const descriptor = new DataView(instance.exports.memory.buffer).getUint32(args[8], true)
        descriptors.add(descriptor)
        if (openedPath !== undefined) descriptorPaths.set(descriptor, openedPath)
      }
      if (result === 0 && name === 'fd_close') {
        descriptors.delete(args[0])
        descriptorPaths.delete(args[0])
      }
      if (result === 0 && name === 'fd_renumber') {
        const [source, destination] = args
        if (source !== destination) {
          if (descriptorPaths.has(source)) {
            descriptorPaths.set(destination, descriptorPaths.get(source))
            descriptorPaths.delete(source)
          }
          if (descriptors.delete(source)) descriptors.add(destination)
        }
      }
      return result
    }]))
    try {
      instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: imports })
      // GHC exports both CLI _start and the reactor functions. Initialize only
      // the reactor; invoking _start would enter the command-line program.
      wasi.initialize({ exports: { ...instance.exports, _start: undefined } })
      instance.exports.__wasm_call_ctors()
    } catch (error) {
      throw invalidModuleError('The downloaded Pandoc WASM module could not be initialized.', error)
    }
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
    try {
      instance.exports.hs_init_with_rtsopts(argcPointer, argvReference)
    } catch (error) {
      throw invalidModuleError('The downloaded Pandoc WASM runtime could not be initialized.', error)
    }
    let version
    if (!workerData.query) {
      // Static exports are not enough to establish that an arbitrary module is
      // Pandoc. Require its reactor query to return a plausible version before
      // accepting it as a converter.
      const [versionPointer, versionLength] = encode(JSON.stringify({ query: 'version' }))
      try {
        instance.exports.query(versionPointer, versionLength)
      } catch (error) {
        throw invalidModuleError('The downloaded module could not answer the Pandoc version query.', error)
      }
      const queryError = fs.readFileSync(path.join(temporary, 'stderr'), 'utf8')
      const queryOutput = fs.readFileSync(path.join(temporary, 'stdout'), 'utf8')
      try { version = queryError === '' ? JSON.parse(queryOutput) : undefined } catch { version = undefined }
      if (typeof version !== 'string' || !/^\d+\.\d+/.test(version)) {
        throw new InvalidPandocModuleError('The downloaded module did not return a valid Pandoc version.')
      }
      for (const filename of reserved) fs.writeFileSync(path.join(temporary, filename), '')
    }
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
    return { stdout, stderr, warnings, failed: failure !== '' || /^ERROR:/m.test(reactorError), version }
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
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error),
    invalidModule: error instanceof InvalidPandocModuleError
  })
}).finally(() => parentPort.close())
