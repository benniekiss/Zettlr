/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Theme registration routines
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file loads in the main CSS files into the renderer
 *                  process and enables switching between themes.
 *
 * END HEADER
 */

// Import the main.css file which imports CSS for KaTeX, Clarity, Tippy.JS, and
// the geometry for the application. This will be added to the HTML by Webpack
// automatically
import type { AnyDescriptor } from 'source/types/common/fsal'
import './assets/main.css'
import { DP_EVENTS } from 'source/types/common/documents'
import type { DocumentsUpdateContext } from 'source/app/service-providers/documents'
import type { FSALEventPayload } from 'source/app/service-providers/fsal'

const ipcRenderer = window.ipc

const activeWorkspace: { path?: string } = {}

/**
 * Defines a SystemColour interface as is being returned by the appearance provider
 */
interface SystemColour {
  accent: string
  contrast: string
}

function loadWorkspaceCSS (workspace?: string) {
  removeCustomCSS(true)

  // No open workspace
  if (workspace === undefined) { return }

  ipcRenderer.invoke('fsal', { command: 'get-descriptor', payload: workspace })
    .then((ws: AnyDescriptor) => {
      if (ws.type !== 'directory') { return }

      ipcRenderer.invoke('css-provider', {
        command: 'get-custom-css-path',
        payload: { dir: ws.path }
      })
        .then((cssPath: string) => {
          if (cssPath) { setCustomCss(cssPath, true) }
        })
        .catch(e => console.error(e))
    })
    .catch(e => console.error(e))
}

/**
 * Listens for theming changes (main theme + custom CSS) and handles dark mode
 */
export default function registerThemes (): void {
  // Listen for configuration changes
  ipcRenderer.on('config-provider', (event, { command, payload }) => {
    if (command === 'update') {
      switch (payload) {
        case 'darkMode': {
          // Switch to light/dark mode based on the configuration variable
          switchDarkLightTheme()
          break
        }
        case 'workspaces.loadCSS':
        case 'workspaces.loadAllAssets': {
          const loadAssets: boolean = window.config.get('workspaces.loadAllAssets')
          const loadCSS: boolean = window.config.get('workspaces.loadCSS')

          if (loadAssets && loadCSS) {
            loadWorkspaceCSS(activeWorkspace.path)
          } else {
            removeCustomCSS(true)
          }
          break
        }
      }
    }
  })

  // Listen for custom CSS changes
  ipcRenderer.on('css-provider', (evt, { command, payload }: { command: 'set-custom-css', payload: { path: string, workspace: string } }) => {
    if (command === 'set-custom-css') {
      setCustomCss(payload.path, payload.workspace ? true : false)
    }
  })

  ipcRenderer.on('documents-update', (evt, payload: { event: DP_EVENTS, context: DocumentsUpdateContext }) => {
    if (payload.event === DP_EVENTS.ACTIVE_ROOT) {
      const loadAssets: boolean = window.config.get('workspaces.loadAllAssets')
      const loadCSS: boolean = window.config.get('workspaces.loadCSS')

      const rootChanged = activeWorkspace.path !== payload.context.filePath
      activeWorkspace.path = payload.context.filePath

      if (!(loadAssets && loadCSS)) {
        removeCustomCSS(true)
      } else if (rootChanged) {
        loadWorkspaceCSS(payload.context.filePath)
      }
    }
  })

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
    const isCssFile = /\.zettlr\/custom.css$/.test(path)

    const loadAssets: boolean = window.config.get('workspaces.loadAllAssets')
    const loadCSS: boolean = window.config.get('workspaces.loadCSS')

    const workspace = loadAssets && loadCSS ? activeWorkspace.path : undefined

    switch (payload.event) {
      case 'unlink':
        if (isCssFile) { removeCustomCSS(true) }
        break
      case 'unlinkDir':
        if (isWsDir) { removeCustomCSS(true) }
      case 'add':
      case 'change':
        if (isCssFile) { loadWorkspaceCSS(workspace) }
        break
      case 'addDir':
        if (isWsDir) { loadWorkspaceCSS(workspace) }
        break
    }
  })

  // Initial theme change/setup
  switchDarkLightTheme()

  // Initial rendering of the Custom CSS
  ipcRenderer.invoke('css-provider', { command: 'get-custom-css-path' })
    .then((cssPath: string) => setCustomCss(cssPath))
    .catch(e => console.error(e))

  // Create the custom stylesheet which includes certain system colours which
  // will be referenced by the components as necessary.
  setSystemCss()
}

/**
 * Performs necessary actions when switching the theme to dark/light
 */
function switchDarkLightTheme (): void {
  const isDarkMode: boolean = window.config.get('darkMode')
  document.body.classList.toggle('dark', isDarkMode)
}

function removeCustomCSS (workspace?: boolean): void {
  const customCssId = workspace !== undefined ? 'custom-css-link-workspace' : 'custom-css-link'

  const formerCustomCSS = document.getElementById(customCssId)
  if (formerCustomCSS !== null) {
    // If applicable, remove a given previous custom CSS
    formerCustomCSS.parentElement?.removeChild(formerCustomCSS)
  }
}

/**
 * (Re)loads the custom CSS
 *
 * @param   {string}  cssPath  The path to the file
 */
function setCustomCss (cssPath: string, workspace?: boolean): void {
  const customCssId = workspace !== undefined ? 'custom-css-link-workspace' : 'custom-css-link'

  removeCustomCSS(workspace)

  // Due to the colons in the drive letters on Windows, the pathname will
  // look like this: /C:/Users/Documents/test.jpg
  // See: https://github.com/Zettlr/Zettlr/issues/5489
  if (/^[A-Z]:/i.test(cssPath)) {
    cssPath = `/${cssPath}`
  }

  // (Re)load the custom CSS
  let link = document.createElement('link')
  link.rel = 'stylesheet'
  link.setAttribute('href', (new URL('safe-file://' + cssPath)).toString())
  link.setAttribute('type', 'text/css')
  link.setAttribute('id', customCssId)
  document.head.appendChild(link)
}

/**
 * (Re)loads the system CSS
 */
function setSystemCss (): void {
  // Remove any former system CSS stylesheet, if applicable
  const formerSystemCSS = document.getElementById('system-css')
  if (formerSystemCSS !== null) {
    formerSystemCSS.parentElement?.removeChild(formerSystemCSS)
  }

  ipcRenderer.invoke('appearance-provider', { command: 'get-accent-color' })
    .then((accentColor: SystemColour) => {
      const style = document.createElement('style')
      style.setAttribute('id', 'system-css')

      // We can put all CSS variables we would like to output into this map. All
      // will be appended to the stylesheet below.
      const variables = new Map<string, string>()
      variables.set('--system-accent-color', '#' + accentColor.accent)
      variables.set('--system-accent-color-contrast', '#' + accentColor.contrast)

      // Why do we format it nicely? I don't know, but I like to keep things tidy.
      style.textContent = ':root {\n'
      for (const [ key, val ] of variables.entries()) {
        style.textContent += `  ${key}: ${val};\n`
      }
      style.textContent += '}'
      document.head.prepend(style)
    })
    .catch(e => console.error(e))
}
