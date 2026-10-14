import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { forceLinting, linter, lintKeymap, openLintPanel, type Diagnostic } from '@codemirror/lint'
import { LSPPlugin, type LSPClient } from '@codemirror/lsp-client'
import type { Diagnostic as ServerDiagnostic } from 'vscode-languageserver-types'
import { trans } from '@common/i18n-renderer'
import { DiagnosticActions } from './code-actions'
import type { MultiServerTransport } from './transport'

const diagnosticsEffect = StateEffect.define<Diagnostic[]>()
const diagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update (diagnostics, transaction) {
    if (transaction.docChanged) {
      diagnostics = diagnostics.map(diagnostic => ({
        ...diagnostic, actions: undefined,
        from: transaction.changes.mapPos(diagnostic.from, 1),
        to: transaction.changes.mapPos(diagnostic.to, -1)
      })).filter(diagnostic => diagnostic.from <= diagnostic.to)
    }
    for (const effect of transaction.effects) {if (effect.is(diagnosticsEffect)) {diagnostics = effect.value}}
    return diagnostics
  }
})

export const resetLSPDiagnostics = diagnosticsEffect.of([])
export const lspDiagnostics: Extension = [ diagnosticsField, keymap.of(lintKeymap), linter(view => view.state.field(diagnosticsField), {
  needsRefresh: update => update.transactions.some(transaction => transaction.effects.some(effect => effect.is(diagnosticsEffect)))
}) ]

// Provenance is supplied by our transport without altering the original diagnostic.
export interface ServerDiagnostics { uri: string, version?: number, diagnostics: ServerDiagnostic[], zettlrServers?: number[] }

/** Own diagnostic presentation, on-demand fixes, and their invalidation. */
export class EditorDiagnostics {
  private generation = 0
  private active = true
  private readonly actions: DiagnosticActions

  constructor (private readonly view: EditorView, private readonly client: LSPClient, private readonly transport: MultiServerTransport) {
    this.actions = new DiagnosticActions(client, transport, view)
  }

  clear (): void {
    this.generation++
    this.actions.clear()
  }

  destroy (): void {
    this.active = false
    this.clear()
  }

  publish (params: ServerDiagnostics): void {
    if (!this.active) {return}
    const file = this.client.workspace.getFile(params.uri)
    const plugin = LSPPlugin.get(this.view)
    if (file == null || plugin == null || !plugin.syncedDoc.eq(file.doc) || (params.version != null && params.version !== file.version)) {return}
    const version = file.version
    const generation = ++this.generation
    const doc = this.view.state.doc
    const current = (): boolean => this.active && generation === this.generation && this.view.state.doc === doc && file.version === version
    const diagnostics: Diagnostic[] = params.diagnostics.map((item, index) => {
      const diagnostic: Diagnostic = {
        from: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.start, plugin.syncedDoc)),
        to: plugin.unsyncedChanges.mapPos(plugin.fromPosition(item.range.end, plugin.syncedDoc)),
        severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info',
        source: item.source,
        message: typeof item.message === 'string' ? item.message : item.message.value
      }
      const server = params.zettlrServers?.[index]
      if (plugin.unsyncedChanges.empty && server !== undefined && this.transport.supportsCodeActions(server)) {
        let loading = false
        diagnostic.actions = [{ name: trans('Show fixes'), apply: () => {
          if (loading || !current()) {return}
          loading = true
          this.actions.load(params.uri, item, server, current).then(actions => {
            if (!current()) {return}
            // Keep only the selected diagnostic expanded to bound retained edits.
            this.display(diagnostics.map(base => base === diagnostic ? { ...base, actions } : base))
            openLintPanel(this.view)
          }).catch(err => {
            if (current()) {plugin.reportError(trans('Could not load code actions'), err)}
          }).finally(() => { loading = false })
        } }]
      }
      return diagnostic
    })
    this.display(diagnostics)
  }

  private display (diagnostics: Diagnostic[]): void {
    this.view.dispatch({ effects: diagnosticsEffect.of(diagnostics) })
    forceLinting(this.view)
  }
}
