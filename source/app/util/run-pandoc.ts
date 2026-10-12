import path from 'path'
import { promises as fs } from 'fs'
import { Worker } from 'worker_threads'
import YAML from 'yaml'
import type { PandocRunnerOutput } from '@providers/commands/exporter/types'

interface ReactorOutput {
  stdout: string
  stderr: string
  warnings: string
  failed: boolean
  version?: string
}

interface ReactorError {
  error: string
  invalidModule?: boolean
}

let getWasmPath: (() => Promise<string>)|undefined
let invalidateWasmPath: ((filename: string) => Promise<void>)|undefined
const QUERY_TIMEOUT_MS = 30000
const CONVERSION_TIMEOUT_MS = 10 * 60 * 1000

/** Resolve the current preference on each run, so URL changes apply immediately. */
export function configurePandocWasm (resolvePath: () => Promise<string>, invalidatePath?: (filename: string) => Promise<void>): void {
  getWasmPath = resolvePath
  invalidateWasmPath = invalidatePath
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
    let completed = false
    const invalidate = async () => {
      if (invalidateWasmPath !== undefined) {
        try { await invalidateWasmPath(wasmPath) } catch { /* Preserve the worker error. */ }
      }
    }
    const timeout = setTimeout(() => {
      completed = true
      void worker.terminate().catch(() => {})
      reject(new Error(`Pandoc WASM ${query ? 'query' : 'conversion'} timed out.`))
    }, query ? QUERY_TIMEOUT_MS : CONVERSION_TIMEOUT_MS)
    worker.once('message', async (result: ReactorOutput|ReactorError) => {
      if (completed) {
        return
      }
      completed = true
      clearTimeout(timeout)
      if ('error' in result) {
        if (result.invalidModule === true) {
          await invalidate()
        }
        reject(new Error(result.error))
      } else {
        resolve(result)
      }
    })
    worker.once('error', error => {
      if (!completed) {
        completed = true
        clearTimeout(timeout)
        reject(error)
      }
    })
    worker.once('exit', code => {
      if (!completed) {
        completed = true
        clearTimeout(timeout)
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

/** Runs parsed export defaults or an import defaults file through the WASM reactor. */
export async function runPandoc (input: string|Record<string, unknown>, cwd?: string): Promise<PandocRunnerOutput> {
  try {
    const options: unknown = typeof input === 'string' ? YAML.parse(await fs.readFile(input, 'utf8')) : input
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Pandoc defaults must contain a YAML mapping of options.')
    }
    const defaults = options as Record<string, unknown>
    const writer = defaults.writer ?? defaults.to
    const output = defaults['output-file']
    if (writer === 'pdf' || (typeof output === 'string' && path.extname(output).toLowerCase() === '.pdf')) {
      throw new Error('Pandoc WASM cannot run external PDF engines. Use the Simple PDF export profile instead.')
    }
    const filters = defaults.filters
    if (Array.isArray(filters) && filters.some(filter => typeof filter === 'string' ? !filter.endsWith('.lua') : filter?.type === 'json')) {
      throw new Error('Pandoc WASM cannot run executable JSON filters. Use Lua filters instead.')
    }
    const result = await runReactor(defaults, cwd)
    if (result.version !== undefined) {
      process.env.PANDOC_VERSION = result.version
    }
    const lines = (text: string): string[] => text.split('\n').filter(line => line.trim() !== '')
    const messages: Array<{ verbosity?: string, pretty?: string }> = result.warnings === '' ? [] : JSON.parse(result.warnings)
    const informational = messages.filter(message => [ 'INFO', 'DEBUG' ].includes(message.verbosity ?? ''))
    const warnings = messages.filter(message => ![ 'INFO', 'DEBUG' ].includes(message.verbosity ?? ''))
    const format = (message: { pretty?: string }): string => message.pretty ?? JSON.stringify(message)
    const failed = result.failed || (defaults['fail-if-warnings'] === true && warnings.length > 0)
    return {
      code: failed ? 1 : 0,
      stdout: [ ...lines(result.stdout), ...informational.map(format) ],
      stderr: [ ...lines(result.stderr), ...warnings.map(format) ]
    }
  } catch (error: unknown) {
    return { code: 1, stdout: [], stderr: [error instanceof Error ? error.message : String(error)] }
  }
}
