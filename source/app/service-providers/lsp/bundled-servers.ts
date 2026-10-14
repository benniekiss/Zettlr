import { promises as fs } from 'fs'
import path from 'path'
import type { LanguageServerConfig } from '@common/lsp/config'

interface BundleMetadata {
  platform: string
  arch: string
  version: string
  executable: string
  libraryDirectory?: string
  mainClass?: string
}

export interface LanguageServerCommand {
  command: string
  args: string[]
  bundled: boolean
}

/** Resolve only bare known commands; explicit paths always take precedence. */
function bundledID (command: string, platform: string): string|undefined {
  const bare = platform === 'win32' ? command.toLowerCase().replace(/\.(exe|bat|cmd)$/, '') : command
  return ({ panache: 'panache', 'codebook-lsp': 'codebook', 'ltex-ls-plus': 'ltex-plus' } as Record<string, string>)[bare]
}

function bundlePath (root: string, relative: string): string|undefined {
  if (typeof relative !== 'string' || relative === '' || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    return undefined
  }
  const parts = relative.split(/[\\/]/)
  if (parts.includes('..')) {
    return undefined
  }
  return path.join(root, ...parts)
}

export async function resolveLanguageServerCommand (
  server: LanguageServerConfig,
  useBundled: boolean,
  resourceRoots: string[],
  platform: string = process.platform,
  arch: string = process.arch
): Promise<LanguageServerCommand> {
  const fallback = { command: server.command, args: server.args ?? [], bundled: false }
  const id = bundledID(server.command, platform)
  if (!useBundled || id === undefined) {
    return fallback
  }
  for (const resourceRoot of resourceRoots) {
    const root = path.join(resourceRoot, id)
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(root, 'bundle.json'), 'utf8')) as BundleMetadata
      if (metadata.platform !== platform || metadata.arch !== arch) {
        continue
      }
      const command = bundlePath(root, metadata.executable)
      if (command === undefined || !(await fs.stat(command)).isFile()) {
        continue
      }
      let args = fallback.args
      if (id === 'ltex-plus') {
        const libraries = bundlePath(root, metadata.libraryDirectory ?? '')
        if (libraries === undefined || !(await fs.stat(libraries)).isDirectory() || typeof metadata.mainClass !== 'string' || metadata.mainClass === '') {
          continue
        }
        // Launch the bundled JRE directly; Windows batch scripts require a shell.
        args = [ `-Dapp.home=${root}`, '-cp', path.join(libraries, '*'), metadata.mainClass, ...args ]
      }
      return { command, args, bundled: true }
    } catch (err) {
      // Builds may omit any or all servers. Use the configured system command.
    }
  }
  return fallback
}
