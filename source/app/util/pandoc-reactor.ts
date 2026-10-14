import { runIsolatedTask } from './run-isolated-task'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

export interface ReactorOutput {
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

export class InvalidPandocModuleError extends Error {}

/** A process boundary lets the OS close native WASI handles after a timeout. */
export async function runPandocReactor (
  wasmPath: string,
  options: Record<string, unknown>,
  { cwd, query = false, timeoutMs = query ? 30000 : 10 * 60 * 1000 }: { cwd?: string, query?: boolean, timeoutMs?: number } = {}
): Promise<ReactorOutput> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'zettlr-pandoc-'))
  try {
    const result = await runIsolatedTask<ReactorOutput|ReactorError>(
      path.join(__dirname, '../workers/pandoc-process.cjs'),
      { wasmPath, options, cwd, query, temporaryDirectory },
      { name: `Pandoc WASM ${query ? 'query' : 'conversion'}`, timeoutMs }
    )
    if ('error' in result) {
      throw result.invalidModule === true ? new InvalidPandocModuleError(result.error) : new Error(result.error)
    }
    return result
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** Validate a candidate without giving its version query access to source files. */
export async function validatePandocWasmRuntime (filename: string): Promise<string> {
  const result = await runPandocReactor(filename, { query: 'version' }, { query: true })
  let version: unknown
  try { version = JSON.parse(result.stdout) } catch { /* Reject malformed query output below. */ }
  if (result.failed || result.stderr !== '' || typeof version !== 'string' || !/^\d+\.\d+/.test(version)) {
    throw new InvalidPandocModuleError(result.stderr || 'The downloaded module did not return a valid Pandoc version.')
  }
  return version
}
