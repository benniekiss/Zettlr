/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        useWindowState
 * CVM-Role:        Model
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This model manages the state for any given main window, i.e.
 *                  values that represent volatile configuration of the window
 *                  UI or UX without affecting other state managers.
 *
 * END HEADER
 */
import { defineStore } from 'pinia'
import type { DocumentInfo } from 'source/common/modules/markdown-editor'
import type { ToCEntry } from 'source/common/modules/markdown-editor/plugins/toc-field'
import { computed, ref, watch, type Ref } from 'vue'
import { type WritingTarget } from '@providers/targets'
import type { AssetsProviderIPCAPI } from 'source/app/service-providers/assets'
import type { AnyDescriptor } from 'source/types/common/fsal'
import { useWorkspaceStore } from './workspace-store'
import { useConfigStore } from './config'
import type { FSALEventPayload } from 'source/app/service-providers/fsal'
import type { SearchResultWrapper } from 'source/win-main/GlobalSearch.vue'

const ipcRenderer = window.ipc

async function updateSnippets (snippets: Ref<Array<{ name: string, content: string, section?: string }>>, workspace?: AnyDescriptor): Promise<void> {
  const newSnippets: Array<{ name: string, content: string, section?: string }> = []

  // Now we have to pair two types of calls to the assets provider to get all
  // snippets: First a call to list all snippets, and then one `get` call to
  // retrieve its file contents.
  const snippetNames: string[] = await ipcRenderer.invoke('assets-provider', {
    command: 'list-snippets',
  } as AssetsProviderIPCAPI).catch(e => console.log(e))

  for (const snippet of snippetNames) {
    const content: string = await ipcRenderer.invoke('assets-provider', {
      command: 'get-snippet',
      payload: { name: snippet, dir: undefined }
    } as AssetsProviderIPCAPI).catch(e => console.log(e))

    newSnippets.push({ name: snippet, content })
  }

  // Return early if no paths were provided
  if (workspace === undefined || workspace.type !== 'directory') {
    snippets.value = newSnippets
    return
  }

  const workspaceSnippets: string[] = await ipcRenderer.invoke('assets-provider', {
    command: 'list-snippets',
    payload: { dir: workspace.path },
  } as AssetsProviderIPCAPI).catch(() => { return [] })

  for (const snippet of workspaceSnippets) {
    const content: string = await ipcRenderer.invoke('assets-provider', {
      command: 'get-snippet',
      payload: {
        name: snippet,
        dir: workspace.path,
      }
    } as AssetsProviderIPCAPI)

    newSnippets.push({ name: snippet, content, section: workspace.name })
  }

  snippets.value = newSnippets
}

export const useWindowStateStore = defineStore('window-state', () => {
  const workspaceStore = useWorkspaceStore()
  const configStore = useConfigStore()

  const loadWorkplaceSnippets = computed(() => configStore.config.workspaces.enableAssets && configStore.config.workspaces.loadSnippets)
  const isFullscreen = ref(false)
  const uncollapsedDirectories = ref<string[]>([])
  const distractionFreeMode = ref<undefined|string>(undefined)
  const activeDocumentInfo = ref<undefined|DocumentInfo>(undefined)
  const tableOfContents = ref<ToCEntry[]|undefined>(undefined)
  const snippets = ref<Array<{ name: string, content: string, section?: string }>>([])
  const writingTargets = ref<WritingTarget[]>([])
  const activeWorkspace = ref(workspaceStore.activeWorkspace)

  /**
   * SEARCH RESULTS FUNCTIONALITY
   */
  const searchResults = ref<SearchResultWrapper[]>([])
  const maxSearchResultWeight = computed(() => {
    const allWeights = searchResults.value.map(r => r.weight)
    return Math.max(...allWeights)
  })

  function addSearchResult (result: SearchResultWrapper) {
    searchResults.value.push(result)
    searchResults.value.sort((a, b) => b.weight - a.weight)
  }

  workspaceStore.$subscribe((_mutation, state) => {
    activeWorkspace.value = state.activeWorkspace
  })

  // Snippets
  ipcRenderer.on('assets-provider', (event, what: string) => {
    if (what === 'snippets-updated') {
      const workspace = loadWorkplaceSnippets.value ? activeWorkspace.value : undefined
      updateSnippets(snippets, workspace).catch(e => console.error(e))
    }
  })

  watch(activeWorkspace, async (value) => {
    const workspace = loadWorkplaceSnippets.value ? value : undefined
    await updateSnippets(snippets, workspace)
  })

  watch(loadWorkplaceSnippets, async (value) => {
    const workspace = value ? activeWorkspace.value : undefined
    await updateSnippets(snippets, workspace)
  })

  const workspace = loadWorkplaceSnippets.value ? activeWorkspace.value : undefined
  updateSnippets(snippets, workspace).catch(e => console.error(e))

  ipcRenderer.on('fsal-event', async (_event, payload: FSALEventPayload) => {
    let path
    if (payload.event === 'unlink' || payload.event === 'unlinkDir') {
      path = payload.path
    } else if (payload.event === 'add' || payload.event === 'addDir' || payload.event === 'change') {
      path = payload.descriptor?.path
    }

    if (path === undefined) { return }

    // Helper: does the path match .zettlr or .zettlr/snippets?
    const isWsDir = /\.zettlr(\/|$)/.test(path)
    const isSnippetDir = /\.zettlr\/snippets(\/|$)/.test(path)
    const isSnippetFile = /\.zettlr\/snippets\/.+\.tpl\.md$/.test(path)

    const workspace = loadWorkplaceSnippets.value ? activeWorkspace.value : undefined

    switch (payload.event) {
      case 'unlink':
        if (isSnippetFile) { await updateSnippets(snippets, workspace) }
        break
      case 'add':
      case 'change':
        if (isSnippetFile) { await updateSnippets(snippets, workspace) }
        break
      case 'unlinkDir':
      case 'addDir':
        if (isSnippetDir || isWsDir) { await updateSnippets(snippets, workspace) }
        break
    }
  })

  // Writing targets
  ipcRenderer.on('targets-provider', (event, what: string) => {
    if (what === 'writing-targets-updated') {
      ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
        .then((targets: WritingTarget[]) => { writingTargets.value = targets })
        .catch(e => console.error(e))
    }
  })

  ipcRenderer.invoke('targets-provider', { command: 'get-targets' })
    .then((targets: WritingTarget[]) => { writingTargets.value = targets })
    .catch(e => console.error(e))

  ipcRenderer.on('window-controls', (event, { command, payload }) => {
    if (command === 'fullscreen' && typeof payload === 'boolean') {
      isFullscreen.value = payload
    }
  })

  return {
    uncollapsedDirectories,
    distractionFreeMode,
    activeDocumentInfo,
    tableOfContents,
    searchResults,
    addSearchResult,
    maxSearchResultWeight,
    snippets,
    writingTargets,
    isFullscreen
  }
})
