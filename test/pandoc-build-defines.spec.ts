import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { getPandocBuildDefines, getPandocBuildSettings } from '../scripts/pandoc-build-defines'
import builtin from '../source/common/pandoc-util/pandoc-wasm-defaults.json'
import type { PandocModuleSource } from '../source/common/pandoc-util/pandoc-module-source'

function evaluate (filename: string, context: Record<string, unknown>) {
  const source = readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const exports = {}
  runInNewContext(compiled, { exports, ...context })
  return exports
}

function defaults (env: NodeJS.ProcessEnv) {
  const defines = Object.fromEntries(Object.entries(getPandocBuildDefines(env)).map(([key, value]) => [key, JSON.parse(value)]))
  return evaluate('source/common/pandoc-util/pandoc-wasm-url.ts', { require: () => builtin, ...defines }) as {
    DEFAULT_PANDOC_WASM_URL: string, DEFAULT_PANDOC_WASM_SHA256: string
  }
}

function resolve (preferences: { pandocWasmUrl: string, pandocWasmSha256: string }, env: NodeJS.ProcessEnv = {}): PandocModuleSource {
  const exports = evaluate('source/common/pandoc-util/pandoc-module-source.ts', { require: () => defaults(env) }) as {
    resolvePandocModuleSource: (preferences: object, bundledPath: string) => PandocModuleSource
  }
  return exports.resolvePandocModuleSource(preferences, '/assets/pandoc.wasm')
}

describe('Pandoc source configuration', function () {
  it('uses the same resolved settings for build downloads and Webpack constants', function () {
    for (const env of [{}, { PANDOC_WASM_URL: 'none' }, { PANDOC_WASM_SHA256: 'none' }, { PANDOC_WASM_URL: 'file:///opt/pandoc.wasm' }]) {
      const settings = getPandocBuildSettings(env)
      const compiled = defaults(env)
      assert.equal(compiled.DEFAULT_PANDOC_WASM_URL, settings.url)
      assert.equal(compiled.DEFAULT_PANDOC_WASM_SHA256, settings.sha256 ?? '')
    }
    assert.deepStrictEqual(getPandocBuildSettings({}), builtin)
  })

  it('clears the default URL and hash when bundling is disabled', function () {
    assert.equal(getPandocBuildSettings({ PANDOC_WASM_URL: 'none' }).url, '')
    assert.equal(getPandocBuildSettings({ PANDOC_WASM_URL: 'none' }).sha256, undefined)
    assert.equal(defaults({ PANDOC_WASM_URL: 'none' }).DEFAULT_PANDOC_WASM_SHA256, '')
  })

  it('can omit the hash independently and keeps defaults for an empty URL override', function () {
    assert.deepStrictEqual(getPandocBuildSettings({ PANDOC_WASM_SHA256: 'none' }), { url: builtin.url, sha256: undefined })
    assert.deepStrictEqual(getPandocBuildSettings({ PANDOC_WASM_URL: '' }), builtin)
  })

  it('normalizes and quotes explicit build overrides', function () {
    const sha256 = 'AB'.repeat(32)
    assert.deepStrictEqual(getPandocBuildDefines({
      PANDOC_WASM_URL: ' https://example.org/pandoc.wasm.zip ',
      PANDOC_WASM_SHA256: ` ${sha256} `
    }), {
      __PANDOC_WASM_URL__: '"https://example.org/pandoc.wasm.zip"',
      __PANDOC_WASM_SHA256__: JSON.stringify(sha256.toLowerCase())
    })
  })

  it('rejects unsupported URLs and malformed or empty explicit hashes', function () {
    assert.throws(() => getPandocBuildSettings({ PANDOC_WASM_URL: 'http://example.org/pandoc.wasm' }), /HTTPS or file/)
    assert.throws(() => getPandocBuildSettings({ PANDOC_WASM_URL: 'invalid' }))
    for (const hash of ['', 'invalid', 'a'.repeat(63), 'g'.repeat(64)]) {
      assert.throws(() => getPandocBuildSettings({ PANDOC_WASM_SHA256: hash }), /64 hexadecimal/)
    }
  })

  it('resolves saved default preferences and an empty URL to the pinned bundle', function () {
    for (const pandocWasmUrl of ['', builtin.url]) {
      const source = resolve({ pandocWasmUrl, pandocWasmSha256: '' })
      assert.equal(source.url, builtin.url)
      assert.equal(source.sha256, builtin.sha256)
      assert.equal(source.bundledPath, '/assets/pandoc.wasm')
    }
    // A hash supplied without a source is ignored.
    assert.equal(resolve({ pandocWasmUrl: '', pandocWasmSha256: 'a'.repeat(64) }).sha256, builtin.sha256)
  })

  it('applies custom sources and normalized hashes without using the bundle', function () {
    const source = resolve({ pandocWasmUrl: ' https://example.org/custom.wasm ', pandocWasmSha256: ` ${'AB'.repeat(32)} ` })
    assert.equal(source.url, 'https://example.org/custom.wasm')
    assert.equal(source.sha256, 'ab'.repeat(32))
    assert.equal(source.bundledPath, undefined)
    assert.equal(resolve({ pandocWasmUrl: source.url, pandocWasmSha256: '' }).sha256, undefined)
    assert.equal(resolve({ pandocWasmUrl: builtin.url, pandocWasmSha256: 'a'.repeat(64) }).bundledPath, undefined)
  })

  it('honors builds without a source or hash and still permits custom sources', function () {
    const preferences = { pandocWasmUrl: '', pandocWasmSha256: '' }
    const disabled = resolve(preferences, { PANDOC_WASM_URL: 'none' })
    assert.equal(disabled.url, '')
    assert.equal(disabled.sha256, undefined)
    assert.equal(disabled.bundledPath, undefined)
    const unpinned = resolve(preferences, { PANDOC_WASM_SHA256: 'none' })
    assert.equal(unpinned.sha256, undefined)
    assert.equal(unpinned.bundledPath, '/assets/pandoc.wasm')
    assert.equal(resolve({ ...preferences, pandocWasmUrl: 'https://example.org/custom.wasm' }, { PANDOC_WASM_URL: 'none' }).url, 'https://example.org/custom.wasm')
  })
})
