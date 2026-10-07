<template>
  <WindowChrome
    v-bind:title="windowTitle"
    v-bind:titlebar="true"
    v-bind:menubar="false"
    v-bind:tabbar-label="'Preferences'"
    v-bind:disable-vibrancy="!hasVibrancy"
  >
    <!--
      To comply with ARIA, we have to wrap the form in a tab container because
      we make use of the tabbar on the window chrome.
    -->
    <SplitView
      v-bind:initial-size-percent="[ 20, 80 ]"
      v-bind:minimum-size-percent="[ 20, 20 ]"
      v-bind:reset-size-percent="[ 20, 80 ]"
      v-bind:split="'horizontal'"
      v-bind:initial-total-width="100"
    >
      <template #view1>
        <div id="preferences-container-list">
          <TextControl
            v-model="query"
            v-bind:placeholder="searchPlaceholder"
            v-bind:search-icon="true"
            v-bind:autofocus="true"
            v-bind:reset="true"
            style="padding: 10px 10px 0px 10px;"
          ></TextControl>
          <SelectableList
            v-bind:items="groups"
            v-bind:editable="false"
            v-bind:selected-item="selectedItem"
            v-on:select="selectGroup($event)"
          ></SelectableList>
        </div>
      </template>
      <template #view2>
        <FormBuilder
          v-if="schema.fieldsets.length > 0"
          ref="form"
          v-bind:model="model"
          v-bind:schema="schema"
          v-on:update:model-value="handleInput"
        ></FormBuilder>
        <div v-else id="no-results-message">
          {{ noResultsMessage }}
        </div>
      </template>
    </SplitView>
  </WindowChrome>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Preferences
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the entry app for the preferences window.
 *
 * END HEADER
 */

import FormBuilder, { type FormSchema, type Fieldset } from '@common/vue/form/FormBuilder.vue'
import WindowChrome from '@common/vue/window/WindowChrome.vue'
import { trans } from '@common/i18n-renderer'

import { getGeneralFields } from './schema/general'
import { getEditorFields } from './schema/editor'
import { getCitationFields } from './schema/citations'
import { getZettelkastenFields } from './schema/zettelkasten'
import { getLanguageServerFields } from './schema/language-servers'
import { getAutocorrectFields } from './schema/autocorrect'
import { getAdvancedFields } from './schema/advanced'
import { ref, computed, watch, onMounted } from 'vue'
import { resolveLangCode } from '@common/util/map-lang-code'
import SplitView from '@common/vue/window/SplitView.vue'
import SelectableList, { type SelectableListItem } from '@common/vue/form/elements/SelectableList.vue'
import TextControl from '@common/vue/form/elements/TextControl.vue'
import { getAppearanceFields } from './schema/appearance'
import { getFileManagerFields } from './schema/file-manager'
import { getImportExportFields } from './schema/import-export'
import { getSnippetsFields } from './schema/snippets'
import { useConfigStore } from 'source/pinia'
import { PreferencesGroups } from './schema/_preferences-groups'
import { getShortcutFields } from './schema/shortcuts'

export type PreferencesFieldset = Fieldset & { group: PreferencesGroups }

const ipcRenderer = window.ipc
const configStore = useConfigStore()

const hasVibrancy = computed(() => configStore.config.window.vibrancy && process.platform === 'darwin')

const currentGroup = ref(0)
const query = ref('')
// Will be populated afterwards, contains the available languages
const appLangOptions = ref<Record<string, string>>({})

// This will return the full object
const config = computed(() => configStore.config)

const noResultsMessage = computed(() => trans('No results for "%s"', query.value))
const searchPlaceholder = trans('Search')

const schema = computed<FormSchema>(() => {
  return {
    fieldsets: filteredFieldsets.value,
    getFieldsetCategory: (fieldset: Fieldset) => {
      if (query.value === '') {
        return undefined
      }

      const group = groups.value.find(g => g.id === fieldset.group)

      if (group !== undefined && group.icon !== undefined) {
        return { icon: group.icon, title: group.displayText }
      } else {
        return undefined
      }
    }
  }
})

const selectedItem = computed(() => query.value === '' ? currentGroup.value : -1)

const fieldsets = computed<Fieldset[]>(() => {
  return [
    ...getAdvancedFields(configStore.config),
    ...getAppearanceFields(configStore.config),
    ...getAutocorrectFields(),
    ...getCitationFields(),
    ...getEditorFields(configStore.config),
    ...getFileManagerFields(configStore.config),
    ...getGeneralFields(appLangOptions.value),
    ...getImportExportFields(),
    ...getShortcutFields(configStore.config),
    ...getSnippetsFields(),
    ...getLanguageServerFields(),
    ...getZettelkastenFields(configStore.config)
  ]
})

const filteredFieldsets = computed(() => {
  const q = query.value.toLowerCase().trim()

  if (q === '') {
    // No active search, so simply return the currently active group
    const activeGroup = groups.value[currentGroup.value].id
    return fieldsets.value.filter(f => f.group === activeGroup)
  }

  return fieldsets.value.filter(f => {
    // BUG: Somehow TypeScript (and ESLint!) knows that everything here works
    // out but STILL insists on explicitly casting everything to boolean. I
    // don't know why.

    // Match relevancy:
    // 1. Search term is in card title
    if (Boolean(f.title.toLowerCase().includes(q))) {
      return true
    }

    if (Boolean((f.help?.toLowerCase().includes(q)))) {
      return true
    }

    for (const field of f.fields) {
      if ('label' in field && (Boolean((field.label?.toLowerCase().includes(q))))) {
        return true
      } else if ('info' in field && (Boolean((field.info?.toLowerCase().includes(q))))) {
        return true
      } else if (field.type === 'radio' || field.type === 'select') {
        for (const option in field.options) {
          if (option.toLowerCase().includes(q)) {
            return true
          }
        }
      }
    }
    return false
  })
})

const groups = computed<Array<SelectableListItem & { id: PreferencesGroups }>>(() => {
  return [
    {
      displayText: trans('General'),
      icon: 'cog',
      id: PreferencesGroups.General
    },
    {
      displayText: trans('Appearance'),
      icon: 'paint-roller',
      id: PreferencesGroups.Appearance
    },
    {
      displayText: trans('File Manager'),
      icon: 'folder-open',
      id: PreferencesGroups.FileManager
    },
    {
      displayText: trans('Editor'),
      icon: 'align-left-text',
      id: PreferencesGroups.Editor
    },
    {
      displayText: trans('Language servers'),
      icon: 'text',
      id: PreferencesGroups.LanguageServers
    },
    {
      displayText: trans('Autocorrect'),
      icon: 'wand', // 'block-quote'
      id: PreferencesGroups.Autocorrect
    },
    {
      displayText: trans('Citations'),
      icon: 'chat-bubble',
      id: PreferencesGroups.Citations
    },
    {
      displayText: trans('Shortcuts'),
      icon: 'keyboard',
      id: PreferencesGroups.Shortcuts
    },
    {
      displayText: trans('Zettelkasten'),
      icon: 'details',
      id: PreferencesGroups.Zettelkasten
    },
    {
      displayText: trans('Snippets'),
      icon: 'add-text',
      id: PreferencesGroups.Snippets
    },
    {
      displayText: trans('Import and Export'),
      icon: 'two-way-arrows',
      id: PreferencesGroups.ImportExport
    },
    {
      displayText: trans('Advanced'),
      icon: 'cpu',
      id: PreferencesGroups.Advanced
    }
  ]
})

const windowTitle = computed(() => {
  if (query.value !== '') {
    return trans('Searching: %s', query.value)
  } else if (process.platform === 'darwin') {
    return groups.value[currentGroup.value].displayText
  } else {
    return trans('Preferences')
  }
})

const model = computed(() => {
  // The model to be passed on will simply be a merger of custom values
  // and the configuration object. This way we can safely change some of
  // these values without risking to overwrite the model (which we have
  // done in a previous iteration of the preferences ...)
  return {
    ...config.value
  }
})

/**
 * Switches out the preferences tab based on the value of currentTab.
 */
watch(currentGroup, () => {
  setTitle()
  location.hash = '#' + currentGroup.value
})

/**
 * Initialise values during component mount
 */
onMounted(() => {
  setTitle()
  populateDynamicValues()
  if (location.hash !== '') {
    const groupId = parseInt(location.hash.substring(1), 10)
    if (Object.values(PreferencesGroups).includes(groupId)) {
      currentGroup.value = groupId
    }
  }
})

/**
 * Called whenever a form value changes, and updates that specific setting.
 *
 * @param   {string}  prop  The property that has changed
 * @param   {any}     val   The value of that property.
 */
function handleInput (prop: string, val: unknown): void {
  // Deproxy values before sending them over IPC.
  configStore.setConfigValue(prop, JSON.parse(JSON.stringify(val)))
}

/**
 * Sets the window title corresponding to the current tab.
 */
function setTitle (): void {
  if (process.platform === 'darwin') {
    // Apple's Human Interface Guidelines state the window title should be
    // the current tab.
    document.title = groups.value[currentGroup.value].displayText
  }
}

/**
 * Populates dynamic fields (that is, those configurations that are not
 * controlled by the configuration provider).
 */
function populateDynamicValues (): void {
  // Get a list of all available languages
  ipcRenderer.invoke('application', {
    command: 'get-available-languages'
  })
    .then((languages) => {
      const options: Record<string, string> = {}
      languages.map((lang: string) => {
        options[lang] = resolveLangCode(lang, 'name')
        return null
      })
      appLangOptions.value = options
    })
    .catch(err => console.error(err))
}

function selectGroup (which: number): void {
  if (query.value === '') {
    currentGroup.value = which
  }
}
</script>

<style lang="less">
div[role="tabpanel"] {
  overflow: auto; // Enable scrolling, if necessary
  padding: 10px;
  width: 100%;
}

#preferences-container-list {
  display: flex;
  flex-direction: column;
  max-height: stretch;
  margin-bottom: 20px;
}

#no-results-message {
  font-size: 200%;
  text-align: center;
  font-weight: bold;
  margin-top: 20vh;
}
</style>
