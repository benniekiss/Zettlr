import { minimatch } from 'minimatch'

export interface FileEvent { uri: string, type: number }
export interface FileSystemWatcher {
  globPattern: string|{ baseUri: string|{ uri: string }, pattern: string }
  kind?: number
}

function relativeURI (uri: string, base: string): string|undefined {
  const file = new URL(uri)
  const root = new URL(base)
  const prefix = root.pathname.replace(/\/$/, '') + '/'
  if (file.protocol !== 'file:' || root.protocol !== file.protocol || root.host !== file.host || !file.pathname.startsWith(prefix)) {return undefined}
  return decodeURIComponent(file.pathname.slice(prefix.length))
}

/** Match registered LSP globs against events from Zettlr's existing workspace watchers. */
export function matchesWatcher (event: FileEvent, watcher: FileSystemWatcher, rootUri: string): boolean {
  if (((watcher.kind ?? 7) & (event.type === 3 ? 4 : event.type)) === 0) {return false}
  const glob = watcher.globPattern
  const base = typeof glob === 'string' ? rootUri : typeof glob.baseUri === 'string' ? glob.baseUri : glob.baseUri.uri
  const relative = relativeURI(event.uri, base)
  if (relative === undefined) {return false}
  const pattern = typeof glob === 'string' ? glob : glob.pattern
  const absolute = decodeURIComponent(new URL(event.uri).pathname)
  const path = pattern.startsWith('/') ? absolute : /^[A-Za-z]:\//.test(pattern) ? absolute.replace(/^\/(?=[A-Za-z]:\/)/, '') : relative
  return minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true, noext: true })
}
