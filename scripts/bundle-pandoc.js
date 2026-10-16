const path = require('path')
const fs = require('fs').promises
const { require: requireTS } = require('tsx/cjs/api')
const { getPandocBuildDefines } = require('./pandoc-build-defines')

/** Use the runtime installer at build time, including extraction and validation. */
class BundlePandocPlugin {
  apply (compiler) {
    compiler.hooks.thisCompilation.tap('BundlePandoc', compilation => {
      compilation.hooks.processAssets.tapPromise({
        name: 'BundlePandoc',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
      }, async () => {
        const defines = getPandocBuildDefines()
        const urlOverride = JSON.parse(defines.__PANDOC_WASM_URL__)
        if (urlOverride === 'none') {
          return
        }
        const { DEFAULT_PANDOC_WASM_URL, DEFAULT_PANDOC_WASM_SHA256 } = requireTS('../source/common/pandoc-util/pandoc-wasm-url.ts', __filename)
        const hashOverride = JSON.parse(defines.__PANDOC_WASM_SHA256__)
        const { downloadPandocWasm } = requireTS('../source/app/util/download-pandoc-wasm.ts', __filename)
        const filename = await downloadPandocWasm(
          urlOverride || DEFAULT_PANDOC_WASM_URL,
          path.join(compiler.context, 'build/pandoc-wasm'),
          undefined,
          hashOverride === 'none' ? null : hashOverride || DEFAULT_PANDOC_WASM_SHA256
        )
        compilation.emitAsset('assets/pandoc.wasm', new compiler.webpack.sources.RawSource(await fs.readFile(filename)))
      })
    })
  }
}

module.exports = { BundlePandocPlugin }
