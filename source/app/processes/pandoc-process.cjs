/* eslint-disable @typescript-eslint/no-require-imports -- Copied as a standalone CommonJS process entry. */
// Pandoc's reactor API uses defaults-file options and four named IO files.
// Run it in a disposable process so conversion cannot block Electron.
const { WASI } = require('node:wasi')
const fs = require('node:fs')
const path = require('node:path')

const filesystemRoots = require('./pandoc-filesystem-roots.cjs')

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

async function run (job) {
  let bytes
  try {
    bytes = fs.readFileSync(job.wasmPath)
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
  // The parent owns this directory and removes it after process exit, when
  // the OS has closed all native WASI handles (including on failure/timeout).
  const temporary = job.temporaryDirectory
  // Queries retain private preopens; conversions use the host filesystem roots.
  const cwd = canonicalPath(job.query ? temporary : path.resolve(job.cwd || process.cwd()))
  const roots = [...new Set(filesystemRoots({ cwd, options: job.options, query: job.query })
    .map(directory => canonicalPath(directory)))]
    .map(directory => ({ directory })).sort((a, b) => b.directory.length - a.directory.length)
  const guestPath = filename => process.platform === 'win32'
    ? filename.replaceAll('\\', '/').replace(/^([A-Za-z]):/, '/$1:')
    : filename
  const guestRoots = roots.map(root => job.query ? '/' : guestPath(root.directory))
  // wasi-libc resolves the reactor's absolute /stdin, /stdout, /stderr,
  // and /warnings against '/', or falls back to '.' on Windows.
  const reactorDescriptor = guestRoots.includes('/') ? 4 + guestRoots.indexOf('/') : 3
  // Preopen descriptors start at 3: cwd, filesystem roots, then private IO.
  const ioDescriptor = 4 + roots.length
  const preopens = { '.': cwd, ...Object.fromEntries(guestRoots.map((root, index) => [root, roots[index].directory])), '/__zettlr_io': temporary }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => PASSTHROUGH_ENVIRONMENT.has(key) && value !== undefined)
    .map(([key, value]) => [key, /^[A-Za-z]:[\\/]/.test(value) ? guestPath(value) : value]))
  env.PWD = job.query ? '/' : guestPath(cwd)
  const reserved = new Set(['stdin', 'stdout', 'stderr', 'warnings'])
  for (const filename of reserved) fs.writeFileSync(path.join(temporary, filename), '')
  // Lua print/io.stderr and RTS diagnostics use descriptors 1/2 rather than
  // the reactor's named output files. Capture both channels for the caller.
  const wasi = new WASI({
    version: 'preview1', args: [], env, preopens, returnOnExit: true,
    stdin: fs.openSync(path.join(temporary, 'stdin'), 'r'),
    stdout: fs.openSync(path.join(temporary, 'wasi-stdout'), 'w'),
    stderr: fs.openSync(path.join(temporary, 'wasi-stderr'), 'w')
  })
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
    let resolved
    try {
      resolved = canonicalPath(unresolved, followsFinal)
    } catch (error) {
      if (error.code === 'ENOENT') return 44
      if (error.code === 'ENOTDIR') return 54
      throw error
    }
    return { path: resolved }
  }

  const adapt = (args, descriptorIndex, pointerIndex, lengthIndex, slot, operation) => {
    const bytes = new Uint8Array(instance.exports.memory.buffer, args[pointerIndex], args[lengthIndex])
    let filename = Buffer.from(bytes).toString()
    if (process.platform === 'win32') {
      filename = filename.replaceAll('\\', '/')
    }
    if (args[descriptorIndex] === reactorDescriptor && reserved.has(filename)) {
      args[descriptorIndex] = ioDescriptor
      return operation === 'path_open' ? { openedPath: path.join(temporary, filename) } : undefined
    }
    const access = resolvePath(args[descriptorIndex], filename, operation, args, slot)
    if (typeof access === 'number') return access
    const { path: resolved } = access
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
    let openedPath
    for (const [slot, indices] of (paths[name] || []).entries()) {
      const result = adapt(args, ...indices, slot, name)
      if (typeof result === 'number') return result
      if (result?.openedPath !== undefined) openedPath = result.openedPath
    }
    const result = fn(...args)
    if (result === 0 && name === 'path_open') {
      const descriptor = new DataView(instance.exports.memory.buffer).getUint32(args[8], true)
      if (openedPath !== undefined) descriptorPaths.set(descriptor, openedPath)
    }
    if (result === 0 && name === 'fd_close') {
      descriptorPaths.delete(args[0])
    }
    if (result === 0 && name === 'fd_renumber') {
      const [source, destination] = args
      if (source !== destination) {
        if (descriptorPaths.has(source)) {
          descriptorPaths.set(destination, descriptorPaths.get(source))
          descriptorPaths.delete(source)
        }
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
  if (!job.query) {
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
  const [pointer, length] = encode(JSON.stringify(job.options))
  let failure = ''
  try {
    instance.exports[job.query ? 'query' : 'convert'](pointer, length)
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
}

const port = process.parentPort
let started = false

function send (message) {
  if (port) port.postMessage(message)
  else process.send(message)
}

function receive (message) {
  if (message.acknowledgement === true) process.exit(0)
  if (started) return
  started = true
  run(message).catch(error => ({
    error: error instanceof Error ? error.message : String(error),
    invalidModule: error instanceof InvalidPandocModuleError
  })).then(send)
}

if (port) port.on('message', event => receive(event.data))
else process.on('message', receive)
