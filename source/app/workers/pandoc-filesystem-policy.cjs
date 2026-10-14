/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by the standalone CommonJS worker. */
const fs = require('node:fs')
const path = require('node:path')

/**
 * Replaceable filesystem policy for the WASI adapter.
 *
 * roots supplies host directories to preopen. allows receives a canonical
 * host path, WASI operation, and access ('read' or 'write'); symlink requests
 * also include target. The adapter checks both sides of link/rename operations
 * and removes mutation rights from descriptors for read-only paths.
 *
 * The desktop default delegates filesystem permissions to the OS account.
 * Future restricted policies can change these hooks without changing the
 * reactor, path translation, or native-import wrappers.
 */
module.exports = function createFilesystemPolicy ({ cwd, options, query }) {
  if (query) return { roots: [cwd], allows: () => true }

  const roots = new Set([path.parse(cwd).root])
  if (process.platform === 'win32') {
    // Windows has no single filesystem root. Include mounted drives and UNC
    // shares referenced by the profile, in addition to the working share.
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`
      if (fs.existsSync(root)) roots.add(root)
    }
    const visited = new Set()
    const collectRoots = value => {
      if (typeof value === 'string' && path.isAbsolute(value)) {
        roots.add(path.parse(value).root)
      } else if (value !== null && typeof value === 'object' && !visited.has(value)) {
        visited.add(value)
        for (const entry of Object.values(value)) collectRoots(entry)
      }
    }
    collectRoots(options)
  }
  return { roots: [...roots], allows: () => true }
}
