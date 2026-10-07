import { existsSync } from 'fs'
import path from 'path'
import { runIsolatedTask } from './run-isolated-task'

interface TypstResult { warnings: string[], error?: string, fontMetadata?: Record<string, unknown> }

// The main process retains metadata between disposable compiler processes.
// Each job rediscovers fonts and checks file signatures before reusing entries.
let fontMetadata: Record<string, unknown> = {}
let pendingFontWarmup: Promise<void>|undefined

/** Populate metadata in the background without compiling or writing a document. */
export async function warmTypstFontCache (fontPath = '', cwd = process.cwd()): Promise<void> {
  if (pendingFontWarmup !== undefined) {
    return await pendingFontWarmup
  }
  const task = runTypstTask({ cacheFontsOnly: true, fontPath, cwd: path.resolve(cwd) }, 60000, 'Typst font cache')
    .then(() => {})
  pendingFontWarmup = task
  try {
    await task
  } finally {
    pendingFontWarmup = undefined
  }
}

/** Compile into a job file; the exporter owns publication and cleanup. */
export async function compileTypst (
  source: string,
  target: string,
  cwd: string,
  { fontPath = '', failIfWarnings = false, timeoutMs = 10 * 60 * 1000 }: { fontPath?: string, failIfWarnings?: boolean, timeoutMs?: number } = {}
): Promise<string[]> {
  if (pendingFontWarmup !== undefined) {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout>|undefined
    try {
      // Reuse startup work, while keeping this export's own deadline.
      await Promise.race([
        pendingFontWarmup.catch(() => {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Typst WASM compilation timed out.')), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    timeoutMs = Math.max(1, timeoutMs - (Date.now() - started))
  }
  return await runTypstTask({ source, cwd: path.resolve(cwd), output: target, fontPath, failIfWarnings }, timeoutMs)
}

async function runTypstTask (job: Record<string, unknown>, timeoutMs: number, name = 'Typst WASM compilation'): Promise<string[]> {
  const bundled = path.join(__dirname, 'assets/typst')
  const packaged = existsSync(bundled)
  const driver = packaged ? path.join(bundled, 'driver') : path.resolve(__dirname, '../../../node_modules/@myriaddreamin/typst.ts/dist/cjs')
  const compiler = packaged ? path.join(bundled, 'compiler') : path.resolve(__dirname, '../../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg')
  const result = await runIsolatedTask<TypstResult>(
    path.join(__dirname, '../processes/typst-process.cjs'),
    { ...job, driver, compiler, fontMetadata },
    { name, timeoutMs }
  )
  if (result.fontMetadata !== undefined) {
    fontMetadata = result.fontMetadata
  }
  if (result.error !== undefined) {
    throw new Error(result.error)
  }
  return result.warnings
}
