/** User-configured stdio language servers. Commands are executed without a shell. */
export interface LanguageServerConfig {
  name: string
  command: string
  args?: string[]
  languages: string[]
  enabled?: boolean
  cwd?: string
  env?: Record<string, string>
  initializationOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
}

export const recommendedLanguageServers: LanguageServerConfig[] = [
  { name: 'panache', command: 'panache', args: ['lsp'], languages: ['markdown'] },
  { name: 'codebook', command: 'codebook-lsp', args: ['serve'], languages: ['markdown'] },
  { name: 'ltex', command: 'ltex-ls-plus', languages: [ 'markdown', 'latex' ], settings: { ltex: { language: 'en-US' } } }
]

export function parseLanguageServers (json: string): LanguageServerConfig[] {
  const servers: unknown = JSON.parse(json)
  if (!Array.isArray(servers)) {
    throw new Error('Language servers must be a JSON array')
  }
  const names = new Set<string>()
  for (const value of servers as unknown[]) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Each server must be an object')
    }
    const server = value as Record<string, unknown>
    if (
      typeof server.name !== 'string' || server.name.trim() === '' ||
      typeof server.command !== 'string' || server.command.trim() === '' ||
      !Array.isArray(server.languages) || server.languages.length === 0 ||
      !server.languages.every((language: unknown) => typeof language === 'string' && language !== '')) {
      throw new Error('Each server needs a unique name, command, and nonempty languages array')
    }
    if (names.has(server.name)) {
      throw new Error(`Duplicate language server: ${server.name}`)
    }
    names.add(server.name)
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
      throw new Error('enabled must be boolean')
    }
    if (server.cwd !== undefined && typeof server.cwd !== 'string') {
      throw new Error('cwd must be a string')
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((arg: unknown) => typeof arg === 'string'))) {
      throw new Error('args must be an array of strings')
    }
    for (const key of [ 'env', 'settings', 'initializationOptions' ]) {
      if (server[key] !== undefined && (server[key] === null || typeof server[key] !== 'object' || Array.isArray(server[key]))) {
        throw new Error(`${key} must be an object`)
      }
    }
    if (server.env !== undefined && !Object.values(server.env as Record<string, unknown>).every(value => typeof value === 'string')) {
      throw new Error('env values must be strings')
    }
  }
  return servers as LanguageServerConfig[]
}
