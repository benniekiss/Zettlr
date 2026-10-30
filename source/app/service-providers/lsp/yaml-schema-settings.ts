import path from 'path'
import { pathToFileURL } from 'url'

/** Add Zettlr's Pandoc schemas without discarding a user's YAML schema mappings. */
export function withZettlrYamlSchemas (command: string, settings: Record<string, unknown>, schemaDirectory: string, defaultsDirectory: string): Record<string, unknown> {
  const executable = command.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.(exe|cmd|bat)$/i, '')
  if (executable !== 'yaml-language-server') {return settings}

  const yamlSettings = settings.yaml !== null && typeof settings.yaml === 'object' && !Array.isArray(settings.yaml)
    ? settings.yaml as Record<string, unknown>
    : {}
  const configuredSchemas = yamlSettings.schemas !== null && typeof yamlSettings.schemas === 'object' && !Array.isArray(yamlSettings.schemas)
    ? yamlSettings.schemas as Record<string, unknown>
    : {}
  const schemas: Record<string, string[]> = {}
  for (const [ uri, patterns ] of Object.entries(configuredSchemas)) {
    schemas[uri] = typeof patterns === 'string'
      ? [patterns]
      : Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === 'string') : []
  }

  const metadataSchema = pathToFileURL(path.join(schemaDirectory, 'pandoc-metadata-schema.json')).href
  const defaultsSchema = pathToFileURL(path.join(schemaDirectory, 'pandoc-defaults-schema.json')).href
  const addPatterns = (uri: string, additions: string[]): void => {
    const combined = new Set(schemas[uri] ?? [])
    for (const pattern of additions) {combined.add(pattern)}
    schemas[uri] = Array.from(combined)
  }
  addPatterns(metadataSchema, ['**/*.md.zettlr-frontmatter.yaml'])
  addPatterns(defaultsSchema, [
    path.join(defaultsDirectory, '*.yaml').replace(/\\/g, '/'),
    path.join(defaultsDirectory, '*.yml').replace(/\\/g, '/')
  ])

  return { ...settings, yaml: { ...yamlSettings, schemas } }
}
