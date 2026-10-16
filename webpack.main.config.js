const CopyWebpackPlugin = require('copy-webpack-plugin')
const { DefinePlugin } = require('webpack')
const path = require('path')
const rules = require('./webpack.rules')
const { getPandocBuildDefines } = require('./scripts/pandoc-build-defines')
const { BundlePandocPlugin } = require('./scripts/bundle-pandoc')

const externals = {}

if (process.env.BUNDLE_FSEVENTS !== '1') {
  // Do not embed fsevents (otherwise this leads to problems on Linux and
  // Windows, see https://github.com/paulmillr/chokidar/issues/618#issuecomment-392618390)
  // NOTE: The environment variable is set in the generateAssets hook of electron
  // forge since that runs before this module is required and has access to the
  // *target* platform (rather than process.platform)
  externals.fsevents = "require('fsevents')"
}

module.exports = {
  // Main entry point: the file that runs in the main process
  entry: './source/main.ts',
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  module: { rules },
  plugins: [
    new BundlePandocPlugin(),
    new CopyWebpackPlugin({
      patterns: [
        // These are all static files that simply need to be bundled with the
        // application; we'll just copy them over from the static folder.
        { from: 'static/tutorial', to: 'tutorial' },
        // Keep process entry points beside main, matching source/app's directory layout.
        { from: 'source/app/processes/pandoc-process.cjs', to: '../processes/pandoc-process.cjs' },
        { from: 'source/app/processes/typst-process.cjs', to: '../processes/typst-process.cjs' },
        { from: 'source/app/processes/typst-fonts.cjs', to: '../processes/typst-fonts.cjs' },
        { from: 'static/typst', to: 'assets/typst' },
        { from: 'node_modules/@myriaddreamin/typst.ts/LICENSE', to: 'assets/typst/driver/LICENSE' },
        { from: 'node_modules/@myriaddreamin/typst-ts-web-compiler/pkg', to: 'assets/typst/compiler' },
        ...[ 'compiler', 'init', 'internal.types', 'options.init', 'wasm' ].map(name => ({
          from: `node_modules/@myriaddreamin/typst.ts/dist/cjs/${name}.cjs`, to: `assets/typst/driver/${name}.cjs`
        })),
        { from: 'source/app/processes/pandoc-filesystem-roots.cjs', to: '../processes/pandoc-filesystem-roots.cjs' },
        { from: 'static/dict', to: 'dict' },
        { from: 'static/lang', to: 'lang' },
        { from: 'static/csl-locales', to: 'assets/csl-locales' },
        { from: 'static/csl-styles', to: 'assets/csl-styles' },
        { from: 'static/defaults', to: 'assets/defaults' },
        { from: 'static/lua-filter', to: 'assets/lua-filter' },
        { from: 'resources/icons/icon.ico', to: 'assets/icons' },
        { from: 'resources/icons/png', to: 'assets/icons/png' },
        { from: 'resources/icons/macOS-menubar', to: 'assets/icons/macOS-menubar' }
      ]
    }),
    new DefinePlugin({
      ...getPandocBuildDefines(),
      __GIT_COMMIT_HASH__: JSON.stringify(process.env.GIT_COMMIT_HASH),
      __BUILD_DATE__: JSON.stringify((new Date()).toISOString()),
      __UPDATES_DISABLED__: JSON.stringify(process.env.ZETTLR_DISABLE_UPDATE_CHECK !== undefined ? '1' : '0')
    })
  ],
  resolve: {
    extensions: [ '.js', '.ts', '.jsx', '.tsx', '.css', '.json' ],
    alias: {
      source: [path.resolve(__dirname, 'source')],
      '@common': [path.resolve(__dirname, 'source/common')],
      '@providers': [path.resolve(__dirname, 'source/app/service-providers')],
      '@dts': [path.resolve(__dirname, 'source/types')]
    }
  },
  externals
}
