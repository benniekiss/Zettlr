import path from 'path'
import { promises as fs } from 'fs'
import { Worker } from 'worker_threads'
import YAML from 'yaml'
import type { PandocRunnerOutput } from '@providers/commands/exporter/types'

interface ReactorOutput {
  stdout: string
  stderr: string
  warnings: string
  error?: string
}

let getWasmPath: (() => Promise<string>)|undefined

/** Resolve the current preference on each run, so URL changes apply immediately. */
export function configurePandocWasm (resolvePath: () => Promise<string>): void {
  getWasmPath = resolvePath
}

async function runReactor (options: Record<string, unknown>, cwd?: string, query = false): Promise<ReactorOutput> {
  if (getWasmPath === undefined) {
    throw new Error('Pandoc WASM has not been configured.')
  }
  const wasmPath = await getWasmPath()
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pandoc-worker.cjs'), {
      workerData: { options, cwd, query, wasmPath }
    })
    let received = false
    worker.once('message', (result: ReactorOutput) => {
      received = true
      if (result.error !== undefined) {
        reject(new Error(result.error))
      } else {
        resolve(result)
      }
    })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (!received) {
        reject(new Error(`Pandoc WASM worker exited without a result (code ${code}).`))
      }
    })
  })
}

export async function getPandocVersion (): Promise<string> {
  const result = await runReactor({ query: 'version' }, undefined, true)
  if (result.stderr !== '') {
    throw new Error(result.stderr)
  }
  return JSON.parse(result.stdout) as string
}

/** Runs the existing defaults-file workflow through Pandoc's WASM reactor. */
export async function runPandoc (defaultsFile: string, cwd?: string): Promise<PandocRunnerOutput> {
  const options = YAML.parse(await fs.readFile(defaultsFile, 'utf8')) as Record<string, unknown>
  const writer = options.writer ?? options.to
  const output = options['output-file']
  const filters = options.filters ?? []
  const unsupported = writer === 'pdf' || (typeof output === 'string' && path.extname(output).toLowerCase() === '.pdf')
    ? 'Pandoc WASM cannot run external PDF engines. Use the Simple PDF export profile instead.'
    : Array.isArray(filters) && filters.some(filter => typeof filter === 'string'
      ? !filter.endsWith('.lua')
      : filter?.type === 'json')
      ? 'Pandoc WASM cannot run executable JSON filters. Use Lua filters instead.'
      : undefined
  if (unsupported !== undefined) {
    return { code: 1, stdout: [], stderr: [unsupported] }
  }

  try {
    const result = await runReactor(options, cwd)
    const lines = (text: string): string[] => text.split('\n').filter(line => line.trim() !== '')
    const messages: Array<{ verbosity?: string, pretty?: string }> = result.warnings === '' ? [] : JSON.parse(result.warnings)
    const warnings = messages.filter(message => ![ 'INFO', 'DEBUG' ].includes(message.verbosity ?? ''))
    const failed = result.stderr.startsWith('ERROR:') || (options['fail-if-warnings'] === true && warnings.length > 0)
    return {
      code: failed ? 1 : 0,
      stdout: lines(result.stdout),
      stderr: [ ...lines(result.stderr), ...warnings.map(warning => warning.pretty ?? JSON.stringify(warning)) ]
    }
  } catch (error: unknown) {
    return { code: 1, stdout: [], stderr: [error instanceof Error ? error.message : String(error)] }
  }
}
