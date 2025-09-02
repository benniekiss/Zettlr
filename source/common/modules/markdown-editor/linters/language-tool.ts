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
import {
  StateField,
  StateEffect,
  ChangeSet,
  type ChangeDesc,
  type Transaction
} from '@codemirror/state'
import { linter, forEachDiagnostic, type Diagnostic, type Action } from '@codemirror/lint'
import { extractTextnodes, markdownToAST } from '@common/modules/markdown-utils'
import { configField } from '../util/configuration'
import { type LanguageToolAPIResponse } from '@providers/commands/language-tool'
import extractYamlFrontmatter from 'source/common/util/extract-yaml-frontmatter'
import { getBlockPosition, rangesOverlap, mergeRanges } from '../util/expand-selection'

const ipcRenderer = window.ipc

export interface LanguageToolStateField {
  running: boolean
  lastDetectedLanguage: string
  supportedLanguages: string[]
  overrideLanguage: 'auto'|string
  lastError: string|undefined
}

export const updateLTState = StateEffect.define<Partial<LanguageToolStateField>>()

export const languageToolState = StateField.define<LanguageToolStateField>({
  create: (state) => {
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
      supportedLanguages: []
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
      }
    }
    return value
  }
})

const resetLanguageToolChanges = StateEffect.define<null>()
export const languageToolChangesField = StateField.define<ChangeDesc>({
  // create a ChangeSet that covers the entire document so that
  // the entire document is linted on startup.
  create: (state) => ChangeSet.of({ from: 0, to: state.doc.length, insert: state.doc.toString() }, state.doc.length).desc,
  update (value, transaction: Transaction) {
    for (let e of transaction.effects) {
      if (e.is(resetLanguageToolChanges)) {
        return ChangeSet.empty(transaction.newDoc.length).desc
      }
    }

    if (!transaction.docChanged) {
      return value
    }

    const composedChanges = value.composeDesc(transaction.changes.desc)

    return composedChanges
  }
})

/**
 * Defines a spellchecker that runs over the text content of the document and
 * highlights misspelled words
 */
const ltLinter = linter(async view => {
  if (!view.state.field(configField).lintLanguageTool) {
    return []
  }

  view.dispatch({ effects: updateLTState.of({ running: true }) })

  const diagnostics: Diagnostic[] = []
  const changes = view.state.field(languageToolChangesField)

  let ranges: { from: number, to: number }[] = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    // we need to get the entire word, not just the changed text
    // because the changes could start in the middle of a word
    const { from, to } = getBlockPosition(view, fromB, toB, 1)
    ranges.push({ from, to })
  })

  // this tracks the new position of the diagnostic, so
  // we can just push it with the updated from and to.
  forEachDiagnostic(view.state, (d, from, to) => {
    if (d.source !== undefined && d.source?.includes('language-tool')) {
      if (!rangesOverlap({ from: d.from, to: d.to }, ranges)) {
        diagnostics.push({
          ...d,
          from: from,
          to: to,
        })
      } else {
        // since the changed ranges overlap with the diagnostic
        // we need to expand the context to include the entire diagnostic
        // to ensure we lint correctly
        ranges.push({ from, to })
      }
    }
  })

  // sort the ranges and merge any overlapping regions
  ranges = mergeRanges(ranges)

  const rangePromises: Promise<never[]|undefined>[] = []
  for (const { from, to } of ranges) {
    rangePromises.push((async () => {
      const text = view.state.sliceDoc(from, to)

      const ast = markdownToAST(text)
      const textNodes = extractTextnodes(ast)
      // To avoid too high loads, we have to send a "pseudo-plain text" document.
      // That will generate a few warnings that relate towards the Markdown syntax,
      // but we are clever: Since we can extract the textNodes, we can basically
      // ignore any warning outside of these ranges! YAY!

      const response: [LanguageToolAPIResponse, string[]]|undefined|string = await ipcRenderer.invoke('application', {
        command: 'run-language-tool',
        payload: {
          text,
          language: view.state.field(languageToolState).overrideLanguage
        }
      })

      view.dispatch({ effects: updateLTState.of({ running: false }) })

      if (response === undefined) {
        return [] // Could not fetch a response, but it's benign
      } else if (typeof response === 'string') {
        view.dispatch({ effects: updateLTState.of({ running: false, lastError: response }) })
        return [] // There was an error
      }

      const [ ltSuggestions, supportedLanguages ] = response

      view.dispatch({
        effects: updateLTState.of({
          running: false,
          lastDetectedLanguage: ltSuggestions.language.detectedLanguage.code,
          supportedLanguages
        })
      })

      if (ltSuggestions.matches.length === 0) {
        return [] // Hooray, nothing wrong!
      }

      // Now, we have to remove those matches that are outside any textNode in the
      // given document.
      for (let i = 0; i < ltSuggestions.matches.length; i++) {
        const fromOffset = ltSuggestions.matches[i].offset
        const toOffset = from + ltSuggestions.matches[i].length
        let isValid = false

        for (const node of textNodes) {
          if (fromOffset >= node.from && toOffset <= node.to) {
            // As soon as we find a textNode that contains the match, we are good.
            isValid = true
            break
          }
        }

        // Node is not valid --> remove
        if (!isValid) {
          ltSuggestions.matches.splice(i, 1)
          i--
        }
      }

      // At this point, we have only valid suggestions that we can now insert into
      // the document.
      for (const match of ltSuggestions.matches) {
        const source = `language-tool(${match.rule.issueType})`
        const severity = (match.rule.issueType === 'style')
          ? 'info'
          : (match.rule.issueType === 'misspelling') ? 'error' : 'warning'

        const dia: Diagnostic = {
          from: match.offset + from,
          to: match.offset + match.length + from,
          message: match.message,
          severity,
          source
        }

        if (match.replacements.length > 0) {
          const actions: Action[] = []

          // Show at most 10 actions to not overload those messages
          let i = 0
          for (const { value } of match.replacements) {
            if (i === 10) {
              break
            }
            i++

            actions.push({
              name: value,
              apply (view, from, to) {
                view.dispatch({ changes: { from, to, insert: value } })
              }
            })
          }

          dia.actions = actions
        }
        diagnostics.push(dia)
      }
    })())
  }

  await Promise.all(rangePromises)

  // since we've linted, we can reset the accumulated changes
  view.dispatch({
    effects: resetLanguageToolChanges.of(null)
  })

  return diagnostics
// Increase the delay to comply with the
// hosted language tool api rules
// https://dev.languagetool.org/public-http-api
}, { delay: 5000 })

export const languageTool = [
  ltLinter,
  languageToolState,
  languageToolChangesField
]
