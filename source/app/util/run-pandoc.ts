import path from 'path'
import { runPandocReactor, InvalidPandocModuleError, type ReactorOutput } from './pandoc-reactor'
import type { PandocRunnerOutput } from '@providers/commands/exporter/types'

let getWasmPath: (() => Promise<string>)|undefined
let invalidateWasmPath: ((filename: string) => Promise<void>)|undefined

/** Resolve the current preference on each run, so URL changes apply immediately. */
export function configurePandocWasm (resolvePath: () => Promise<string>, invalidatePath?: (filename: string) => Promise<void>): void {
  getWasmPath = resolvePath
  invalidateWasmPath = invalidatePath
}

async function runReactor (options: Record<string, unknown>, cwd?: string): Promise<ReactorOutput> {
  if (getWasmPath === undefined) {
    throw new Error('Pandoc WASM has not been configured.')
  }
  const wasmPath = await getWasmPath()
  try {
    return await runPandocReactor(wasmPath, options, { cwd })
  } catch (error) {
    if (error instanceof InvalidPandocModuleError && invalidateWasmPath !== undefined) {
      try { await invalidateWasmPath(wasmPath) } catch { /* Preserve the conversion error. */ }
    }
    throw error
  }
}

/** Runs parsed import/export defaults through the WASM reactor. */
export async function runPandoc (defaults: Record<string, unknown>, cwd?: string): Promise<PandocRunnerOutput> {
  try {
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw new Error('Pandoc defaults must contain a mapping of options.')
    }
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
