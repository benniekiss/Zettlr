const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const AdmZip = require('adm-zip')

const run = promisify(execFile)

function isMachO (bytes) {
  return bytes.length >= 4 && [
    'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
    'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'
  ].includes(bytes.subarray(0, 4).toString('hex'))
}

// Java class files share the fat Mach-O magic, so inspect only native libraries.
async function signLanguageServerJars (directory, identity, sign = async filename => {
  await run('codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', filename])
  await run('codesign', ['--verify', '--strict', filename])
}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-jar-sign-'))
  try {
    async function visit (folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const filename = path.join(folder, entry.name)
        if (entry.isDirectory()) {
          await visit(filename)
        } else if (entry.isFile() && entry.name.endsWith('.jar')) {
          const archive = new AdmZip(await fs.readFile(filename))
          let changed = false
          for (const member of archive.getEntries()) {
            if (member.isDirectory || !/\.(dylib|jnilib|so)$/i.test(member.entryName)) continue
            const bytes = member.getData()
            if (!isMachO(bytes)) continue
            // Modern macOS cannot load the legacy 32-bit Jansi library.
            const magic = bytes.subarray(0, 4).toString('hex')
            if (bytes.length >= 8 && (magic === 'cefaedfe' || magic === 'feedface')) {
              const cpu = magic === 'cefaedfe' ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4)
              if (cpu === 7) {
                archive.deleteFile(member)
                changed = true
                continue
              }
            }
            // Never extract archive paths onto the host filesystem.
            const library = path.join(temporary, 'native-library')
            await fs.writeFile(library, bytes)
            await sign(library)
            archive.updateFile(member, await fs.readFile(library))
            changed = true
          }
          if (changed) {
            await fs.writeFile(filename, archive.toBuffer())
            console.log(`[LSP] Signed native libraries in ${filename}`)
          }
        }
      }
    }
    await visit(directory)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

module.exports = { signLanguageServerJars }
