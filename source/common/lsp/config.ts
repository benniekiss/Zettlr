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

const spellcheckRules: Record<string, string> = {
  ar: 'MORFOLOGIK_RULE_AR',
  ast: 'MORFOLOGIK_RULE_AST',
  be: 'MORFOLOGIK_RULE_BE_BY',
  br: 'MORFOLOGIK_RULE_BR_FR',
  ca: 'MORFOLOGIK_RULE_CA_ES',
  de: 'MORFOLOGIK_RULE_DE_DE',
  el: 'MORFOLOGIK_RULE_EL_GR',
  es: 'MORFOLOGIK_RULE_ES',
  fr: 'FR_SPELLING_RULE',
  ga: 'MORFOLOGIK_RULE_GA_IE',
  it: 'MORFOLOGIK_RULE_IT_IT',
  lt: 'MORFOLOGIK_RULE_LT_LT',
  ml: 'MORFOLOGIK_RULE_ML_IN',
  nl: 'MORFOLOGIK_RULE_NL_NL',
  pl: 'MORFOLOGIK_RULE_PL_PL',
  ro: 'MORFOLOGIK_RULE_RO_RO',
  ru: 'MORFOLOGIK_RULE_RU_RU',
  sk: 'MORFOLOGIK_RULE_SK_SK',
  sl: 'MORFOLOGIK_RULE_SL_SI',
  sr: 'MORFOLOGIK_RULE_SR_EKAVIAN',
  tl: 'MORFOLOGIK_RULE_TL',
  uk: 'MORFOLOGIK_RULE_UK_UA'
}

function spellcheckRuleForLanguage (language: string): string {
  const [ primary, region ] = language.split('-')
  if (primary === 'en') {
    return `MORFOLOGIK_RULE_EN_${(region ?? 'US').toUpperCase()}`
  }
  return spellcheckRules[primary] ?? `MORFOLOGIK_RULE_${language.replace(/-/g, '_').toUpperCase()}`
}

export function getRecommendedLanguageServers (appLanguage = 'en-US'): LanguageServerConfig[] {
  const language = appLanguage.replace(/_/g, '-')
  return [
    { name: 'panache', command: 'panache', args: ['lsp'], languages: ['markdown'] },
    { name: 'yaml', command: 'yaml-language-server', args: ['--stdio'], languages: ['yaml'], settings: { yaml: { schemaStore: { enable: false } } } },
    { name: 'codebook', command: 'codebook-lsp', args: ['serve'], languages: ['markdown'] },
    {
      name: 'ltex',
      command: 'ltex-ls-plus',
      languages: [ 'markdown', 'latex' ],
      settings: {
        ltex: {
          language,
          additionalRules: { enablePickyRules: true },
          disabledRules: { [language]: [spellcheckRuleForLanguage(language)] }
        }
      }
    }
  ]
}

export const recommendedLanguageServers = getRecommendedLanguageServers()

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

