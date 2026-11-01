import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { signLanguageServerJars } from '../scripts/sign-language-server-jars'

describe('Language server JAR signing', function () {
  let directory: string
  beforeEach(async function () { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-jar-test-')) })
  afterEach(async function () { await fs.rm(directory, { recursive: true, force: true }) })

  it('signs both supported macOS architectures inside JARs and preserves Java and other platform resources', async function () {
    const jar = path.join(directory, 'native.jar')
    const archive = new AdmZip()
    const arm = Buffer.from('cffaedfe0c000001', 'hex')
    const intel = Buffer.from('cffaedfe07000001', 'hex')
    archive.addFile('darwin-aarch64/native.dylib', arm)
    archive.addFile('darwin-x86-64/native.jnilib', intel)
    archive.addFile('Mac/x86/native.jnilib', Buffer.from('cefaedfe07000000', 'hex'))
    archive.addFile('linux/native.so', Buffer.from('ELF library'))
    archive.addFile('Example.class', Buffer.from('cafebabe00000041', 'hex'))
    archive.addFile('META-INF/LICENSE', Buffer.from('license notice'))
    archive.writeZip(jar)
    const signed: Buffer[] = []
    const workFiles: string[] = []
    await signLanguageServerJars(directory, 'Developer ID Application: Test', async (filename: string) => {
      signed.push(await fs.readFile(filename))
      workFiles.push(filename)
      await fs.appendFile(filename, 'signature')
    })
    assert.deepEqual(signed, [arm, intel])
    const result = new AdmZip(jar)
    assert.deepEqual(result.readFile('darwin-aarch64/native.dylib'), Buffer.concat([arm, Buffer.from('signature')]))
    assert.deepEqual(result.readFile('darwin-x86-64/native.jnilib'), Buffer.concat([intel, Buffer.from('signature')]))
    assert.equal(result.getEntry('Mac/x86/native.jnilib'), null)
    assert.equal(result.readAsText('linux/native.so'), 'ELF library')
    assert.deepEqual(result.readFile('Example.class'), Buffer.from('cafebabe00000041', 'hex'))
    assert.equal(result.readAsText('META-INF/LICENSE'), 'license notice')
    for (const filename of workFiles) await assert.rejects(fs.access(filename))
  })

  it('propagates signing failures without replacing the JAR and removes work files', async function () {
    const jar = path.join(directory, 'native.jar')
    const archive = new AdmZip()
    archive.addFile('native.dylib', Buffer.from('cffaedfe0c000001', 'hex'))
    archive.writeZip(jar)
    const original = await fs.readFile(jar)
    let workFile = ''
    await assert.rejects(signLanguageServerJars(directory, 'Test', async (filename: string) => {
      workFile = filename
      throw new Error('Signing failed')
    }), /Signing failed/)
    assert.deepEqual(await fs.readFile(jar), original)
    await assert.rejects(fs.access(workFile))
  })
})
