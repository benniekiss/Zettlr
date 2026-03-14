/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Autocorrect
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This is the autocorrect plugin, but since it basically just
 *                  consists of commands, we added it to the commands folder.
 *
 * END HEADER
 */

// The autocorrect plugin is basically just a keymap that listens to spaces and enters
import { EditorSelection, type ChangeSpec } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Tree } from '@lezer/common'
import { configField } from '../util/configuration'
import { insertNewlineAndIndent, isolateHistory } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { nodeAtPos } from '../util/node-in-selection'
import _ from 'lodash'

// These characters can be directly followed by a starting magic quote
const startChars = ' ([{-–—\n\r\t\v\f/\\'

const PROTECTED_NODES = [
  'InlineCode', // `code`
  'Comment', 'CommentBlock', // <!-- comment -->
  'FencedCode', 'CodeText', // Code block
  'HorizontalRule', // --- and ***
  'YAMLFrontmatter',
  'HTMLTag', 'HTMLBlock', // HTML elements
  'PandocAttribute',
]

/**
 * Autocorrect words with two leading capital letters to title case.
 *
 * @param   {string}    text    The text to correct. Will only affect the last word.
 * @param   {number}    pos     The document-relative start position of `text`.
 *
 * @returns {ChangeSpec|null}   A ChangeSpec representing the replacement, or null
 *                              if no replacement was made.
 */
function normalizeLeadingDoubleCaps (text: string, pos: number, tree: Tree): ChangeSpec | null {
  const locale: string = window.config.get('appLang')
  // Matches the last word of the string if it starts with two
  // upper-case letters and is followed by all-lowercase letters.
  const match = /\b(\p{Lu})(\p{Lu})\p{Ll}+\p{P}*$/vd.exec(text)
  if (!match?.indices) {
    return null
  }

  const [ , [from], [ , to ] ] = match.indices

  const isProtected = nodeAtPos(pos + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(pos + to, tree, PROTECTED_NODES, -1)
  if (isProtected !== null) {
    return null
  }

  const insert = match[1] + match[2].toLocaleLowerCase(locale)

  return { from: pos + from, to: pos + to, insert }
}

/**
 * Autocapitalize words at the start of sentences.
 *
 * @param   {string}    text    The text to correct. Will only affect the last word.
 * @param   {number}    pos     The document-relative start position of `text`.
 *
 * @returns {ChangeSpec|null}   A ChangeSpec representing the replacement, or null
 *                              if no replacement was made.
 */
function capitalizeStartofSentence (text: string, pos: number, tree: Tree): ChangeSpec | null {
  const locale: string = window.config.get('appLang')
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })

  // Matches the last word of the string if it starts with a lowercase letter
  const match = /\b(\p{Ll})\p{L}+\p{P}*$/vd.exec(text)
  if (match?.indices) {
    const [ from, to ] = match.indices[1]

    const isProtected = nodeAtPos(pos + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(pos + to, tree, PROTECTED_NODES, -1)
    if (isProtected !== null) {
      return null
    }

    // Capitalize the found word, then segment the text into sentences.
    const saneLine = text.slice(0, from) + match[1].toLocaleUpperCase(locale) + text.slice(to)
    const segments = [...segmenter.segment(saneLine)]

    // If the last sentence starts at the position of the found word, then
    // the replacement was correct because it fell at the sentence boundary.
    // If the last sentence does not start at the position of the found word,
    // then the replacement did not occur at the start of a sentence and is
    // invalid.
    if (segments[segments.length - 1].index === from) {
      return { from: pos + from, to: pos + to, insert: match[1].toLocaleUpperCase(locale) }
    }
  }

  return null
}

/**
 * Parse a string into a RegExp. If the string is in the form  of
 * `/pattern/flags`, then the returned RegExp will be created based on the
 * provided pattern and flags. If it is a plain string, i.e., not contained
 * within slashes (`/`), then the string is escaped and appended with a
 * line-ending assertion and converted into a RegExp object.
 *
 * @param {string}    key   The string to parse
 *
 * @returns {RegExp}        The newly created regex from `key`.
 */
function parseAutocorrectKey (key: string, matchWholeWords: boolean): RegExp|undefined {
  // Using `\b` (word boundary) checks here would produce unexpected results for
  // non-word character replacements, such as `-->` to `→`. In those instances,
  // `matchWholeWords` would only match if the replacement is preceded by a word
  // character. Instead, check for a preceding non-word character using a
  // lookbehind to exclude the character from the match and assert the correct
  // semantics for `matchWholeWords`
  const prefix = matchWholeWords ? '(?<=\W)' : ''

  let body = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let flags = ''

  // Parse potential regex patterns, which are enclosed in forward slashes
  if (key.length >= 2 && key.startsWith('/')) {
    // There may be flags after the key
    const lastSlash = key.lastIndexOf('/')

    if (lastSlash > 0) {
      body = key.slice(1, lastSlash)
      flags = key.slice(lastSlash + 1)

      // Validate flags
      if (!/^[gimsuy]*$/.test(flags)) {
        flags = ''
      }
    }
  }

  if (!body.endsWith('$')) {
    body += '$'
  }

  if (!body.startsWith(prefix)) {
    body = prefix + body
  }

  if (!body.startsWith(prefix)) {
    body = prefix + body
  }

  try {
    return new RegExp(body, flags)
  } catch (err: unknown) {
    console.info('[autocorrect] Failed to parse string as `RegExp`: ', key, err instanceof Error ? err : 'unknown error')
  }
}

// If Autocorrect is active, handles the potential text replacement
export const handleReplacement: Command = (target: EditorView): boolean => {
  // The config field is only present in the main editor, not in the assets
  // manager code editors or elsewhere.
  const config = target.state.field(configField, false)
  if (config === undefined) {
    return false
  }

  const { autocorrect } = config
  if (!autocorrect.active || autocorrect.replacements.length === 0) {
    return false
  }

  // Make a deep copy of the autocorrect (to not mess with the order), sort by
  // key length descending.
  const replacements = autocorrect.replacements.map(e => { return { ...e } })
  replacements.sort((a, b) => b.key.length - a.key.length)

  const changes: ChangeSpec[] = []

  const tree = syntaxTree(target.state)
  for (const range of target.state.selection.ranges) {
    // Ignore selections (only cursors)
    if (!range.empty) {
      continue
    }

    // Offset by 1 since this occurs after the transaction to insert
    // the newline or space
    let pos = range.from - 1

    // Ignore those cursors that are inside protected nodes
    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1) !== null) {
      continue
    }

    // Leave --- and ... lines (YAML frontmatter as well as horizontal rules)
    // We have investigated finding these as protected nodes. However, '---' in
    // the first line is not parsed as any type.
    const line = target.state.doc.lineAt(pos)
    if ([ '---', '...' ].includes(line.text)) {
      continue
    }

    const endPos = pos - line.from
    // Limit test strings to 200 characters. This is likely far outside
    // of what a user would input as an autocorrect target.
    const startPos = Math.max(0, endPos - 200)

    const slice = line.text.slice(startPos, endPos)
    for (let { key, value } of replacements) {
      const re = parseAutocorrectKey(key, autocorrect.matchWholeWords)

      // The regex could not be parsed
      if (!re) {
        continue
      }

      value = slice.replace(re, value)

      // Nothing was replaced since the value after replacement is the same.
      if (value === slice) {
        continue
      }

      const start = line.from + startPos + slice.search(re)
      if (nodeAtPos(start, tree, PROTECTED_NODES, -1) !== null) {
        break // `range.from` is not in a protected area, but start is.
      }

      changes.push({ from: line.from + startPos, to: pos, insert: value })
      break // Do not check the other possible replacements
    }

    if (autocorrect.capitalization.doubleCaps) {
      const doubleCaps = normalizeLeadingDoubleCaps(target.state.sliceDoc(line.from, pos), line.from, tree)

      if (doubleCaps) {
        changes.push(doubleCaps)
        break
      }
    }

    if (autocorrect.capitalization.autoCapitalize) {
      const autoCapitalize = capitalizeStartofSentence(target.state.sliceDoc(line.from, pos), line.from, tree)

      if (autoCapitalize) {
        changes.push(autoCapitalize)
        break
      }
    }
  }

  if (changes.length > 0) {
    // Isolate the transaction in the undo-history so that a user
    // can override the replacement without removed the space/newline
    target.dispatch({ changes, annotations: isolateHistory.of('full') })

    // Indicate a replacement happened
    return true
  }

  return false
}

// Space key handling for autocorrect
export const handleAutocorrectSpace: Command = (target: EditorView) => {
  // By dispatching the Space transaction first, the replacement
  // appears after it in the undo history, providing better undo UX.
  target.dispatch(target.state.replaceSelection(' '))

  handleReplacement(target)

  // Always return `true` due to dispatching `replaceSelection`
  // even if `handleReplacement` fails.
  return true
}

// Enter key handling for autocorrect
export const handleAutocorrectEnter: Command = (target: EditorView) => {
  // By dispatching the Enter transaction first, the replacement
  // appears after it in the undo history, providing better undo UX.
  // NOTE: We first need to invoke `insertNewlineContinueMarkup` and, if that
  // returns false, immediately invoke `insertNewlineAndIndent` to mimick the
  // Enter overloads in the default keymap and ensure lists are continued.
  if (insertNewlineContinueMarkup(target) || insertNewlineAndIndent(target)) {
    handleReplacement(target)

    // Always return `true` due to dispatching `insertNewlineContinueMarkup`,
    // even if `handleReplacement` fails.
    return true
  }

  return false
}

/**
 * Handles backspace presses that turn magic quotes into regular quotes
 *
 * @param   {EditorView}  view  The editor view
 *
 * @return  {boolean}           Whether the function has replaced a quote
 */
export function handleBackspace (view: EditorView): boolean {
  // The config field is only present in the main editor, not in the assets
  // manager code editors or elsewhere.
  const config = view.state.field(configField, false)
  if (config === undefined) {
    return false
  }

  const { autocorrect } = config
  if (!autocorrect.active) {
    return false
  }

  const primaryMagicQuotes = autocorrect.magicQuotes.primary.split('…')
  const secondaryMagicQuotes = autocorrect.magicQuotes.secondary.split('…')

  // This checks if we have a magic quote right before the cursor. If so,
  // pressing Backspace will not remove the quote, but rather replace it with a
  // simple " or ' quote.
  const changes: ChangeSpec[] = []

  for (const range of view.state.selection.ranges) {
    if (range.from === 0 || !range.empty) {
      continue
    }

    const slice = view.state.sliceDoc(range.from - 1, range.from)
    if (primaryMagicQuotes.includes(slice) && slice !== '"') {
      changes.push({ from: range.from - 1, to: range.from, insert: '"' })
    } else if (secondaryMagicQuotes.includes(slice) && slice !== "'") {
      changes.push({ from: range.from - 1, to: range.from, insert: "'" })
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
  }

  return changes.length > 0 // If we've replaced a quote, we must stop Codemirror from removing it
}

/**
 * Adds magic quotes instead of simple quotes, if applicable
 *
 * @param   {string}  quote  The quote to replace, either ' or "
 *
 * @return  {Command}        Returns a Command function
 */
export function handleQuote (quote: string): Command {
  return function (view: EditorView): boolean {
    // The config field is only present in the main editor, not in the assets
    // manager code editors or elsewhere.
    const config = view.state.field(configField, false)
    if (config === undefined) {
      return false
    }

    const { autocorrect } = config
    if (!autocorrect.active) {
      return false
    }

    const primary = autocorrect.magicQuotes.primary.split('…')
    const secondary = autocorrect.magicQuotes.secondary.split('…')
    const quotes = (quote === '"') ? primary : secondary

    const tree = syntaxTree(view.state)

    const transaction = view.state.changeByRange((range) => {
      // NOTE we're running through the hassle of definitely inserting quotes as
      // otherwise the quote character would be swallowed, even in "protected"
      // areas of the document.
      const isFromProtected = nodeAtPos(range.from, tree, PROTECTED_NODES, -1) !== null
      const isToProtected = nodeAtPos(range.to, tree, PROTECTED_NODES, -1) !== null

      if (range.empty) {
        // Check the character before and insert an appropriate quote
        const charBefore = view.state.sliceDoc(range.from - 1, range.from)
        const insert = isFromProtected
          ? quote // `from` is protected so no fancy quotes
          : startChars.includes(charBefore) ? quotes[0] : quotes[1]

        return {
          range: EditorSelection.cursor(range.to + insert.length),
          changes: {
            from: range.from,
            to: range.to,
            insert
          }
        }
      } else {
        // Surround the selection with quotes
        const text = view.state.sliceDoc(range.from, range.to)
        const quoteStart = isFromProtected ? quote : quotes[0]
        const quoteEnd = isToProtected ? quote : quotes[1]
        return {
          range: EditorSelection.range(range.from + quoteStart.length, range.to + quoteEnd.length),
          changes: { from: range.from, to: range.to, insert: `${quoteStart}${text}${quoteEnd}` }
        }
      }
    })

    view.dispatch(transaction)

    return true
  }
}
