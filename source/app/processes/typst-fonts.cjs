/* eslint-disable @typescript-eslint/no-require-imports -- Shared with the standalone Typst process. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const supported = /\.(otf|ttf|ttc|otc)$/i

function fontFiles (directory, { strict = false, visited = new Set() } = {}) {
  try {
    const real = fs.realpathSync(directory)
    if (visited.has(real)) return []
    visited.add(real)
    return fs.readdirSync(real).flatMap(name => {
      const filename = path.join(real, name)
      try {
        const stat = fs.statSync(filename)
        if (stat.isDirectory()) return fontFiles(filename, { visited })
        return stat.isFile() && supported.test(name) ? [fs.realpathSync(filename)] : []
      } catch { return [] }
    })
  } catch (error) {
    if (strict) throw error
    return []
  }
}

function systemFontRoots (platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return [
    path.join(env.WINDIR || 'C:\\Windows', 'Fonts'),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft/Windows/Fonts')] : [])
  ]
  if (platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library/Fonts')]
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'),
    ...[env.XDG_DATA_HOME || path.join(home, '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')]
      .filter(Boolean).map(root => path.join(root, 'fonts'))]
}

function systemFontFiles () {
  // Fontconfig includes user-configured font directories. Other platforms and
  // systems without fontconfig use their standard system/user font locations.
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    try {
      const files = execFileSync('fc-list', ['--format=%{file}\\n'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(filename => supported.test(filename))
      if (files.length > 0) return [...new Set(files)]
    } catch { /* Fall back to scanning standard directories. */ }
  }
  const visited = new Set()
  return [...new Set(systemFontRoots().flatMap(directory => fontFiles(directory, { visited })))]
}

/** Reuse metadata for unchanged files, keeping only the currently discovered fonts. */
function collectFontMetadata (filenames, previous, parse) {
  const metadata = {}
  for (const filename of filenames) {
    try {
      const stat = fs.statSync(filename, { bigint: true })
      if (!stat.isFile()) continue
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      const cached = previous?.[filename]
      const info = cached?.signature === signature ? cached.info : parse(fs.readFileSync(filename))
      if (info?.info?.length) metadata[filename] = { signature, info }
    } catch { /* Missing, unreadable, or invalid fonts are skipped. */ }
  }
  return metadata
}

module.exports = { fontFiles, systemFontFiles, systemFontRoots, collectFontMetadata }
