const path = require('path')
const fs = require('fs').promises
const { require: requireTS } = require('tsx/cjs/api')
const { getPandocBuildSettings } = require('./pandoc-build-defines')

/** Use the runtime installer at build time, including extraction and validation. */
class BundlePandocPlugin {
  apply (compiler) {
    compiler.hooks.thisCompilation.tap('BundlePandoc', compilation => {
      compilation.hooks.processAssets.tapPromise({
        name: 'BundlePandoc',
        stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
      }, async () => {
        const source = getPandocBuildSettings()
        if (source.url === '') {
          return
        }
        const { ensurePandocModule } = requireTS('../source/app/util/download-pandoc-wasm.ts', __filename)
        const filename = await ensurePandocModule(source, path.join(compiler.context, 'build/pandoc-wasm'))
        compilation.emitAsset('assets/pandoc.wasm', new compiler.webpack.sources.RawSource(await fs.readFile(filename)))
      })
    })
  }
}

module.exports = { BundlePandocPlugin }
