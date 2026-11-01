import { parseLanguageServers, recommendedLanguageServers } from '@common/lsp/config'
import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'

export function getLanguageServerFields (): PreferencesFieldset[] {
  return [{
    title: trans('Language servers'),
    group: PreferencesGroups.LanguageServers,
    help: undefined,
    infoString: trans('Configure stdio language servers as a JSON array. Each server needs name, command, and languages (e.g. ["markdown"]). Optional fields: args, enabled, cwd, env, initializationOptions, settings. Servers run when matching documents are opened. Interactive features use the first supporting server; diagnostics are combined.'),
    fields: [{
      type: 'checkbox',
      model: 'useBundledLanguageServers',
      label: trans('Use bundled language servers'),
      info: trans('Prefer bundled panache, codebook, and LTeX+ for their standard commands. If a server is not bundled, use the installed version. Explicit executable paths always take precedence. Changes restart active servers.')
    }, {
      type: 'button',
      label: trans('Add panache, codebook, and LTeX+'),
      onClick: () => {
        const servers = parseLanguageServers(window.config.get('languageServers'))
        for (const preset of recommendedLanguageServers) {
          if (!servers.some(server => server.name === preset.name || server.command === preset.command)) {
            servers.push(preset)
          }
        }
        window.config.set('languageServers', JSON.stringify(servers, null, 2))
      }
    }, {
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
