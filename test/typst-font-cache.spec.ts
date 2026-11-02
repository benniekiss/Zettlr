import assert from 'assert'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { collectFontMetadata, fontFiles } from '../source/app/processes/typst-fonts.cjs'

describe('Typst font metadata cache', function () {
  let directory: string
  beforeEach(async function () { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-font-cache-')) })
  afterEach(async function () { await fs.rm(directory, { recursive: true, force: true }) })

  it('reuses unchanged metadata after an IPC serialization round trip', async function () {
    const filename = path.join(directory, 'font.ttf')
    await fs.writeFile(filename, 'Font')
    let parses = 0
    const parse = (bytes: Buffer) => {
      parses++
      return { info: [{ family: bytes.toString() }], conditions: [{ t: 'Sha256', v: 'example' }] }
    }
    const cold = collectFontMetadata([filename], {}, parse)
    const warm = collectFontMetadata([filename], JSON.parse(JSON.stringify(cold)), parse)
    assert.deepStrictEqual(warm, cold)
    assert.strictEqual(parses, 1)
  })

  it('reparses changed files even when size and modification time are preserved', async function () {
    const filename = path.join(directory, 'font.ttf')
    await fs.writeFile(filename, 'First')
    const modified = new Date('2024-01-01T00:00:00.000Z')
    await fs.utimes(filename, modified, modified)
    let parses = 0
    const parse = (bytes: Buffer) => {
      parses++
      return { info: [{ family: bytes.toString() }] }
    }
    const cold = collectFontMetadata([filename], {}, parse)
    await fs.writeFile(filename, 'Other')
    await fs.utimes(filename, modified, modified)
    const changed = collectFontMetadata([filename], cold, parse)
    assert.strictEqual(parses, 2)
    assert.notDeepStrictEqual(changed, cold)
  })

  it('discovers new fonts and drops deleted or no-longer-selected fonts', async function () {
    const first = path.join(directory, 'first.ttf')
    const second = path.join(directory, 'second.ttf')
    await fs.writeFile(first, 'First')
    let parses = 0
    const parse = (bytes: Buffer) => {
      parses++
      return { info: [{ family: bytes.toString() }] }
    }
    const cold = collectFontMetadata(fontFiles(directory), {}, parse)
    await fs.writeFile(second, 'Second')
    const added = collectFontMetadata(fontFiles(directory), cold, parse)
    assert.deepStrictEqual(Object.keys(added).sort(), [first, second].sort())
    assert.strictEqual(parses, 2)
    await fs.unlink(first)
    const removed = collectFontMetadata(fontFiles(directory), added, parse)
    assert.deepStrictEqual(Object.keys(removed), [second])
    assert.strictEqual(parses, 2)
    assert.deepStrictEqual(collectFontMetadata([], removed, parse), {})
  })

  it('discards stale entries when fonts disappear or become invalid', async function () {
    const filename = path.join(directory, 'font.ttf')
    await fs.writeFile(filename, 'Font')
    const cold = collectFontMetadata([filename], {}, () => ({ info: [{ family: 'Font' }] }))
    await fs.writeFile(filename, 'Invalid')
    assert.deepStrictEqual(collectFontMetadata([filename], cold, () => ({ info: [] })), {})
    assert.deepStrictEqual(collectFontMetadata([filename], cold, () => { throw new Error('Invalid font') }), {})
    await fs.unlink(filename)
    assert.deepStrictEqual(collectFontMetadata([filename], cold, () => assert.fail('Cannot parse a missing font')), {})
  })
})
