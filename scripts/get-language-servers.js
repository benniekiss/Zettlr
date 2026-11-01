/** Download pinned stdio server distributions for Electron Forge packaging. */
const fs = require('node:fs/promises')
const { createReadStream, createWriteStream } = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const AdmZip = require('adm-zip')
const releases = require('./lsp-servers.json')

const switches = { panache: 'BUNDLE_PANACHE', codebook: 'BUNDLE_CODEBOOK', 'ltex-plus': 'BUNDLE_LTEX_PLUS' }

function enabledServers (env = process.env) {
  return env.BUNDLE_LSP === '0' ? [] : Object.keys(releases).filter(name => env[switches[name]] !== '0')
}

function releaseFor (name, platform, arch) {
  const release = releases[name]
  const target = release?.targets[`${platform}-${arch}`]
  if (target === undefined) throw new Error(`No bundled ${name} release for ${platform}/${arch}`)
  return { ...release, ...target, url: `https://github.com/${release.repository}/releases/download/${release.tag}/${target.asset}` }
}

async function sha256 (file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadArchive (release, archive) {
  // Recheck cached archives, including after an interrupted or corrupted download.
  try {
    if (await sha256(archive) === release.sha256) return
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const temporary = `${archive}.part-${randomUUID()}`
  try {
    const response = await fetch(release.url, { signal: AbortSignal.timeout(300000) })
    if (!response.ok || response.body === null) throw new Error(`Download failed (${response.status}): ${release.url}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }))
    if (await sha256(temporary) !== release.sha256) throw new Error(`Checksum mismatch: ${release.asset}`)
    await fs.rename(temporary, archive)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function extractArchive (archive, destination) {
  await fs.mkdir(destination, { recursive: true })
  if (archive.endsWith('.zip')) {
    new AdmZip(archive).extractAllTo(destination, true)
  } else {
    await promisify(execFile)('tar', [ '-xzf', archive, '-C', destination ], { windowsHide: true })
  }
}

async function findFile (directory, predicate) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isFile() && predicate(file)) return file
    if (entry.isDirectory()) {
      const found = await findFile(file, predicate)
      if (found !== undefined) return found
    }
  }
}

async function validCache (directory, expected) {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'bundle.json'), 'utf8'))
    if (metadata.sha256 !== expected.sha256 || metadata.platform !== expected.platform || metadata.arch !== expected.arch || metadata.version !== expected.version) return false
    if (!(await fs.stat(path.join(directory, metadata.executable))).isFile()) return false
    if (metadata.libraryDirectory !== undefined && !(await fs.stat(path.join(directory, metadata.libraryDirectory))).isDirectory()) return false
    return true
  } catch (err) { return false }
}

async function prepareServer (name, platform, arch, targetDirectory, download) {
  const release = releaseFor(name, platform, arch)
  const expected = { version: release.version, sha256: release.sha256, platform, arch }
  const cached = path.join(targetDirectory, 'cache', `${name}-${release.version}-${release.sha256.slice(0, 12)}`)
  if (await validCache(cached, expected)) return cached
  console.log(`[LSP] Preparing ${name} ${release.version} for ${platform}/${arch}`)
  const archive = path.join(targetDirectory, 'archives', release.asset)
  await fs.mkdir(path.dirname(archive), { recursive: true })
  await download(release, archive)
  const temporary = await fs.mkdtemp(path.join(targetDirectory, 'extract-'))
  try {
    await extractArchive(archive, temporary)
    const entries = await fs.readdir(temporary, { withFileTypes: true })
    // Preserve complete distributions, including licenses and the embedded JRE.
    const root = entries.length === 1 && entries[0].isDirectory() ? path.join(temporary, entries[0].name) : temporary
    const executable = await findFile(root, file => path.basename(file) === `${release.executable}${platform === 'win32' ? '.exe' : ''}`)
    if (executable === undefined) throw new Error(`${release.asset} has no ${release.executable} executable`)
    if (platform !== 'win32') await fs.chmod(executable, 0o755)
    const metadata = { ...expected, executable: path.relative(root, executable).split(path.sep).join('/') }
    if (name === 'ltex-plus') {
      const jar = await findFile(root, file => path.basename(file) === `ltexls-plus-${release.version}.jar`)
      if (jar === undefined) throw new Error(`${release.asset} has no LTeX+ server JAR`)
      metadata.libraryDirectory = path.relative(root, path.dirname(jar)).split(path.sep).join('/')
      metadata.mainClass = release.mainClass
    }
    await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(metadata, null, 2) + '\n')
    await fs.mkdir(path.dirname(cached), { recursive: true })
    await fs.rm(cached, { recursive: true, force: true })
    await fs.rename(root, cached)
    return cached
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function bundleLanguageServers ({ platform, arch, resourcesDirectory = path.join(__dirname, '../resources'), env = process.env, download = downloadArchive }) {
  const enabled = enabledServers(env)
  if (enabled.length === 0) return undefined
  if (![ 'darwin', 'linux', 'win32' ].includes(platform) || ![ 'x64', 'arm64' ].includes(arch)) {
    console.warn(`[LSP] Unsupported target ${platform}/${arch}; language servers will not be bundled`)
    return undefined
  }
  const targetDirectory = path.join(resourcesDirectory, 'lsp', `${platform}-${arch}`)
  await fs.mkdir(targetDirectory, { recursive: true })
  const staging = await fs.mkdtemp(path.join(targetDirectory, 'bundle-'))
  const destination = path.join(targetDirectory, 'language-servers')
  try {
    for (const name of enabled) {
      const cached = await prepareServer(name, platform, arch, targetDirectory, download)
      await fs.cp(cached, path.join(staging, name), { recursive: true, dereference: false, verbatimSymlinks: true })
    }
    // Assemble only enabled servers, even when an earlier build bundled more.
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(staging, destination)
    return destination
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
}

async function configureLanguageServerResources (forgeConfig, platform, arch, options = {}) {
  const resourceRoot = path.resolve(options.resourcesDirectory ?? path.join(__dirname, '../resources'), 'lsp') + path.sep
  forgeConfig.packagerConfig.extraResource = (forgeConfig.packagerConfig.extraResource ?? []).filter(resource =>
    typeof resource !== 'string' || !path.resolve(resource).startsWith(resourceRoot))
  const directory = await bundleLanguageServers({ ...options, platform, arch })
  if (directory !== undefined) forgeConfig.packagerConfig.extraResource.push(directory)
  return directory
}

module.exports = { enabledServers, releaseFor, downloadArchive, extractArchive, bundleLanguageServers, configureLanguageServerResources }

if (require.main === module) {
  const [ platform = process.platform, arch = process.arch ] = process.argv.slice(2)
  bundleLanguageServers({ platform, arch }).then(directory => {
    console.log(directory === undefined ? '[LSP] Bundling disabled or unsupported target' : `[LSP] Ready: ${directory}`)
  }).catch(err => { console.error(err); process.exitCode = 1 })
}
