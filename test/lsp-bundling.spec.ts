import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { enabledServers, releaseFor, downloadArchive, bundleLanguageServers, configureLanguageServerResources } from '../scripts/get-language-servers'
import { resolveLanguageServerCommand } from '../source/app/service-providers/lsp/bundled-servers'
import type { LanguageServerConfig } from '../source/common/lsp/config'

const server = (command: string, args: string[] = []): LanguageServerConfig => ({ name: command, command, args, languages: ['markdown'] })

describe('Language server bundling', function () {
  // Copying complete server dependency trees can exceed Mocha's default two
  // seconds on CI. Allow the copies to finish before cleanup starts.
  this.timeout(30000)

  let temporary: string
  beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-lsp-bundle-test-')) })
  afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }) })

  it('pins checksummed archives for every supported OS and architecture', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        for (const name of enabledServers({}).filter(name => name !== 'yaml')) {
          const release = releaseFor(name, platform, arch)
          assert.match(release.sha256, /^[a-f0-9]{64}$/)
          assert(release.url.includes(`/releases/download/${release.tag}/`))
          assert(release.asset.endsWith(platform === 'win32' ? '.zip' : '.tar.gz'))
          if (name === 'ltex-plus') assert(!release.asset.endsWith('-src.tar.gz'))
        }
      }
    }
    assert.throws(() => releaseFor('panache', 'linux', 'ia32'), /No bundled/)
  })

  it('supports independent global and per-server build switches', () => {
    assert.deepStrictEqual(enabledServers({ BUNDLE_LSP: '0' }), [])
    assert.deepStrictEqual(enabledServers({ PANDOC_WASM_URL: 'none' }), ['yaml', 'panache', 'codebook', 'ltex-plus'])
    assert.deepStrictEqual(enabledServers({ BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' }), ['yaml', 'panache'])
    assert.deepStrictEqual(enabledServers({ BUNDLE_PANACHE: '0' }), ['yaml', 'codebook', 'ltex-plus'])
    assert.deepStrictEqual(enabledServers({ BUNDLE_YAML_SERVER: '0' }), ['panache', 'codebook', 'ltex-plus'])
  })

  async function archiveFixture (release: any, archive: string): Promise<void> {
    const zip = new AdmZip()
    const executable = release.mainClass === undefined ? `distribution/${release.executable}.exe` : 'distribution/runtime/bin/java.exe'
    zip.addFile(executable, Buffer.from('executable'))
    zip.addFile('distribution/LICENSE', Buffer.from('license notice'))
    if (release.mainClass !== undefined) zip.addFile(`distribution/lib/ltexls-plus-${release.version}.jar`, Buffer.from('server jar'))
    zip.writeZip(archive)
  }

  it('preserves complete distributions, caches downloads, and excludes disabled servers from repeated builds', async () => {
    let downloads = 0
    const download = async (release: any, archive: string): Promise<void> => { downloads++; await archiveFixture(release, archive) }
    const options = { platform: 'win32', arch: 'x64', resourcesDirectory: temporary, env: {}, download }
    const directory = await bundleLanguageServers(options)
    assert(directory !== undefined)
    assert.strictEqual(downloads, 3)
    for (const name of enabledServers({}).filter(name => name !== 'yaml')) assert.strictEqual(await fs.readFile(path.join(directory, name, 'LICENSE'), 'utf8'), 'license notice')
    const native = await resolveLanguageServerCommand(server('panache', ['lsp']), true, [directory], 'win32', 'x64')
    assert.strictEqual(native.command, path.join(directory, 'panache', 'panache.exe'))
    assert.deepStrictEqual(native.args, ['lsp'])
    const ltex = await resolveLanguageServerCommand(server('ltex-ls-plus', ['--help']), true, [directory], 'win32', 'x64')
    assert.strictEqual(ltex.command, path.join(directory, 'ltex-plus', 'runtime', 'bin', 'java.exe'))
    assert.deepStrictEqual(ltex.args, [ `-Dapp.home=${path.join(directory, 'ltex-plus')}`, '-cp', path.join(directory, 'ltex-plus', 'lib', '*'), 'org.bsplines.ltexls.LtexLanguageServerLauncher', '--help' ])
    await bundleLanguageServers({ ...options, env: { BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' } })
    assert.strictEqual(downloads, 3)
    assert.deepStrictEqual(await fs.readdir(directory), ['panache', 'yaml'])
    assert.strictEqual((await resolveLanguageServerCommand(server('codebook-lsp', ['serve']), true, [directory], 'win32', 'x64')).bundled, false)
  })

  it('materializes macOS JDK license links on fresh and cached builds', async () => {
    const fixture = path.join(temporary, 'fixture')
    const root = path.join(fixture, 'distribution')
    const legal = path.join(root, 'jdk/legal')
    await fs.mkdir(path.join(root, 'jdk/bin'), { recursive: true })
    await fs.mkdir(path.join(root, 'lib'), { recursive: true })
    await fs.mkdir(path.join(legal, 'java.base'), { recursive: true })
    await fs.mkdir(path.join(legal, 'java.management.rmi'), { recursive: true })
    await fs.writeFile(path.join(root, 'jdk/bin/java'), 'executable', { mode: 0o755 })
    await fs.writeFile(path.join(root, 'lib/ltexls-plus-18.7.0.jar'), 'server jar')
    await fs.writeFile(path.join(legal, 'java.base/LICENSE'), 'Java license notice')
    await fs.symlink('../java.base/LICENSE', path.join(legal, 'java.management.rmi/LICENSE'))
    const options = {
      platform: 'darwin', arch: 'arm64', resourcesDirectory: temporary,
      env: { BUNDLE_YAML_SERVER: '0', BUNDLE_PANACHE: '0', BUNDLE_CODEBOOK: '0' },
      download: async (_release: unknown, archive: string) => {
        await promisify(execFile)('tar', ['-czf', archive, '-C', fixture, 'distribution'])
      }
    }
    for (let build = 0; build < 2; build++) {
      const directory = await bundleLanguageServers(options)
      assert(directory !== undefined)
      const license = path.join(directory, 'ltex-plus/jdk/legal/java.management.rmi/LICENSE')
      assert.strictEqual((await fs.lstat(license)).isSymbolicLink(), false)
      assert.strictEqual(await fs.readFile(license, 'utf8'), 'Java license notice')
      const relocated = path.join(temporary, `relocated-${build}`)
      await fs.rename(directory, relocated)
      assert.strictEqual(await fs.readFile(path.join(relocated, 'ltex-plus/jdk/legal/java.management.rmi/LICENSE'), 'utf8'), 'Java license notice')
    }
  })

  it('does not download when bundling is disabled or the target is unsupported', async () => {
    const download = async (): Promise<never> => { throw new Error('Unexpected download') }
    assert.strictEqual(await bundleLanguageServers({ platform: 'linux', arch: 'arm64', resourcesDirectory: temporary, env: { BUNDLE_LSP: '0' }, download }), undefined)
    assert.strictEqual(await bundleLanguageServers({ platform: 'linux', arch: 'ia32', resourcesDirectory: temporary, env: {}, download }), undefined)
    assert.deepStrictEqual(await fs.readdir(temporary), [])
  })

  it('replaces its Forge resources on target changes and removes them when disabled', async () => {
    const forgeConfig = { packagerConfig: { extraResource: ['resources/icons/icon.icns'] } }
    const options = { resourcesDirectory: temporary, env: { BUNDLE_YAML_SERVER: '0', PANDOC_WASM_URL: 'none', BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' }, download: archiveFixture }
    const first = await configureLanguageServerResources(forgeConfig, 'win32', 'x64', options)
    assert.deepStrictEqual(forgeConfig.packagerConfig.extraResource, ['resources/icons/icon.icns', first])
    const second = await configureLanguageServerResources(forgeConfig, 'win32', 'arm64', options)
    assert.deepStrictEqual(forgeConfig.packagerConfig.extraResource, ['resources/icons/icon.icns', second])
    await configureLanguageServerResources(forgeConfig, 'win32', 'arm64', { ...options, env: { BUNDLE_LSP: '0' } })
    assert.deepStrictEqual(forgeConfig.packagerConfig.extraResource, ['resources/icons/icon.icns'])
  })

  it('leaves system commands and explicit executable paths unchanged when requested', async () => {
    const directory = await bundleLanguageServers({ platform: 'win32', arch: 'x64', resourcesDirectory: temporary, env: {}, download: archiveFixture })
    assert(directory !== undefined)
    assert.deepStrictEqual(await resolveLanguageServerCommand(server('panache', ['lsp']), false, [directory], 'win32', 'x64'), { command: 'panache', args: ['lsp'], bundled: false })
    assert.strictEqual((await resolveLanguageServerCommand(server('/custom/panache', ['lsp']), true, [directory], 'win32', 'x64')).command, '/custom/panache')
    assert.strictEqual((await resolveLanguageServerCommand(server('C:\\custom\\panache.exe'), true, [directory], 'win32', 'x64')).command, 'C:\\custom\\panache.exe')
    assert.strictEqual((await resolveLanguageServerCommand(server('custom-server'), true, [directory], 'win32', 'x64')).command, 'custom-server')
    assert.strictEqual((await resolveLanguageServerCommand(server('panache'), true, [directory], 'win32', 'arm64')).bundled, false)
    assert.strictEqual((await resolveLanguageServerCommand(server('PANACHE.EXE'), true, [directory], 'win32', 'x64')).bundled, true)
  })

  it('bundles YAML Language Server as a utility-process package without downloading an archive', async () => {
    const directory = await bundleLanguageServers({ platform: process.platform, arch: process.arch, resourcesDirectory: temporary, env: { BUNDLE_PANACHE: '0', BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' } })
    assert(directory !== undefined)
    const worker = path.join(directory, 'yaml', 'worker.cjs')
    assert.strictEqual((await fs.stat(worker)).isFile(), true)
    const yamlPackage = path.join(directory, 'yaml', 'node_modules', 'yaml-language-server')
    const yamlMetadata = JSON.parse(await fs.readFile(path.join(yamlPackage, 'package.json'), 'utf8'))
    const bundledRequire = createRequire(path.join(yamlPackage, 'package.json'))
    for (const dependency of Object.keys(yamlMetadata.dependencies)) {
      assert.doesNotThrow(() => bundledRequire.resolve(dependency), `Missing bundled dependency ${dependency}`)
    }
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'yaml', 'bundle.json'), 'utf8'))
    assert.strictEqual(metadata.runtime, 'utility-process')
    assert.strictEqual(metadata.version, '1.24.0')
    const configured = server('yaml-language-server', ['--stdio'])
    const system = await resolveLanguageServerCommand(configured, false, [directory], process.platform, process.arch)
    assert.deepStrictEqual(system.args, ['--stdio'])
    const bundled = await resolveLanguageServerCommand(configured, true, [directory], process.platform, process.arch)
    assert.strictEqual(bundled.bundled, true)
    assert.strictEqual(bundled.utilityProcess, true)
    assert.deepStrictEqual(bundled.args, ['--node-ipc'])
  })

  it('ignores incomplete or invalid bundles and never traverses outside their directory', async () => {
    const root = path.join(temporary, 'panache')
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, 'bundle.json'), '{broken')
    assert.strictEqual((await resolveLanguageServerCommand(server('panache'), true, [temporary], 'linux', 'arm64')).bundled, false)
    await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify({ platform: 'linux', arch: 'arm64', executable: '../external' }))
    await fs.writeFile(path.join(temporary, 'external'), 'executable')
    assert.strictEqual((await resolveLanguageServerCommand(server('panache'), true, [temporary], 'linux', 'arm64')).bundled, false)
  })

  it('verifies downloads and corrupted caches and rejects checksum mismatches before extraction', async () => {
    const originalFetch = global.fetch
    const bytes = Buffer.from('trusted archive')
    const release = { url: 'https://example.invalid/archive.zip', asset: 'archive.zip', sha256: createHash('sha256').update(bytes).digest('hex') }
    const archive = path.join(temporary, 'archive.zip')
    let downloads = 0
    global.fetch = async () => { downloads++; return new Response(bytes) }
    try {
      await downloadArchive(release, archive)
      await downloadArchive(release, archive)
      assert.strictEqual(downloads, 1)
      await fs.writeFile(archive, 'corrupted cache')
      await downloadArchive(release, archive)
      assert.strictEqual(downloads, 2)
      assert.deepStrictEqual(await fs.readFile(archive), bytes)
      await assert.rejects(downloadArchive({ ...release, sha256: '0'.repeat(64) }, archive), /Checksum mismatch/)
      assert.deepStrictEqual(await fs.readFile(archive), bytes)
      assert.deepStrictEqual(await fs.readdir(temporary), ['archive.zip'])
    } finally { global.fetch = originalFetch }
  })
})
