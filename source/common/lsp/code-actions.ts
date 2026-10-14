import { ChangeSet, Transaction, type Text } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { LSPPlugin, type LSPClient } from '@codemirror/lsp-client'
import type { Action } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'
import type { CodeAction, Command, Diagnostic, Position, TextEdit, AnnotatedTextEdit, WorkspaceEdit } from 'vscode-languageserver-types'
import type { MultiServerTransport } from './transport'

/** Validate the whole edit before dispatching, so unsupported edits stay atomic. */
export function applyWorkspaceEdit (client: LSPClient, edit: WorkspaceEdit): void {
  client.sync()
  const edits = new Map<string, Array<TextEdit|AnnotatedTextEdit>>()
  const add = (uri: string, changes: Array<TextEdit|AnnotatedTextEdit>): void => { edits.set(uri, [ ...edits.get(uri) ?? [], ...changes ]) }
  for (const [ uri, changes ] of Object.entries(edit.changes ?? {})) {add(uri, changes)}
  for (const change of edit.documentChanges ?? []) {
    if (!('textDocument' in change)) {throw new Error('File creation, deletion, and renaming are not supported')}
    const file = client.workspace.getFile(change.textDocument.uri)
    if (change.textDocument.version !== null && change.textDocument.version !== file?.version) {throw new Error('The document changed; request a new code action')}
    if (change.edits.some(edit => !('newText' in edit))) {throw new Error('Snippet edits are not supported')}
    add(change.textDocument.uri, change.edits as Array<TextEdit|AnnotatedTextEdit>)
  }
  const updates = [...edits].map(([ uri, changes ]) => {
    const file = client.workspace.getFile(uri)
    const view = file?.getView()
    if (view === undefined || view === null) {throw new Error('Code actions can only edit documents open in this editor')}
    if (!view.state.doc.eq(file!.doc)) {throw new Error('The document changed; request a new code action')}
    const position = (pos: Position): number => {
      if (!Number.isInteger(pos.line) || !Number.isInteger(pos.character) || pos.line < 0 || pos.line >= view.state.doc.lines || pos.character < 0) {throw new Error('Invalid code action range')}
      const line = view.state.doc.line(pos.line + 1)
      if (pos.character > line.length) {throw new Error('Invalid code action range')}
      return line.from + pos.character
    }
    const specs = changes.map(change => {
      if ('annotationId' in change && edit.changeAnnotations?.[change.annotationId]?.needsConfirmation === true) {throw new Error('This edit requires confirmation, which is not supported')}
      const from = position(change.range.start)
      const to = position(change.range.end)
      if (to < from || typeof change.newText !== 'string') {throw new Error('Invalid code action edit')}
      return { from, to, insert: change.newText }
    }).sort((a, b) => a.from - b.from || a.to - b.to)
    for (let i = 1; i < specs.length; i++) {
      if (specs[i].from < specs[i - 1].to) {throw new Error('Overlapping code action edits')}
    }
    return { view, changes: ChangeSet.of(specs, view.state.doc.length) }
  })
  for (const { view, changes } of updates) {
    view.dispatch({ changes, annotations: [ Transaction.userEvent.of('input'), isolateHistory.of('full') ] })
  }
}

/** Load native lint actions without flooding a server with concurrent requests. */
export class DiagnosticActions {
  private doc: Text|undefined
  private pending = 0
  private readonly cache = new Map<string, Promise<Array<CodeAction|Command>>>()

  constructor (private readonly client: LSPClient, private readonly transport: MultiServerTransport, private readonly view: EditorView) {}

  clear (): void {
    this.doc = undefined
    this.cache.clear()
  }

  async load (uri: string, diagnostic: Diagnostic, server: number, current: () => boolean): Promise<Action[]> {
    if (!current() || !this.transport.supportsCodeActions(server)) {return []}
    const doc = this.view.state.doc
    if (doc !== this.doc) {
      this.doc = doc
      this.cache.clear()
    }
    const version = this.client.workspace.getFile(uri)?.version
    const key = JSON.stringify([ server, uri, version, diagnostic ])
    let pending = this.cache.get(key)
    if (pending === undefined) {
      if (this.pending >= 4) {throw new Error('Code actions are still loading; try again shortly')}
      this.pending++
      pending = this.transport.requestCodeActions(this.client, server, uri, diagnostic).then(result => {
        const actions = result ?? []
        if (JSON.stringify(actions).length > 512 * 1024 && this.cache.get(key) === pending) {this.cache.delete(key)}
        return actions
      }).finally(() => { this.pending-- })
      if (this.cache.size >= 8) {this.cache.delete(this.cache.keys().next().value!)}
      this.cache.set(key, pending)
    }
    try {
      const actions = await pending
      return current() ? actions.filter(supportedAction).map(action => this.action(server, action, doc, version)) : []
    } catch (err) {
      if (this.cache.get(key) === pending) {this.cache.delete(key)}
      throw err
    }
  }

  private action (server: number, action: CodeAction|Command, doc: Text, version: number|undefined): Action {
    return {
      name: action.title,
      apply: view => {
        const execute = async (): Promise<void> => {
          const current = (): boolean => this.client.serverCapabilities !== null && LSPPlugin.get(view)?.client === this.client && this.transport.supportsCodeActions(server) && view.state.doc === doc && this.client.workspace.getFile(LSPPlugin.get(view)!.uri)?.version === version
          if (!current()) {throw new Error('The document changed; request a new code action')}
          this.client.sync()
          if (!current()) {throw new Error('The document changed; request a new code action')}
          const resolved = typeof action.command === 'string' ? action : await this.transport.resolveCodeAction(this.client, server, action as CodeAction)
          if (!current()) {throw new Error('The document changed; request a new code action')}
          if ('disabled' in resolved && resolved.disabled !== undefined) {throw new Error(resolved.disabled.reason)}
          if (!supportedAction(resolved)) {throw new Error('This code action requires an unsupported client command')}
          if ('edit' in resolved && resolved.edit !== undefined) {applyWorkspaceEdit(this.client, resolved.edit)}
          const command = typeof resolved.command === 'string' ? resolved as Command : resolved.command
          if (command !== undefined) {await this.transport.executeCommand(this.client, server, command)}
          view.focus()
        }
        execute().catch(err => LSPPlugin.get(view)?.reportError('Could not apply code action', err))
      }
    }
  }
}

/** LTeX's private commands must be handled by a client, not sent to the server. */
function supportedAction (action: CodeAction|Command): boolean {
  if ('disabled' in action && action.disabled !== undefined) {return false}
  const command = typeof action.command === 'string' ? action.command : action.command?.command
  return command === undefined || !command.startsWith('_ltex.')
}
