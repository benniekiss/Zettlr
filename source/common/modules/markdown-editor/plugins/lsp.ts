import { Compartment, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { forceLinting } from '@codemirror/lint'
import { lspDiagnostics, resetLSPDiagnostics } from '@common/lsp/diagnostics'
import { acquireSession, type SessionLease } from '@common/lsp/session'

/** Views attach to a window/workspace session; native Workspace owns documents. */
export function languageServers (path: string, language: string): Extension {
  const compartment = new Compartment()
  return [ lspDiagnostics, compartment.of([]), ViewPlugin.fromClass(class {
    private generation = 0
    private signature = ''
    private lease?: SessionLease
    private destroyed = false
    private readonly stopConfig: () => void

    constructor (private readonly view: EditorView) {
      this.stopConfig = window.ipc.on('config-provider', () => this.configure())
      this.configure()
    }

    update (update: ViewUpdate): void { this.lease?.session.update(this.view, update) }

    private configure (): void {
      const config: string = window.config.get('languageServers') ?? '[]'
      const bundled: boolean = window.config.get('useBundledLanguageServers') ?? true
      const signature = JSON.stringify([ config, bundled, window.config.get('app.openWorkspaces') ])
      if (this.destroyed || signature === this.signature) {return}
      this.signature = signature
      const generation = ++this.generation
      queueMicrotask(() => {
        if (this.destroyed || generation !== this.generation) {return}
        this.lease?.release()
        this.lease = undefined
        this.view.dispatch({ effects: [ compartment.reconfigure([]), resetLSPDiagnostics ] })
        forceLinting(this.view)
        this.connect(config, bundled, generation).catch(err => console.error('[LSP]', err))
      })
    }

    private async connect (config: string, bundled: boolean, generation: number): Promise<void> {
      const lease = await acquireSession(this.view, path, language, config, bundled, () => !this.destroyed && generation === this.generation)
      if (lease === undefined) {return}
      if (this.destroyed || generation !== this.generation) { lease.release(); return }
      this.lease = lease
      try {
        await lease.session.ready
        if (this.destroyed || generation !== this.generation) {return}
        lease.session.attach(this.view)
        this.view.dispatch({ effects: compartment.reconfigure(lease.session.client.plugin(lease.uri, language)) })
        lease.session.client.sync()
        lease.session.replay(this.view)
        forceLinting(this.view)
      } catch (err) {
        if (this.lease === lease) { lease.release(); this.lease = undefined }
        if (!this.destroyed && generation === this.generation) {throw err}
      }
    }

    destroy (): void {
      this.destroyed = true
      this.generation++
      this.stopConfig()
      this.lease?.release()
    }
  }) ]
}
