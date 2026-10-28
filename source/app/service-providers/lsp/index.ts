import { app, ipcMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import path, { join } from 'path'
import { pathToFileURL } from 'url'
import ProviderContract from '../provider-contract'
import type ConfigProvider from '../config'
import type LogProvider from '../log'
import { parseLanguageServers, type LanguageServerConfig } from '@common/lsp/config'
import { frameLSPMessage, LSPMessageReader } from '@common/lsp/framing'
import { resolveLanguageServerCommand } from './bundled-servers'
import { languageServerRoot } from './workspace-root'
import { withZettlrYamlSchemas } from './yaml-schema-settings'

interface Session {
  process: ChildProcessWithoutNullStreams|UtilityProcess
  utility: boolean
  owner: WebContents
  config: LanguageServerConfig
  settings: Record<string, unknown>
  rootUri: string
}

/** Only starts commands from the saved application configuration. */
export default class LSPProvider extends ProviderContract {
  private readonly sessions = new Map<string, Session>()

  constructor (private readonly logger: LogProvider, private readonly config: ConfigProvider) {
    super()
    ipcMain.handle('lsp-provider', async (event, payload) => {
      const workspaces = this.config.get('app.openWorkspaces')
      if (payload.command === 'resolve') {
        const root = languageServerRoot(payload.path, Array.isArray(workspaces) ? workspaces : [])
        return { uri: pathToFileURL(payload.path).href, rootUri: pathToFileURL(root).href }
      }
      if (payload.command === 'start') {
        const servers = parseLanguageServers(this.config.get('languageServers'))
        const server = servers.find(server => server.name === payload.name && server.enabled !== false)
        if (server === undefined) {
          throw new Error('Language server is not configured or enabled')
        }
        const cwd = server.cwd ?? languageServerRoot(payload.path, Array.isArray(workspaces) ? workspaces : [])
        const serverSettings = withZettlrYamlSchemas(
          server.command,
          server.settings ?? {},
          path.join(__dirname, 'assets', 'defaults'),
          path.join(app.getPath('userData'), 'defaults')
        )
        const roots = [join(global.process.resourcesPath, 'language-servers')]
        if (!app.isPackaged) {
          roots.push(join(__dirname, '../../resources/lsp', `${global.process.platform}-${global.process.arch}`, 'language-servers'))
        }
        const launcher = await resolveLanguageServerCommand(server, this.config.get('useBundledLanguageServers') === true, roots)
        const owner = event.sender
        if (owner.isDestroyed()) {throw new Error('Language server window closed during startup')}
        this.logger.verbose(`[LSP ${server.name}] Starting ${launcher.bundled ? 'bundled' : 'configured'} server: ${launcher.command}`)
        const childEnv = { ...global.process.env, ...server.env }
        const child = launcher.utilityProcess === true
          ? utilityProcess.fork(launcher.command, launcher.args, { cwd, env: childEnv, stdio: 'ignore' })
          : spawn(launcher.command, launcher.args, { cwd, env: childEnv, windowsHide: true, shell: false })
        const utility = launcher.utilityProcess === true
        const id = randomUUID()
        this.sessions.set(id, { process: child, utility, owner, config: server, settings: serverSettings, rootUri: pathToFileURL(cwd).href })
        const send = (message: string): void => {
          if (!owner.isDestroyed()) {owner.send('lsp-message', { id, message })}
        }
        const write = (value: unknown): void => {
          const message = JSON.stringify(value)
          if (utility) {
            (child as UtilityProcess).postMessage(JSON.parse(message))
          } else {
            (child as ChildProcessWithoutNullStreams).stdin.write(frameLSPMessage(message))
          }
        }
        const reader = new LSPMessageReader(message => {
          const value = JSON.parse(message)
          if (value.error !== undefined) {
            this.logger.error(`[LSP ${server.name}] Server request failed`, value.error)
          }
          if (value.id === 'zettlr-shutdown' && value.method === undefined) {
            if (utility) {
              write({ jsonrpc: '2.0', method: 'exit' })
            } else {
              (child as ChildProcessWithoutNullStreams).stdin.end(frameLSPMessage(JSON.stringify({ jsonrpc: '2.0', method: 'exit' })))
            }
            return
          }
          // CodeMirror doesn't implement server configuration requests.
          if (value.method === 'workspace/configuration' && value.id !== undefined) {
            const result = value.params.items.map((item: { section?: string }) => {
              let sectionSettings: unknown = serverSettings
              for (const part of item.section?.split('.') ?? []) {
                sectionSettings = sectionSettings !== null && typeof sectionSettings === 'object'
                  ? (sectionSettings as Record<string, unknown>)[part]
                  : undefined
              }
              return sectionSettings ?? null
            })
            write({ jsonrpc: '2.0', id: value.id, result })
          } else if (value.method === 'window/workDoneProgress/create') {
            write({ jsonrpc: '2.0', id: value.id, result: null })
          } else {
            send(message)
          }
        })
        if (utility) {
          (child as UtilityProcess).on('message', message => {
            try { reader.push(Buffer.from(frameLSPMessage(JSON.stringify(message)))) } catch (err) {
              this.logger.error(`[LSP ${server.name}] Invalid server message`, err)
              this.stop(id)
            }
          })
          const stderr = (child as UtilityProcess).stderr
          stderr?.on('data', chunk => this.logger.verbose(`[LSP ${server.name}] ${chunk.toString().slice(0, 4096)}`))
        } else {
          const process = child as ChildProcessWithoutNullStreams
          process.stdout.on('data', (chunk: Buffer) => {
            try { reader.push(chunk) } catch (err) {
              this.logger.error(`[LSP ${server.name}] Invalid server message`, err)
              this.stop(id)
            }
          })
          process.stderr.on('data', (chunk: Buffer) => this.logger.verbose(`[LSP ${server.name}] ${chunk.toString().slice(0, 4096)}`))
          process.stdin.on('error', err => this.logger.error(`[LSP ${server.name}] Write failed`, err))
        }
        const exited = (): void => {
          this.sessions.delete(id)
          if (!owner.isDestroyed()) {owner.send('lsp-message', { id, closed: true })}
        }
        const destroyed = (): void => this.stop(id)
        owner.once('destroyed', destroyed)
        let waitForSpawn: Promise<void>
        if (utility) {
          const utilityChild = child as UtilityProcess
          utilityChild.on('exit', exited)
          utilityChild.once('exit', () => owner.removeListener('destroyed', destroyed))
          waitForSpawn = new Promise<void>((resolve, reject) => {
            utilityChild.once('spawn', resolve)
            utilityChild.once('error', (type, location, report) => reject(new Error(`${type}: ${location} ${report}`)))
          })
        } else {
          const nodeChild = child as ChildProcessWithoutNullStreams
          nodeChild.on('exit', exited)
          nodeChild.once('close', () => owner.removeListener('destroyed', destroyed))
          waitForSpawn = new Promise<void>((resolve, reject) => {
            nodeChild.once('spawn', resolve)
            nodeChild.once('error', err => {
              this.logger.error(`[LSP ${server.name}] Process failed`, err)
              this.stop(id)
              reject(err)
            })
          })
        }
        await waitForSpawn
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
        if (session.utility) {
          (session.process as UtilityProcess).postMessage(value)
        } else {
          (session.process as ChildProcessWithoutNullStreams).stdin.write(frameLSPMessage(JSON.stringify(value)))
        }
        if (value.method === 'initialized') {
          const settings = { jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: session.settings } }
          if (session.utility) {
            (session.process as UtilityProcess).postMessage(settings)
          } else {
            (session.process as ChildProcessWithoutNullStreams).stdin.write(frameLSPMessage(JSON.stringify(settings)))
          }
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
    const shutdown = { jsonrpc: '2.0', id: 'zettlr-shutdown', method: 'shutdown' }
    if (session.utility) {
      (session.process as UtilityProcess).postMessage(shutdown)
    } else if ((session.process as ChildProcessWithoutNullStreams).stdin.writable) {
      (session.process as ChildProcessWithoutNullStreams).stdin.write(frameLSPMessage(JSON.stringify(shutdown)))
    }
    const timer = setTimeout(() => {
      if (session.utility) {
        (session.process as UtilityProcess).kill()
      } else if ((session.process as ChildProcessWithoutNullStreams).exitCode === null && (session.process as ChildProcessWithoutNullStreams).signalCode === null) {
        (session.process as ChildProcessWithoutNullStreams).kill('SIGKILL')
      }
    }, 2000)
    timer.unref()
    if (session.utility) {
      (session.process as UtilityProcess).once('exit', () => clearTimeout(timer))
    } else {
      (session.process as ChildProcessWithoutNullStreams).once('close', () => clearTimeout(timer))
    }
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
