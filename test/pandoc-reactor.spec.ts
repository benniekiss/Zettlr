import assert from 'assert'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { runPandocReactor, validatePandocWasmRuntime } from '../source/app/util/pandoc-reactor'

describe('Pandoc WASM process lifecycle', function () {
  this.timeout(15000)

  it('keeps relative resource filenames separate from reactor IO', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-reactor-resource-'))
    try {
      const filename = path.join(directory, 'warnings')
      await fs.writeFile(filename, 'Original')
      const result = await runPandocReactor(
        path.resolve('test/fixtures/pandoc/relative-resource-reactor.wasm'), {}, { cwd: directory }
      )
      assert.strictEqual(result.failed, false, result.stderr)
      assert.strictEqual(result.warnings, '')
      assert.strictEqual(await fs.readFile(filename, 'utf8'), 'Changed')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('cleans temporary files and native descriptors after repeated timeouts', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-reactor-lifecycle-'))
    const temporaryVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[temporaryVariable]
    process.env[temporaryVariable] = directory
    try {
      await fs.writeFile(path.join(directory, 'input.md'), 'Input held open by the reactor')
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(runPandocReactor(
          path.resolve('test/fixtures/pandoc/looping-reactor.wasm'),
          { reader: 'markdown', writer: 'html' },
          { cwd: directory, timeoutMs: 1000 }
        ), /conversion timed out/)
        assert.deepStrictEqual(await fs.readdir(directory), ['input.md'])
        if (process.platform === 'linux') {
          const open = await Promise.all((await fs.readdir('/proc/self/fd')).map(async fd => {
            try { return await fs.readlink(`/proc/self/fd/${fd}`) } catch { return '' }
          }))
          assert.ok(!open.some(filename => filename.startsWith(directory)), 'Native source or directory descriptors leaked into the parent')
        }
      }
      assert.strictEqual(await validatePandocWasmRuntime(path.resolve('test/fixtures/pandoc/reactor.wasm')), '3.12.0')
      assert.deepStrictEqual(await fs.readdir(directory), ['input.md'])
    } finally {
      if (previous === undefined) delete process.env[temporaryVariable]
      else process.env[temporaryVariable] = previous
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('cleans private files after module initialization fails', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-reactor-error-'))
    const temporaryVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[temporaryVariable]
    process.env[temporaryVariable] = directory
    try {
      await assert.rejects(validatePandocWasmRuntime(path.join(directory, 'missing.wasm')), /could not be read/)
      assert.deepStrictEqual(await fs.readdir(directory), [])
    } finally {
      if (previous === undefined) delete process.env[temporaryVariable]
      else process.env[temporaryVariable] = previous
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('stops the helper and cleans up when IPC serialization fails', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-reactor-ipc-'))
    const temporaryVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[temporaryVariable]
    process.env[temporaryVariable] = directory
    try {
      await assert.rejects(runPandocReactor(
        path.resolve('test/fixtures/pandoc/reactor.wasm'),
        { unsupported: 1n },
        { timeoutMs: 5000 }
      ), /BigInt/)
      assert.deepStrictEqual(await fs.readdir(directory), [])
    } finally {
      if (previous === undefined) delete process.env[temporaryVariable]
      else process.env[temporaryVariable] = previous
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('cleans up when the deadline expires during startup', async function () {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-reactor-startup-'))
    const temporaryVariable = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
    const previous = process.env[temporaryVariable]
    process.env[temporaryVariable] = directory
    try {
      await assert.rejects(runPandocReactor(
        path.resolve('test/fixtures/pandoc/reactor.wasm'),
        { query: 'version' },
        { query: true, timeoutMs: 1 }
      ), /query timed out/)
      assert.deepStrictEqual(await fs.readdir(directory), [])
    } finally {
      if (previous === undefined) delete process.env[temporaryVariable]
      else process.env[temporaryVariable] = previous
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
