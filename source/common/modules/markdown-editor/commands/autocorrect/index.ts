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

import { syntaxTree } from '@codemirror/language'
import type { EditorState, SelectionRange } from '@codemirror/state'
import type { ChangeSpec } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { autoReplacePlugin } from './replace'
import { insertNewlineAndIndent, isolateHistory } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { configField, type AutocorrectOptions } from '../../util/configuration'
import { primaryMagicQuotePlugin, secondaryMagicQuotePlugin, undoMagicQuotePlugin } from './quotes'

// Nodes where autocorrect should not happen.
export const PROTECTED_NODES = [
  'InlineCode', // `code`
  'Comment', 'CommentBlock', // <!-- comment -->
  'FencedCode', 'CodeText', // Code block
  'HorizontalRule', // --- and ***
  'YAMLFrontmatter',
  'HTMLTag', 'HTMLBlock', // HTML elements
  'PandocAttribute',
]

// Autocorrect API
export interface AutocorrectPlugin {
  // Return a `ChangeSpec` with the text correction, or `null` if no replacement occurred.
  correct: (options: AutocorrectOptions, state: EditorState, range: SelectionRange, tree: Tree) => ChangeSpec | null
}

/* Dispatch autocorrect text replacement.
 *
 * Given a list of autocorrect plugins, this function operates on
 * all available ranges and dispatches the correction from the first
 * successful plugin replacement.
 *
 * @param {EditorView}            target
 * @param {AutocorrectPlugin[]}   plugins
 *
 * @return {boolean}
 */
function handleAutocorrectReplacement (target: EditorView, plugins: AutocorrectPlugin[]): boolean {
  // The config field is only present in the main editor, not in the assets
  // manager code editors or elsewhere.
  const config = target.state.field(configField, false)
  if (config === undefined) {
    return false
  }

  let { autocorrect } = config
  if (!autocorrect.active) {
    return false
  }

  // Perform some sanitation outside of the `changeByRange` loop
  autocorrect = {
    ...autocorrect,
    replacements: [...autocorrect.replacements]
      .sort((a, b) => b.key.length - a.key.length),
  }

  const tree = syntaxTree(target.state)

  const transaction = target.state.changeByRange((range) => {
    for (const p of plugins) {
      const changes =  p.correct(autocorrect, target.state, range, tree)

      if (changes) {
        const desc = target.state.changes(changes).desc

        // Return so that no other plugin applies changes.
        return { range: range.map(desc, 1), changes }
      }
    }

    // No plugin was successful, so return the unchanged range.
    return { range }
  })

  if (transaction.changes.empty) {
    return false
  }

  target.dispatch({ ...transaction, annotations: isolateHistory.of('full') })

  return true
}

// Space key handling for autocorrect
export const handleAutocorrectSpace: Command = (target: EditorView) => {
  // By dispatching the Space transaction first, the replacement
  // appears after it in the undo history, providing better undo UX.
  target.dispatch(target.state.replaceSelection(' '))

  handleAutocorrectReplacement(target, [
    autoReplacePlugin,
  ])

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
    handleAutocorrectReplacement(target, [
      autoReplacePlugin,
    ])

    // Always return `true` due to dispatching `insertNewlineContinueMarkup`,
    // even if `handleReplacement` fails.
    return true
  }

  return false
}

// Handles backspace presses that turn magic quotes into regular quotes
export const handleAutocorrectBackspace: Command = (target: EditorView) => {
  return handleAutocorrectReplacement(target, [undoMagicQuotePlugin])
}

// Adds primary magic quotes instead of simple quotes, if applicable
export const handleAutoCorrectPrimaryQuote: Command = (target: EditorView) => {
  return handleAutocorrectReplacement(target, [primaryMagicQuotePlugin])
}

// Adds secondary magic quotes instead of simple quotes, if applicable
export const handleAutoCorrectSecondaryQuote: Command = (target: EditorView) => {
  return handleAutocorrectReplacement(target, [secondaryMagicQuotePlugin])
}

