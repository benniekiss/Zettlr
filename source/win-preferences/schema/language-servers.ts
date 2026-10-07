import { parseLanguageServers } from '@common/lsp/config'
import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'

export function getLanguageServerFields (): PreferencesFieldset[] {
  return [{
    title: trans('Language servers'),
    group: PreferencesGroups.LanguageServers,
    help: undefined,
    infoString: trans('Configure installed stdio language servers as a JSON array. Each server needs name, command, and languages (e.g. ["markdown"]). Optional fields: args, enabled, cwd, env, initializationOptions, settings. Servers run when matching documents are opened. Interactive features use the first supporting server; diagnostics are combined.'),
    fields: [{
      type: 'text', model: 'languageServers', label: trans('Server configuration (JSON)'), multiline: true, saveOnBlur: true, reset: '[]',
      info: trans('Valid changes are applied when you leave this field.'),
      validate: value => {
        try { parseLanguageServers(value) } catch (err) {
          return err instanceof Error ? err.message : String(err)
        }
      }
    }]
  }]
}
