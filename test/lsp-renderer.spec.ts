import assert from 'assert'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import webpack from 'webpack'

// tsx's Node loader unifies these modules in ordinary unit tests; Webpack does
// not unless explicitly configured. Exercise the bundle that the GUI uses.
describe('Renderer LSP module compatibility', () => {
  it('accepts LSP extensions in the editor after bundling', async function () {
    this.timeout(30000)
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-lsp-renderer-test-'))
    try {
      const config = require('../webpack.renderer.config.js')
      const compiler = webpack({
        ...config,
        mode: 'development', target: 'web', devtool: false,
        entry: path.resolve('test/fixtures/lsp-renderer.ts'),
        output: { path: directory, filename: 'renderer.cjs', library: { type: 'commonjs2' } }
      })
      await new Promise<void>((resolve, reject) => {
        compiler.run((error, stats) => {
          compiler.close(closeError => {
            if (error ?? closeError) reject(error ?? closeError)
            else if (stats?.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
            else resolve()
          })
        })
      })
      const { EditorState, LSPClient } = require(path.join(directory, 'renderer.cjs'))
      const client = new LSPClient()
      assert.doesNotThrow(() => EditorState.create({ doc: 'hello', extensions: client.plugin('file:///test.md', 'markdown') }))
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
