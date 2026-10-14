import { dirname, isAbsolute, relative, resolve, sep } from 'path'

/** Use the most specific open workspace, falling back to standalone-file scope. */
export function languageServerRoot (file: string, workspaces: string[]): string {
  const path = resolve(file)
  return workspaces.map(root => resolve(root)).filter(root => {
    const child = relative(root, path)
    return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }).sort((a, b) => b.length - a.length)[0] ?? dirname(path)
}
