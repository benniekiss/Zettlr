import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { activateHover, keymap, type EditorView } from '@codemirror/view'
import { forceLinting, forEachDiagnostic, linter, lintKeymap, type Diagnostic } from '@codemirror/lint'
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
  private documentDiagnostics: Diagnostic[] = []
  private readonly mappedDiagnostics = new Map<string, Diagnostic[]>()
  private readonly actions: DiagnosticActions

  constructor (private readonly view: EditorView, private readonly client: LSPClient, private readonly transport: MultiServerTransport) {
    this.actions = new DiagnosticActions(client, transport, view)
  }

  clear (): void {
    this.generation++
    this.actions.clear()
  }

  clearMapped (uri: string): void {
    this.mappedDiagnostics.delete(uri)
    // This can run from a CodeMirror ViewPlugin.update callback, where direct
    // dispatch is forbidden. Drop the cached mapping now and refresh afterward.
    queueMicrotask(() => {
      if (this.active) {this.display([ ...this.documentDiagnostics, ...[...this.mappedDiagnostics.values()].flat() ])}
    })
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
          const panelWasOpen = this.view.dom.querySelector('.cm-panel-lint') !== null
          loading = true
          this.actions.load(params.uri, item, server, current).then(actions => {
            if (!current()) {return}
            // Keep only the selected diagnostic expanded to bound retained edits.
            const expanded = diagnostics.map(base => base === diagnostic ? { ...base, actions } : base)
            const selected = expanded[diagnostics.indexOf(diagnostic)]
            const panelIndex = expanded.slice().sort((a, b) => a.from - b.from || a.to - b.to).indexOf(selected)
            this.display(expanded)

            // CodeMirror runs lint sources through a promise batch even when
            // they return synchronously. Wait until the native lint state has
            // accepted these actions before refreshing its panel or hover.
            const refresh = (): void => {
              if (!current()) {return}
              let updated = false
              forEachDiagnostic(this.view.state, active => { if (active === selected) {updated = true} })
              if (!updated) {
                setTimeout(refresh, 0)
                return
              }
              if (panelWasOpen) {
                const panel = this.view.dom.querySelector('.cm-panel-lint ul')
                const entry = panel?.children.item(panelIndex)
                entry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
              } else {
                activateHover(this.view, diagnostic.from, 1, {
                  until: transaction => transaction.docChanged || transaction.newSelection.main.head < diagnostic.from || transaction.newSelection.main.head > diagnostic.to
                })
              }
            }
            queueMicrotask(refresh)
          }).catch(err => {
            if (current()) {plugin.reportError(trans('Could not load code actions'), err)}
          }).finally(() => { loading = false })
        } }]
      }
      return diagnostic
    })
    this.documentDiagnostics = diagnostics
    this.display([ ...this.documentDiagnostics, ...[...this.mappedDiagnostics.values()].flat() ])
  }

  /** Map diagnostics for a virtual language document into this editor. */
  publishMapped (uri: string, params: ServerDiagnostics, text: string, baseOffset: number, version: number): void {
    if (!this.active || (params.version != null && params.version !== version)) {return}
    const lines = text.split('\n')
    const offset = (position: { line: number, character: number }): number => {
      const line = Math.max(0, Math.min(position.line, lines.length - 1))
      const column = Math.max(0, Math.min(position.character, lines[line].length))
      let result = column
      for (let index = 0; index < line; index++) {result += lines[index].length + 1}
      return Math.min(this.view.state.doc.length, baseOffset + result)
    }
    this.mappedDiagnostics.set(uri, params.diagnostics.map(item => ({
      from: offset(item.range.start),
      to: offset(item.range.end),
      severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info',
      source: item.source ?? 'yaml-language-server',
      message: typeof item.message === 'string' ? item.message : item.message.value
    })))
    this.display([ ...this.documentDiagnostics, ...[...this.mappedDiagnostics.values()].flat() ])
  }

  private display (diagnostics: Diagnostic[]): void {
    this.view.dispatch({ effects: diagnosticsEffect.of(diagnostics) })
    forceLinting(this.view)
  }
}
