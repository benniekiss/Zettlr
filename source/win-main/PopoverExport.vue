<template>
  <PopoverWrapper v-bind:target="target" v-on:close="$emit('close')">
    <div class="toolbar-export">
      <h3>Export</h3>
      <p><strong>{{ filename }}</strong></p>
      <SelectControl
        v-model="format"
        v-bind:label="formatLabel"
        v-bind:options="availableFormats"
      ></SelectControl>
      <!-- The choice of working directory vs. temporary applies to all exporters -->
      <hr>
      <RadioControl
        v-model="exportDirectory"
        v-bind:options="{
          'temp': tempDirLabel,
          'cwd': cwdLabel,
          'ask': askLabel
        }"
      ></RadioControl>
      <hr>
      <CheckboxControl
        v-model="autoOpenExport"
        v-bind:label="autoOpenLabel"
      ></CheckboxControl>
      <!-- Add the exporting button -->
      <button
        ref="exportButton"
        v-bind:disabled="isExporting" v-on:click="doExport"
      >
        {{ exportButtonLabel }}
      </button>
    </div>
  </PopoverWrapper>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Export Popover
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file enables single-file exports for the user.
 *
 * END HEADER
 */

import PopoverWrapper from '@common/vue/PopoverWrapper.vue'
import RadioControl from '@common/vue/form/elements/RadioControl.vue'
import SelectControl from '@common/vue/form/elements/SelectControl.vue'
import CheckboxControl from '@common/vue/form/elements/CheckboxControl.vue'
import { ref, computed, watch, onMounted } from 'vue'
import type { AssetsProviderIPCAPI, PandocProfileMetadata } from '@providers/assets'
import { SUPPORTED_READERS } from '@common/pandoc-util/pandoc-maps'
import { trans } from '@common/i18n-renderer'
import { pathBasename } from '@common/util/renderer-path-polyfill'
import { useConfigStore, useWorkspaceStore } from 'source/pinia'
import { parseReaderWriter } from 'source/common/pandoc-util/parse-reader-writer'
import type { CustomExportIPCAPI, ExportIPCAPI } from 'source/app/service-providers/commands/export'

const ipcRenderer = window.ipc

const formatLabel = trans('Format')
const autoOpenLabel = trans('Open after export')
const tempDirLabel = trans('Temporary directory')
const cwdLabel = trans('Current directory')
const askLabel = trans('Select directory')

// This is used to limit the number of selected
// profile to filename mappings in the config
const PREVIOUSLY_SELECTED_PROFILE_LIMIT = 50

const exportButton = ref<HTMLButtonElement|null>(null)

const configStore = useConfigStore()
const workspaceStore = useWorkspaceStore()

const props = defineProps<{
  target: HTMLElement
  filePath: string
}>()

const emit = defineEmits<(e: 'close') => void>()

onMounted(() => {
  exportButton.value?.focus()
})

const isExporting = ref(false)
const format = ref<Record<string, string>>({})
const exportDirectory = ref(configStore.config.export.dir)
const autoOpenExport = ref(configStore.config.export.autoOpenExportedFiles)
const profileMetadata = ref<PandocProfileMetadata[]>([])
const workspaceProfileMetadata = ref<PandocProfileMetadata[]>([])

const loadWorkplaceProfiles = computed(() => configStore.config.workspaces.enableAssets && configStore.config.workspaces.loadExportProfiles)

const customCommands = computed(() => configStore.config.export.customCommands)
const selectedProfiles = computed(() => configStore.config.export.selectedProfiles)
const lastUsedProfile = computed(() => configStore.config.export.lastUsedProfile)

const exportButtonLabel = computed(() => isExporting.value ? trans('Exporting…') : trans('Export'))
const filename = computed(() => pathBasename(props.filePath))
const availableFormats = computed(() => {
  // { Workspace: { Filename: Displayname } }
  const selectOptions: Record<string, Record<string, string>> = {}

  const defaultSelections: Record<string, string> = {}
  profileMetadata.value.forEach(elem => { defaultSelections[elem.name] = getDisplayText(elem) })

  selectOptions['Global Profiles'] = defaultSelections

  const workspaceSelections: Record<string, string> = {}
  workspaceProfileMetadata.value.forEach(prof => workspaceSelections[prof.name] = getDisplayText(prof))

  if (workspaceProfileMetadata.value.length > 0) {
    const wsName = workspaceStore.activeWorkspace?.name
    selectOptions[`Workspace Profiles (${wsName})`] = workspaceSelections
  }

  if (customCommands.value.length > 0) {
    const customSelections: Record<string, string> = {}
    const cmdTitle = trans('command')
    customCommands.value
      .forEach(elem => { customSelections[elem.command] = `${elem.displayName} (${cmdTitle})` })

    selectOptions['Custom Commands'] = customSelections
  }

  return selectOptions
})

watch(autoOpenExport, function (value) {
  // This watcher allows the user to control whether
  // the exported document is automatically opened
  configStore.setConfigValue('export.autoOpenExportedFiles', value)
})

watch(exportDirectory, function (value) {
  // This watcher allows the user to set the export directory from here
  configStore.setConfigValue('export.dir', value)
})

watch(format, function (value) {
  // Remember the last choice
  let profile: string|undefined

  const globalProfile: string|undefined = value['Global Profiles']
  if (globalProfile !== undefined) {
    profile = profileMetadata.value.find(prof => prof.name === globalProfile)?.name
  }

  const ws = workspaceStore.activeWorkspace
  const wsProfile: string|undefined = value[`Workspace Profiles (${ws?.name})`]
  if (wsProfile !== undefined) {
    profile = workspaceProfileMetadata.value.find(prof => prof.name === wsProfile)?.name
  }

  const customProfile: string|undefined = value['Custom Commands']
  if (customProfile !== undefined) {
    profile = customCommands.value.find(x => x.command === customProfile)?.command

  }

  profile = profile ?? lastUsedProfile.value

  const filePath: string = props.filePath

  const newProfiles = selectedProfiles.value
    // Remove any previous items with the same path
    .filter(item  => item.filePath !== filePath)
    // Clamp the list to the last N - 1 items since we will be pushing one
    .slice(-PREVIOUSLY_SELECTED_PROFILE_LIMIT - 1)

  newProfiles.push({ filePath, profile })

  configStore.setConfigValue('export.selectedProfiles', JSON.parse(JSON.stringify(newProfiles)))

  // Do not update the last used profile if it was from a workspace
  if (!wsProfile) {
    configStore.setConfigValue('export.lastUsedProfile', profile)
  }
})

async function updateProfiles (): Promise<void>  {
  const defaults: PandocProfileMetadata[] = await ipcRenderer.invoke(
    'assets-provider',
    {
      command: 'list-export-profiles',
    } as AssetsProviderIPCAPI)

  // Get the open workspace
  let workspaceDefaults: PandocProfileMetadata[] = []
  const workspaceDescriptor = workspaceStore.activeWorkspace
  if (loadWorkplaceProfiles.value && workspaceDescriptor) {
    const workspaceProfiles: PandocProfileMetadata[] = await ipcRenderer.invoke(
      'assets-provider',
      {
        command: 'list-defaults',
        payload: { dir: workspaceDescriptor.path }
      } as AssetsProviderIPCAPI)

    workspaceDefaults = workspaceProfiles
  }

  // Save all the exporter information into the array. The computed
  // properties will take the info from that array and re-compute based
  // on the value of "format".
  function isSupported (reader: string): boolean {
    const name = parseReaderWriter(reader).name
    return name.endsWith('.lua') || SUPPORTED_READERS.includes(name)
  }

  profileMetadata.value = defaults.filter(prof => isSupported(prof.reader))
  workspaceProfileMetadata.value = workspaceDefaults.filter(prof => isSupported(prof.reader))

  // Get either the last selected exporter for the open file,
  // the last used exporter, or the first element available
  const lastProfile = selectedProfiles.value.find(item => item.filePath === props.filePath)
  const profile = lastProfile ? lastProfile.profile : lastUsedProfile.value

  const hasDefault = profileMetadata.value.find(prof => prof.name === profile)
  const hasWorkspace = workspaceProfileMetadata.value.find(prof => prof.name === profile)
  const hasCommand = customCommands.value.find(com => com.command === profile)

  if (hasDefault) {
    format.value = { 'Global Profiles': profile }
  } else if (hasWorkspace) {
    const ws = workspaceStore.activeWorkspace
    const key = `Workspace Profiles (${ws?.name})`
    format.value = { [key]: profile }
  } else if (hasCommand) {
    format.value = { 'Custom Commands': profile }
  } else {
    format.value = { 'Global Profiles': profileMetadata.value[0].name }
  }
}

function doExport (): void {
  let profile: PandocProfileMetadata | undefined

  const hasGlobal: string|undefined = format.value['Global Profiles']
  if (hasGlobal !== undefined) {
    profile = profileMetadata.value.find(prof => prof.name === hasGlobal)
  }

  const ws = workspaceStore.activeWorkspace
  const hasWs: string|undefined = format.value[`Workspace Profiles (${ws?.name})`]
  if (hasWs !== undefined) {
    profile = workspaceProfileMetadata.value.find(prof => prof.name === hasWs)
  }

  const hasCommand: string|undefined = format.value['Custom Commands']

  isExporting.value = true

  if (hasCommand !== undefined) {
    const commandProfile = customCommands.value.find(com => com.command === hasCommand)

    // Run the custom command exporter
    ipcRenderer.invoke('application', {
      command: 'custom-export',
      payload: {
        displayName: commandProfile?.displayName ?? '', // TODO: fixup
        file: props.filePath
      } satisfies CustomExportIPCAPI
    })
      .finally(() => {
        isExporting.value = false
        emit('close')
      })
      .catch(e => console.error(e))
  } else {
    // Run the regular exporter
    ipcRenderer.invoke('application', {
      command: 'export',
      payload: {
        profile: JSON.parse(JSON.stringify(profile)),
        exportTo: exportDirectory.value,
        file: props.filePath
      } satisfies ExportIPCAPI
    })
      .finally(() => {
        isExporting.value = false
        emit('close')
      })
      .catch(e => console.error(e))
  }
}

function getDisplayText (item: PandocProfileMetadata): string {
  const name = item.name.substring(0, item.name.lastIndexOf('.'))
  return `${name} (${item.writer})`
}

onMounted(updateProfiles)

</script>

<style lang="less">
body {
  .toolbar-export {
    margin: 5px;

    h3, p, strong {
      text-align: center;
      padding-bottom: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    button {
      width: stretch;
      margin: 5px;
    }

    .form-control {
      padding: 5px;
      select {
          margin-top: 5px;
        }
    }

    .radio-group-container {
      margin: 5px;
    }
  }
}
</style>
@common/util/renderer-path-polyfill
