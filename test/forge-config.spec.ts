import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

describe('Forge asset generation', function () {
  it('generates language-server resources when native Pandoc bundling is disabled', async function () {
    const filename = path.resolve('forge.config.js')
    const requireConfig = createRequire(filename)
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        const calls: unknown[][] = []
        const signCalls: unknown[][] = []
        const env: NodeJS.ProcessEnv = { BUNDLE_PANDOC: '0' }
        const configModule = { exports: {} as {
          packagerConfig: { osxSign: false | { identity: string } }
          hooks: { generateAssets: (config: object, platform: string, arch: string) => Promise<void> }
        } }
        runInNewContext(readFileSync(filename, 'utf8'), {
          module: configModule,
          __dirname: path.dirname(filename),
          process: { env, platform },
          require: (name: string) => {
            if (name === 'fs') {
              return { promises: new Proxy({}, { get: () => { throw new Error('Unexpected filesystem access in generateAssets') } }) }
            }
            if (name === './scripts/get-git-hash.js') {
              return { getGitHash: async () => 'test-commit' }
            }
            if (name === './scripts/get-language-servers.js') {
              return { configureLanguageServerResources: async (...args: unknown[]) => {
                calls.push(args)
                return '/staging/language-servers'
              } }
            }
            if (name === './scripts/sign-language-server-jars.js') {
              return { signLanguageServerJars: async (...args: unknown[]) => { signCalls.push(args) } }
            }
            return requireConfig(name)
          }
        })
        const config = configModule.exports
        await config.hooks.generateAssets(config, platform, arch)
        assert.equal(env.GIT_COMMIT_HASH, 'test-commit')
        assert.deepEqual(calls, [[config, platform, arch]])
        const signing = config.packagerConfig.osxSign
        assert.deepEqual(signCalls, platform === 'darwin' && signing ? [['/staging/language-servers', signing.identity]] : [])
      }
    }
  })
})
