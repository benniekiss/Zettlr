import assert from 'assert'
import { pathToFileURL } from 'url'
import { withZettlrYamlSchemas } from '../source/app/service-providers/lsp/yaml-schema-settings'

describe('YAML Language Server schema associations', () => {
  it('associates Pandoc schemas with frontmatter and Zettlr default profiles', () => {
    const settings = { yaml: { schemaStore: { enable: false }, schemas: { 'file:///custom/schema.json': 'custom.yaml' } } }
    const result = withZettlrYamlSchemas('yaml-language-server', settings, '/app/assets/defaults', '/user/Zettlr/defaults')
    const yaml = result.yaml as { schemaStore: { enable: boolean }, schemas: Record<string, string[]> }
    assert.deepStrictEqual(yaml.schemaStore, { enable: false })
    assert.deepStrictEqual(yaml.schemas['file:///custom/schema.json'], [ 'custom.yaml' ])
    assert.deepStrictEqual(yaml.schemas[pathToFileURL('/app/assets/defaults/pandoc-metadata-schema.json').href], [ '**/*.md.zettlr-frontmatter.yaml' ])
    assert.deepStrictEqual(yaml.schemas[pathToFileURL('/app/assets/defaults/pandoc-defaults-schema.json').href], [ '/user/Zettlr/defaults/*.yaml', '/user/Zettlr/defaults/*.yml' ])
  })

  it('leaves non-YAML servers unchanged', () => {
    const settings = { yaml: { schemas: {} } }
    assert.strictEqual(withZettlrYamlSchemas('panache', settings, '/app/assets/defaults', '/user/Zettlr/defaults'), settings)
  })
})
