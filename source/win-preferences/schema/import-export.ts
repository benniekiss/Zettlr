/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Preferences Schema
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Exports the export tab schema.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import { type PreferencesFieldset } from '../App.vue'
import { PreferencesGroups } from './_preferences-groups'
import { ProgrammaticallyOpenableWindows } from '@providers/commands/open-aux-window'
import { DEFAULT_PANDOC_WASM_URL } from '@common/pandoc-util/pandoc-wasm-url'
const ipcRenderer = window.ipc

export function getImportExportFields (): PreferencesFieldset[] {
  return [
    {
      title: trans('Pandoc download'),
      group: PreferencesGroups.ImportExport,
      infoString: trans('Pandoc is downloaded once and cached for offline use. Changing the URL applies to the next import or export.'),
      fields: [
        {
          type: 'text',
          label: trans('Pandoc WASM download URL'),
          model: 'export.pandocWasmUrl',
          reset: DEFAULT_PANDOC_WASM_URL,
          info: trans('Use a URL pointing to a .wasm file or a Pandoc release ZIP archive. Local file URLs are also supported.')
        }
      ]
    },
    {
      title: trans('Import and export profiles'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'button',
          label: trans('Open import profiles editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-import-control'
              }
            })
              .catch(err => console.error(err))
          }
        },
        {
          type: 'button',
          label: trans('Open export profiles editor'),
          onClick: () => {
            ipcRenderer.invoke('application', {
              command: 'open-aux-window',
              payload: {
                window: ProgrammaticallyOpenableWindows.AssetsWindow,
                hash: 'tab-export-control'
              }
            })
              .catch(err => console.error(err))
          }
        }
      ] // TODO: Add two buttons "Open import profiles editor" and "Open export profiles editor"
    },
    {
      title: trans('Export settings'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'checkbox',
          label: trans('Automatically open successfully exported files'),
          model: 'export.autoOpenExportedFiles'
        },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: trans('Remove tags from files when exporting'),
          model: 'export.stripTags'
        },
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Internal links'),
          model: 'export.stripLinks',
          options: {
            full: trans('Remove internal links completely'),
            unlink: trans('Unlink internal links'),
            no: trans('Don\'t touch internal links')
          }
        },
        { type: 'separator' },
        {
          type: 'radio',
          label: trans('Destination folder for exported files'),
          model: 'export.dir',
          options: {
            // TODO: Add info-strings
            temp: trans('Temporary folder'),
            cwd: trans('Same as file location'),
            ask: trans('Ask for folder when exporting')
          }
        },
        {
          type: 'form-text',
          display: 'info',
          contents: trans('Warning! Files in the temporary folder are regularly deleted. Choosing the same location as the file overwrites files with identical filenames if they already exist.')
        }
      ]
    },
    {
      title: trans('Custom export commands'),
      infoString: trans('Specify custom commands to run the exporter with. Each command receives as its first argument the file or project folder to be exported.'),
      group: PreferencesGroups.ImportExport,
      help: undefined, // TODO
      fields: [
        {
          type: 'list',
          valueType: 'record',
          keyNames: [ 'displayName', 'command' ],
          columnLabels: [ trans('Display name'), trans('Command') ],
          model: 'export.customCommands',
          deletable: true,
          searchable: true,
          addable: true,
          editable: true
        }
      ]
    },
    {
      title: trans('Pandoc Extensions'),
      infoString: trans('Add support for certain Markdown syntax elements during exports. We recommend to keep all enabled, unless you know what you are doing.'),
      group: PreferencesGroups.ImportExport,
      help: undefined,
      fields: [
        {
          type: 'checkbox',
          label: trans('Mark extension'),
          info: trans('Enable support for ==highlighted== text.'),
          model: 'export.forceEnableExtensions.mark'
        },
        {
          type: 'checkbox',
          label: trans('Alerts extension'),
          info: trans('Enable support for admonitions (also known as alerts or callouts).'),
          model: 'export.forceEnableExtensions.alerts'
        }
      ]
    }
  ]
}
