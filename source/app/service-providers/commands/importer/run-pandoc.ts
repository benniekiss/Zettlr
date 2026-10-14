import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import YAML from 'yaml'

/** Each import owns its defaults file until Pandoc has finished reading it. */
export default async function runPandocImport (defaults: Record<string, unknown>, temporaryRoot: string): Promise<void> {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'zettlr-import-'))
  try {
    const filename = path.join(directory, 'defaults.yml')
    await fs.writeFile(filename, YAML.stringify(defaults, { indent: 4, simpleKeys: false }), 'utf8')
    await new Promise<void>((resolve, reject) => {
      const pandoc = spawn('pandoc', [ '--defaults', filename ], { shell: false })
      const stderr: string[] = []
      pandoc.stderr.on('data', data => { stderr.push(String(data)) })
      // Consume stdout so a verbose reader cannot fill the process pipe.
      pandoc.stdout.resume()
      let failure: Error|undefined
      pandoc.on('error', error => { failure = error })
      // close follows exit/error and confirms the process's streams are closed.
      pandoc.on('close', (code, signal) => {
        if (failure !== undefined) {
          reject(failure)
        } else if (code === 0) {
          resolve()
        } else {
          const detail = stderr.join('').trim()
          const reason = signal === null ? `code ${String(code)}` : `signal ${signal}`
          reject(new Error(`Could not import file: Pandoc exited with ${reason}.${detail === '' ? '' : `\n${detail}`}`))
        }
      })
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
