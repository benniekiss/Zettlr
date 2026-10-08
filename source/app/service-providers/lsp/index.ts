import { app, ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import ProviderContract from '../provider-contract'
import type ConfigProvider from '../config'
import type LogProvider from '../log'
import { parseLanguageServers, type LanguageServerConfig } from '@common/lsp/config'
import { frameLSPMessage, LSPMessageReader } from '@common/lsp/framing'
import { resolveLanguageServerCommand } from './bundled-servers'

interface Session {
  process: ChildProcessWithoutNullStreams
  owner: WebContents
  config: LanguageServerConfig
  rootUri: string
}

/** Only starts commands from the saved application configuration. */
export default class LSPProvider extends ProviderContract {
  private readonly sessions = new Map<string, Session>()

  constructor (private readonly logger: LogProvider, private readonly config: ConfigProvider) {
    super()
    ipcMain.handle('lsp-provider', async (event, payload) => {
      if (payload.command === 'start') {
        const servers = parseLanguageServers(this.config.get('languageServers'))
        const server = servers.find(server => server.name === payload.name && server.enabled !== false)
        if (server === undefined) {
          throw new Error('Language server is not configured or enabled')
        }
        const cwd = server.cwd ?? dirname(payload.path)
        const roots = [join(global.process.resourcesPath, 'language-servers')]
        if (!app.isPackaged) {
          roots.push(join(__dirname, '../../resources/lsp', `${global.process.platform}-${global.process.arch}`, 'language-servers'))
        }
        const launcher = await resolveLanguageServerCommand(server, this.config.get('useBundledLanguageServers') === true, roots)
        this.logger.verbose(`[LSP ${server.name}] Starting ${launcher.bundled ? 'bundled' : 'configured'} server: ${launcher.command}`)
        const process = spawn(launcher.command, launcher.args, {
          cwd, env: { ...global.process.env, ...server.env }, windowsHide: true, shell: false
        })
        const id = randomUUID()
        const owner = event.sender
        this.sessions.set(id, { process, owner, config: server, rootUri: pathToFileURL(cwd).href })
        const send = (message: string): void => {
          if (!owner.isDestroyed()) {owner.send('lsp-message', { id, message })}
        }
        const reader = new LSPMessageReader(message => {
          const value = JSON.parse(message)
          if (value.error !== undefined) {
            this.logger.error(`[LSP ${server.name}] Server request failed`, value.error)
          }
          if (value.id === 'zettlr-shutdown' && value.method === undefined) {
            process.stdin.end(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', method: 'exit' })))
            return
          }
          // CodeMirror doesn't implement server configuration requests.
          if (value.method === 'workspace/configuration' && value.id !== undefined) {
            const result = value.params.items.map((item: { section?: string }) => {
              let settings: any = server.settings ?? {}
              for (const part of item.section?.split('.') ?? []) {
                settings = settings?.[part]
              }
              return settings ?? null
            })
            process.stdin.write(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', id: value.id, result })))
          } else if (value.method === 'window/workDoneProgress/create') {
            process.stdin.write(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: null })))
          } else {
            send(message)
          }
        })
        process.stdout.on('data', (chunk: Buffer) => {
          try { reader.push(chunk) } catch (err) {
            this.logger.error(`[LSP ${server.name}] Invalid server message`, err)
            this.stop(id)
          }
        })
        process.stderr.on('data', (chunk: Buffer) => this.logger.verbose(`[LSP ${server.name}] ${chunk.toString().slice(0, 4096)}`))
        process.stdin.on('error', err => this.logger.error(`[LSP ${server.name}] Write failed`, err))
        process.on('exit', () => {
          this.sessions.delete(id)
          if (!owner.isDestroyed()) {owner.send('lsp-message', { id, closed: true })}
        })
        const destroyed = (): void => this.stop(id)
        owner.once('destroyed', destroyed)
        process.once('close', () => owner.removeListener('destroyed', destroyed))
        await new Promise<void>((resolve, reject) => {
          process.once('spawn', resolve)
          process.once('error', err => {
            this.logger.error(`[LSP ${server.name}] Process failed`, err)
            this.stop(id)
            reject(err)
          })
        })
        return { id, uri: pathToFileURL(payload.path).href, rootUri: pathToFileURL(cwd).href }
      }
      const session = this.sessions.get(payload.id)
      if (session === undefined || session.owner !== event.sender) {
        throw new Error('Unknown LSP session')
      }
      if (payload.command === 'stop') {this.stop(payload.id)} else if (payload.command === 'send') {
        const value = JSON.parse(payload.message)
        if (value.method === 'initialize') {
          value.params.processId = global.process.pid
          value.params.rootUri = session.rootUri
          value.params.initializationOptions = session.config.initializationOptions
        }
        session.process.stdin.write(frameLSPMessage(JSON.stringify(value)))
        if (value.method === 'initialized') {
          session.process.stdin.write(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: session.config.settings ?? {} } })))
        }
      }
    })
  }

  private stop (id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined) {
      return
    }
    this.sessions.delete(id)
    if (session.process.stdin.writable) {
      session.process.stdin.write(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', id: 'zettlr-shutdown', method: 'shutdown' })))
    }
    const timer = setTimeout(() => {
      if (session.process.exitCode === null && session.process.signalCode === null) {
        session.process.kill('SIGKILL')
      }
    }, 2000)
    timer.unref()
    session.process.once('close', () => clearTimeout(timer))
    if (!session.owner.isDestroyed()) {session.owner.send('lsp-message', { id, closed: true })}
  }

  async boot (): Promise<void> {}

  async shutdown (): Promise<void> {
    for (const id of this.sessions.keys()) {
      this.stop(id)
    }
    ipcMain.removeHandler('lsp-provider')
  }
}
