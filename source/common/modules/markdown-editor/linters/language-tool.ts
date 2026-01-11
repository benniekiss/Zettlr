/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LanguageTool Linter
 * CVM-Role:        Linter
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This linter interacts with the LanguageTool API to provide
 *                  spellcheck, grammar support, and further typographic help.
 *
 * END HEADER
 */

import { linter, type Diagnostic, type Action } from '@codemirror/lint'
import { extractTextnodes, markdownToAST } from '@common/modules/markdown-utils'
import { configField } from '../util/configuration'
import type { LanguageToolLinterRequest, LanguageToolLinterResponse } from '@providers/commands/language-tool'
import { StateEffect, StateField } from '@codemirror/state'
import extractYamlFrontmatter from 'source/common/util/extract-yaml-frontmatter'
import { EditorView } from '@codemirror/view'
import { trans } from 'source/common/i18n-renderer'
import type { LanguageToolIgnoredRuleEntry } from '@providers/config/get-config-template'
import { changesFieldEffectFactory, hideLinterToolTipEffect, prepareDiagnostics, refreshLinterEffect, TEXTNODE_FILTER } from './utils'
import { ensureSyntaxTree } from '@codemirror/language'

const ipcRenderer = window.ipc

// store the local dictionary for later filtering
const userDictionary: Set<string> = new Set()

function refreshUserDictionary (): void {
  userDictionary.clear()

  ipcRenderer.invoke(
    'dictionary-provider',
    { command: 'get-user-dictionary' }
  ).then((dictionary: string[]) => {
    for (const word of dictionary) {
      userDictionary.add(word)
    }
  }).catch(console.error)

  ipcRenderer.invoke(
    'dictionary-provider',
    { command: 'get-ws-dictionary' }
  ).then((dictionary: string[]) => {
    for (const word of dictionary) {
      userDictionary.add(word)
    }
  }).catch(console.error)
}

// watch the dictionary-provider to update the user dictionary
ipcRenderer.on('dictionary-provider', (event, message) => {
  const { command } = message

  if (command === 'invalidate-dict') {
    refreshUserDictionary()
  }
})

/**
 * Utility function that can extract a list of all suggestions for a misspelling
 * that LanguageTool has produced.
 *
 * @param   {Diagnostic}     diag  The diagnostic
 *
 * @return  {string[]|null}        Returns either null, if there are no
 *                                 suggestions to extract, or a list of those
 *                                 suggestions.
 */
export function extractLTSpellcheckSuggestionsFrom (diag: Diagnostic): string[]|null {
  if (!isLanguageToolMisspelling(diag)) {
    return null
  }

  if (diag.actions === undefined) {
    return null
  }

  return diag.actions
    .filter(action => action.markClass === 'cm-ltSuggestAction')
    .map(action => action.name) // NOTE: If we ever change the name value below in the linter, we must adapt this line, too!
}

/**
 * Checks whether the provided diagnostic corresponds to a misspelling as
 * produced by the LanguageTool linter.
 *
 * @param   {Diagnostic}  diag  The diagnostic to check
 *
 * @return  {boolean}           Whether the diagnostic describes a spellcheck error.
 */
export function isLanguageToolMisspelling (diag: Diagnostic): boolean {
  return diag.source === 'language-tool(misspelling)'
}

export interface LanguageToolStateField {
  running: boolean
  lastDetectedLanguage: string
  supportedLanguages: string[]
  overrideLanguage: 'auto'|string
  lastError: string|undefined
  disabledRules: string[]
}

export const updateLTState = StateEffect.define<Partial<LanguageToolStateField>>()

export const languageToolState = StateField.define<LanguageToolStateField>({
  create: (state) => {
    // populate the user dictionary
    refreshUserDictionary()

    let overrideLanguage = 'auto'
    // Extract YAML frontmatter "lang" property if present and correct. This is
    // only done on startup to save code, and since users will rarely change an
    // explicitly given language (and when they do, it won't bother them to
    // once more change the language in the linter when not closing the doc.)
    const { frontmatter } = extractYamlFrontmatter(state.sliceDoc())
    // NOTE: Relatively simple Regex, nothing to write home about.
    if (typeof frontmatter?.lang === 'string' && /^[a-z]{2,3}(-[A-Z]{2,})?/.test(frontmatter.lang)) {
      overrideLanguage = frontmatter.lang
    }

    return {
      running: false,
      lastDetectedLanguage: 'auto',
      lastError: undefined,
      overrideLanguage,
      supportedLanguages: [],
      disabledRules: []
    }
  },
  update (value, transaction) {
    for (const e of transaction.effects) {
      if (e.is(updateLTState)) {
        value.running = e.value.running ?? value.running
        value.lastDetectedLanguage = e.value.lastDetectedLanguage ?? value.lastDetectedLanguage
        value.lastError = e.value.lastError
        value.supportedLanguages = e.value.supportedLanguages ?? value.supportedLanguages
        value.overrideLanguage = e.value.overrideLanguage ?? value.overrideLanguage
        value.disabledRules = e.value.disabledRules ?? value.disabledRules
      }
    }
    return value
  }
})

const { effect: ltChangesEffect, field: ltChangesField } = changesFieldEffectFactory()

/**
 * Defines a spellchecker that runs over the text content of the document and
 * highlights misspelled words
 */
const ltLinter = linter(async view => {
  if (!view.state.field(configField).lintLanguageTool) {
    return []
  }

  const ltContext = view.state.field(configField).languageToolContext

  const { ranges, diagnostics } = prepareDiagnostics(view.state, ltChangesField, 'language-tool', 6, TEXTNODE_FILTER)
  const ast = markdownToAST(view.state.sliceDoc(), ensureSyntaxTree(view.state, view.state.doc.length))

  for (const { from, to } of ranges) {
    // Extract TextNodes that fall within our range to later filter diagnostics that only cover these nodes.
    const textNodes = extractTextnodes(ast, (node) => { return !(node.from > to || node.to < from) })
    // If there are no TextNodes in this region, move on to the next.
    if (!(textNodes.length > 0)) { continue }

    // Now we need to chunk the text. Languagetool has API limits the length of
    // text that can be processed.
    const chunks = []

    let length = to - from
    if (length >= ltContext) {
      const n_chunks = Math.ceil(length / ltContext)
      const chunkLength = Math.floor(length / n_chunks)

      let start = from
      let end = Math.min(start + chunkLength, to)
      let chunk: { start: number, end?: number } = { start }

      for (const textNode of textNodes) {
        if (textNode.to <= end) {
          chunk.end = textNode.to
          continue
        }

        chunk.end = textNode.from
        chunks.push(chunk)

        start = textNode.from
        end = Math.min(start + chunkLength, to)

        chunk = { start, end: textNode.to }
      }

      if (chunk.end !== undefined) {
        chunks.push(chunk)
      }
    } else {
      chunks.push({ start: from, end: to })
    }

    for (const { start, end } of chunks) {
      view.dispatch({ effects: updateLTState.of({ running: true }) })

      const response: LanguageToolLinterResponse = await ipcRenderer.invoke('application', {
        command: 'run-language-tool',
        payload: {
          // Send the entire document to the API as `text`
          data: { annotation: [{ text: view.state.sliceDoc(start, end) }] },
          language: view.state.field(languageToolState).overrideLanguage
        } satisfies LanguageToolLinterRequest
      })

      if (response === undefined) {
        continue  // Could not fetch a response, but it's benign
      } else if (typeof response === 'string') {
        view.dispatch({ effects: updateLTState.of({ running: false, lastError: response }) })
        return diagnostics // There was an error
      }

      const [ ltSuggestions, supportedLanguages ] = response

      view.dispatch({
        effects: updateLTState.of({
          lastDetectedLanguage: ltSuggestions.language.detectedLanguage.code,
          supportedLanguages
        })
      })

      if (ltSuggestions.matches.length === 0) {
        view.dispatch({ effects: updateLTState.of({ running: false }) })
        return diagnostics // Hooray, nothing wrong!
      }

      // At this point, we have only valid suggestions that we can now insert into
      // the document.
      for (const match of ltSuggestions.matches) {
        const matchFrom: number = start + match.offset
        const matchTo: number = start + match.offset + match.length

        // Only include diagnostics overlapping with TextNodes.
        if (!textNodes.some(node => (matchFrom >= node.from && matchTo <= node.to))) { continue }

        const word = view.state.sliceDoc(matchFrom, matchTo)
        const issueType = match.rule.issueType
        // skip matches for words in the local dictionary
        if (issueType === 'misspelling' && userDictionary.has(word)) { continue }

        const source = `language-tool(${issueType})`
        const severity = (issueType === 'style')
          ? 'info'
          : (issueType === 'misspelling') ? 'error' : 'warning'

        const dia: Diagnostic = {
          from: matchFrom,
          to: matchTo,
          message: match.message,
          severity,
          source
        }

        const actions: Action[] = []
        if (match.replacements.length > 0) {
          // Show at most 10 actions to not overload those messages
          let i = 0
          for (const { value } of match.replacements) {
            if (i === 10) {
              break
            }
            i++

            actions.push({
              name: value,
              markClass: 'cm-ltSuggestAction',
              apply (view, from, to) {
                view.dispatch({ changes: { from, to, insert: value } })
              }
            })
          }
        }

        // TODO: Add a class and styling once
        // https://github.com/codemirror/lint/commit/50bd1188fe15d92b03cc5c1ea4ffbee44f28a090
        // lands in a release
        actions.push({
          name: trans('Disable Rule'),
          markClass: 'cm-ltDisableAction',
          apply (view) {
            // In order to ignore a rule, we do two things. First, we keep the
            // local ignoring-mechanism from @benniekiss, because that will allow us
            // to programmatically re-run the linter and properly hide the
            // corresponding linter match as soon as the user ignores the rule. At
            // the same time, we add the list to the global ignore list so that from
            // the next call to the API, that rule won't even show up. As soon as
            // the user switches files (and thus, our local ignore list cache is
            // cleared), we don't even need that info anymore, so we should be
            // golden.

            const payload: LanguageToolIgnoredRuleEntry = {
              description: match.rule.description,
              id: match.rule.id,
              category: match.rule.category.name
            }

            ipcRenderer.invoke('application', {
              command: 'add-language-tool-ignore-rule',
              payload
            }).catch(err => console.error(err))

            const disabledRules = [...view.state.field(languageToolState).disabledRules]
            disabledRules.push(match.rule.id)

            view.dispatch({ effects: [
              updateLTState.of({ disabledRules: disabledRules }),
              ltChangesEffect.of({ from: 0 }),
              hideLinterToolTipEffect.of(true),
              refreshLinterEffect.of(true)
            ] })
          }
        })

        dia.actions = actions

        diagnostics.push(dia)
      }
    }
  }

  // Reset the accumulated changes.
  view.dispatch({ effects: [ updateLTState.of({ running: false }), ltChangesEffect.of(null) ] })

  return diagnostics
})

const languagetoolTheme = EditorView.theme({
  '.cm-diagnosticAction.cm-ltDisableAction': {
    backgroundColor: '#af5151'
  }
})

export const languageTool = [
  ltLinter,
  languageToolState,
  languagetoolTheme,
  ltChangesField
]
