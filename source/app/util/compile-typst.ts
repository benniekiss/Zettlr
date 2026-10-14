import { existsSync } from 'fs'
import path from 'path'
import { runIsolatedTask } from './run-isolated-task'

interface TypstResult { warnings: string[], error?: string }

/** Compile into a job file; the exporter owns publication and cleanup. */
export async function compileTypst (
  source: string,
  target: string,
  cwd: string,
  { fontPath = '', failIfWarnings = false, timeoutMs = 10 * 60 * 1000 }: { fontPath?: string, failIfWarnings?: boolean, timeoutMs?: number } = {}
): Promise<string[]> {
  const bundled = path.join(__dirname, 'assets/typst')
  const packaged = existsSync(bundled)
  const driver = packaged ? path.join(bundled, 'driver') : path.resolve(__dirname, '../../../node_modules/@myriaddreamin/typst.ts/dist/cjs')
  const compiler = packaged ? path.join(bundled, 'compiler') : path.resolve(__dirname, '../../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg')
  const result = await runIsolatedTask<TypstResult>(
    path.join(__dirname, '../workers/typst-process.cjs'),
    { source, cwd: path.resolve(cwd), output: target, driver, compiler, fontPath, failIfWarnings },
    { name: 'Typst WASM compilation', timeoutMs }
  )
  if (result.error !== undefined) {
    throw new Error(result.error)
  }
  return result.warnings
}
