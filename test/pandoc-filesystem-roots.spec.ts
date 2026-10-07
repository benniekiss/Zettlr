import assert from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { runInNewContext } from 'vm'

interface RootOptions { cwd: string, options?: Record<string, unknown>, query?: boolean }

describe('Pandoc Windows filesystem roots', function () {
  function roots (available: string[], options: RootOptions): string[] {
    const context = {
      module: { exports: {} },
      process: { platform: 'win32' },
      require: (name: string) => {
        if (name === 'node:path') return path.win32
        assert.strictEqual(name, 'node:fs')
        return { existsSync: (filename: string) => available.includes(filename) }
      }
    }
    runInNewContext(readFileSync('source/app/processes/pandoc-filesystem-roots.cjs', 'utf8'), context)
    const collect = context.module.exports as (options: RootOptions) => string[]
    return Array.from(collect(options))
  }

  it('ignores unavailable shares mentioned in metadata while retaining reachable resources', function () {
    assert.deepStrictEqual(roots(['C:\\', 'D:\\', '\\\\files\\resources\\'], {
      cwd: 'C:\\notes',
      options: {
        'input-files': ['\\\\files\\resources\\input.md'],
        metadata: { literal: '\\\\offline-server\\share\\example' }
      }
    }), ['C:\\', 'D:\\', '\\\\files\\resources\\'])
  })

  it('keeps the working root mandatory and version queries private', function () {
    const options = { cwd: '\\\\work\\share\\notes', options: { template: '\\\\offline\\share\\template' } }
    assert.deepStrictEqual(roots([], options), ['\\\\work\\share\\'])
    assert.deepStrictEqual(roots(['C:\\'], { ...options, query: true }), [options.cwd])
  })
})
