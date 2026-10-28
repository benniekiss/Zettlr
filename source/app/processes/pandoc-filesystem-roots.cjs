/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by the standalone CommonJS process. */
const fs = require('node:fs')
const path = require('node:path')

/** Host roots needed for native path access; version queries stay private. */
module.exports = function filesystemRoots ({ cwd, options, query }) {
  if (query) return [cwd]

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
        const root = path.parse(value).root
        // Options can contain path-like metadata. An unavailable incidental
        // share must not prevent conversion; actual missing resources still fail.
        if (!roots.has(root) && fs.existsSync(root)) roots.add(root)
      } else if (value !== null && typeof value === 'object' && !visited.has(value)) {
        visited.add(value)
        for (const entry of Object.values(value)) collectRoots(entry)
      }
    }
    collectRoots(options)
  }
  return [...roots]
}
