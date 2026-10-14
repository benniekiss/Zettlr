import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { enabledServers, releaseFor, downloadArchive, bundleLanguageServers, configureLanguageServerResources } from '../scripts/get-language-servers'
import { resolveLanguageServerCommand } from '../source/app/service-providers/lsp/bundled-servers'
import type { LanguageServerConfig } from '../source/common/lsp/config'

const server = (command: string, args: string[] = []): LanguageServerConfig => ({ name: command, command, args, languages: ['markdown'] })

describe('Language server bundling', () => {
  let temporary: string
  beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-lsp-bundle-test-')) })
  afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }) })

  it('pins checksummed archives for every supported OS and architecture', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        for (const name of enabledServers({})) {
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
    assert.deepStrictEqual(enabledServers({ BUNDLE_PANDOC: '0' }), ['panache', 'codebook', 'ltex-plus'])
    assert.deepStrictEqual(enabledServers({ BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' }), ['panache'])
    assert.deepStrictEqual(enabledServers({ BUNDLE_PANACHE: '0' }), ['codebook', 'ltex-plus'])
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
    for (const name of enabledServers({})) assert.strictEqual(await fs.readFile(path.join(directory, name, 'LICENSE'), 'utf8'), 'license notice')
    const native = await resolveLanguageServerCommand(server('panache', ['lsp']), true, [directory], 'win32', 'x64')
    assert.strictEqual(native.command, path.join(directory, 'panache', 'panache.exe'))
    assert.deepStrictEqual(native.args, ['lsp'])
    const ltex = await resolveLanguageServerCommand(server('ltex-ls-plus', ['--help']), true, [directory], 'win32', 'x64')
    assert.strictEqual(ltex.command, path.join(directory, 'ltex-plus', 'runtime', 'bin', 'java.exe'))
    assert.deepStrictEqual(ltex.args, [ `-Dapp.home=${path.join(directory, 'ltex-plus')}`, '-cp', path.join(directory, 'ltex-plus', 'lib', '*'), 'org.bsplines.ltexls.LtexLanguageServerLauncher', '--help' ])
    await bundleLanguageServers({ ...options, env: { BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' } })
    assert.strictEqual(downloads, 3)
    assert.deepStrictEqual(await fs.readdir(directory), ['panache'])
    assert.strictEqual((await resolveLanguageServerCommand(server('codebook-lsp', ['serve']), true, [directory], 'win32', 'x64')).bundled, false)
  })

  it('does not download when bundling is disabled or the target is unsupported', async () => {
    const download = async (): Promise<never> => { throw new Error('Unexpected download') }
    assert.strictEqual(await bundleLanguageServers({ platform: 'linux', arch: 'arm64', resourcesDirectory: temporary, env: { BUNDLE_LSP: '0' }, download }), undefined)
    assert.strictEqual(await bundleLanguageServers({ platform: 'linux', arch: 'ia32', resourcesDirectory: temporary, env: {}, download }), undefined)
    assert.deepStrictEqual(await fs.readdir(temporary), [])
  })

  it('replaces its Forge resources on target changes and removes them when disabled', async () => {
    const forgeConfig = { packagerConfig: { extraResource: ['resources/icons/icon.icns'] } }
    const options = { resourcesDirectory: temporary, env: { BUNDLE_PANDOC: '0', BUNDLE_CODEBOOK: '0', BUNDLE_LTEX_PLUS: '0' }, download: archiveFixture }
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
