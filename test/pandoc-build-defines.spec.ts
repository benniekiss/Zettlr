import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { getPandocBuildDefines } from '../scripts/pandoc-build-defines'

describe('Pandoc build defaults', function () {
  function defaults (env: NodeJS.ProcessEnv): { DEFAULT_PANDOC_WASM_URL: string, DEFAULT_PANDOC_WASM_SHA256: string } {
    const source = readFileSync('source/common/pandoc-util/pandoc-wasm-url.ts', 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
    const exports = {}
    const defines = Object.fromEntries(Object.entries(getPandocBuildDefines(env)).map(([key, value]) => [key, JSON.parse(value)]))
    runInNewContext(compiled, { exports, ...defines })
    return exports as ReturnType<typeof defaults>
  }

  it('clears the URL and hash when the default source is disabled', function () {
    assert.deepStrictEqual(defaults({ PANDOC_WASM_URL: 'none' }), {
      DEFAULT_PANDOC_WASM_URL: '', DEFAULT_PANDOC_WASM_SHA256: ''
    })
  })

  it('can omit the default hash without removing the URL', function () {
    const unpinned = defaults({ PANDOC_WASM_SHA256: 'none' })
    assert.equal(unpinned.DEFAULT_PANDOC_WASM_URL, defaults({}).DEFAULT_PANDOC_WASM_URL)
    assert.equal(unpinned.DEFAULT_PANDOC_WASM_SHA256, '')
    assert.equal(defaults({ PANDOC_WASM_URL: '' }).DEFAULT_PANDOC_WASM_URL, defaults({}).DEFAULT_PANDOC_WASM_URL)
  })

  it('accepts an explicit none sentinel for either default', function () {
    assert.deepStrictEqual(getPandocBuildDefines({ PANDOC_WASM_URL: 'none', PANDOC_WASM_SHA256: 'none' }), {
      __PANDOC_WASM_URL__: '"none"',
      __PANDOC_WASM_SHA256__: '"none"'
    })
  })
  it('leaves unset overrides empty for the checked-in defaults', function () {
    assert.deepStrictEqual(getPandocBuildDefines({}), {
      __PANDOC_WASM_URL__: '""',
      __PANDOC_WASM_SHA256__: '""'
    })
  })

  it('normalizes and quotes overrides for both bundles', function () {
    const sha256 = 'AB'.repeat(32)
    assert.deepStrictEqual(getPandocBuildDefines({
      PANDOC_WASM_URL: ' https://example.org/pandoc.wasm.zip ',
      PANDOC_WASM_SHA256: ` ${sha256} `
    }), {
      __PANDOC_WASM_URL__: '"https://example.org/pandoc.wasm.zip"',
      __PANDOC_WASM_SHA256__: JSON.stringify(sha256.toLowerCase())
    })
    assert.equal(getPandocBuildDefines({ PANDOC_WASM_URL: 'file:///opt/pandoc.wasm' }).__PANDOC_WASM_URL__, '"file:///opt/pandoc.wasm"')
  })

  it('rejects unsupported URLs and malformed or empty explicit hashes', function () {
    assert.throws(() => getPandocBuildDefines({ PANDOC_WASM_URL: 'http://example.org/pandoc.wasm' }), /HTTPS or file/)
    assert.throws(() => getPandocBuildDefines({ PANDOC_WASM_URL: 'invalid' }))
    for (const hash of [ '', 'invalid', 'a'.repeat(63), 'g'.repeat(64) ]) {
      assert.throws(() => getPandocBuildDefines({ PANDOC_WASM_SHA256: hash }), /64 hexadecimal/)
    }
  })
})
