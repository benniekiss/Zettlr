import { ChangeSet, type Text } from '@codemirror/state'
import { getSyncedVersion } from '@codemirror/collab'
import { LSPPlugin, Workspace, type WorkspaceFile, type LSPClient } from '@codemirror/lsp-client'
import type { EditorView, ViewUpdate } from '@codemirror/view'

function authorityVersion (view: EditorView): number|undefined {
  try { return getSyncedVersion(view.state) } catch { return undefined }
}

function compareViews (a: EditorView, b: EditorView, doc: Text): number {
  return (authorityVersion(b) ?? 0) - (authorityVersion(a) ?? 0) || Number(!b.state.doc.eq(doc)) - Number(!a.state.doc.eq(doc))
}

class SharedFile implements WorkspaceFile {
  readonly views = new Set<EditorView>()
  version: number
  doc: Text
  authorityVersion: number|undefined

  constructor (readonly uri: string, readonly languageId: string, view: EditorView, version: number) {
    this.views.add(view)
    this.doc = view.state.doc
    this.version = version
    this.authorityVersion = authorityVersion(view)
  }

  getView (main?: EditorView): EditorView|null {
    if (main !== undefined && this.views.has(main)) {return main}
    return [...this.views].sort((a, b) => compareViews(a, b, this.doc))[0] ?? null
  }
}

/** One synchronized document per URI, with Zettlr's authority resolving pane edits. */
export class EditorWorkspace extends Workspace {
  constructor (client: LSPClient, private readonly onClose?: (uri: string) => void) { super(client) }

  files: SharedFile[] = []
  private readonly versions = new Map<string, number>()

  openFile (uri: string, languageId: string, view: EditorView): void {
    const existing = this.files.find(file => file.uri === uri)
    if (existing !== undefined) { existing.views.add(view); return }
    const file = new SharedFile(uri, languageId, view, (this.versions.get(uri) ?? -1) + 1)
    this.versions.set(uri, file.version)
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile (uri: string, view: EditorView): void {
    const file = this.files.find(file => file.uri === uri)
    if (file === undefined) {return}
    file.views.delete(view)
    if (file.views.size === 0) {
      this.files = this.files.filter(other => other !== file)
      this.client.didClose(uri)
      this.onClose?.(uri)
    }
  }

  syncFiles (): Array<{ file: WorkspaceFile, prevDoc: Text, changes: ChangeSet }> {
    const updates: Array<{ file: WorkspaceFile, prevDoc: Text, changes: ChangeSet }> = []
    for (const file of this.files) {
      // A current pane may send local edits immediately, as CodeMirror expects.
      // A lagging pane must catch up or receive a newer authority revision first.
      const candidates = [...file.views].filter(view => {
        const version = authorityVersion(view)
        const plugin = LSPPlugin.get(view)
        if (plugin === null) {return false}
        if (version !== undefined && version < (file.authorityVersion ?? -1)) {return false}
        return (version !== undefined && version > (file.authorityVersion ?? -1)) || plugin.syncedDoc.eq(file.doc) || view.state.doc.eq(file.doc)
      }).sort((a, b) => compareViews(a, b, file.doc))
      const source = candidates[0]
      if (source !== undefined && !source.state.doc.eq(file.doc)) {
        const prevDoc = file.doc
        const plugin = LSPPlugin.get(source)!
        // Preserve native incremental sync when the pane has the same base.
        const changes = plugin.syncedDoc.eq(prevDoc) ? plugin.unsyncedChanges : ChangeSet.of({ from: 0, to: prevDoc.length, insert: source.state.doc }, prevDoc.length)
        file.doc = source.state.doc
        file.version++
        file.authorityVersion = authorityVersion(source)
        this.versions.set(file.uri, file.version)
        updates.push({ file, prevDoc, changes })
      }
      if (source !== undefined) {file.authorityVersion = authorityVersion(source)}
      for (const view of file.views) {
        if (view.state.doc.eq(file.doc)) {LSPPlugin.get(view)?.clear()}
      }
    }
    return updates
  }
}

/** Acknowledgements can change collab state without changing document text. */
export function authorityChanged (update: ViewUpdate): boolean {
  try { return getSyncedVersion(update.startState) !== getSyncedVersion(update.state) } catch { return false }
}
