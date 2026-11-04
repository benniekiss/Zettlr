import { syntaxTree } from '@codemirror/language'
import type { SelectionRange, TransactionSpec } from '@codemirror/state'
import type { ChangeSpec } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { autoCapitalizePlugin } from './auto-capitalize'
import { autoReplacePlugin } from './replacement'
import { normalizeCapitalsPlugin } from './normalize-capitals'
import { insertNewlineAndIndent, isolateHistory } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { configField, type AutocorrectOptions } from '../../util/configuration'
import { primaryMagicQuotePlugin, secondaryMagicQuotePlugin, undoMagicQuotePlugin } from './magic-quotes'

export const PROTECTED_NODES = [
  'InlineCode', // `code`
  'Comment', 'CommentBlock', // <!-- comment -->
  'FencedCode', 'CodeText', // Code block
  'HorizontalRule', // --- and ***
  'YAMLFrontmatter',
  'HTMLTag', 'HTMLBlock', // HTML elements
  'PandocAttribute',
]

export interface AutocorrectPlugin {
  correct: (options: AutocorrectOptions, view: EditorView, range: SelectionRange, tree: Tree) => ChangeSpec | null
}

// If Autocorrect is active, handles the potential text replacement
function handleReplacement (target: EditorView, plugins: AutocorrectPlugin[]): TransactionSpec | null {
  // The config field is only present in the main editor, not in the assets
  // manager code editors or elsewhere.
  const config = target.state.field(configField, false)
  if (config === undefined) {
    return null
  }

  let { autocorrect } = config
  if (!autocorrect.active) {
    return null
  }

  // Make a deep copy of the autocorrect (to not mess with the order), sort by
  // key length descending.
  autocorrect = {
    ...autocorrect,
    replacements: autocorrect.replacements
      .map(e => { return { ...e } })
      .sort((a, b) => b.key.length - a.key.length)
    ,
  }

  const tree = syntaxTree(target.state)

  const transaction = target.state.changeByRange((range) => {
    for (const p of plugins) {
      const changes =  p.correct(autocorrect, target, range, tree) ?? undefined

      if (changes) {
        const desc = target.state.changes(changes).desc

        return { range: range.map(desc, 1), changes }
      }
    }

    return { range }
  })

  if (transaction.changes.empty) { return null }

  return { ...transaction, annotations: isolateHistory.of('full') }
}

// Space key handling for autocorrect
export const handleAutocorrectSpace: Command = (target: EditorView) => {
  // By dispatching the Space transaction first, the replacement
  // appears after it in the undo history, providing better undo UX.
  target.dispatch(target.state.replaceSelection(' '))

  const tr = handleReplacement(target, [
    autoReplacePlugin,
    autoCapitalizePlugin,
    normalizeCapitalsPlugin,
  ])

  if (tr) {
    target.dispatch(tr)
  }

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
    const tr = handleReplacement(target, [
      autoReplacePlugin,
      autoCapitalizePlugin,
      normalizeCapitalsPlugin,
    ])

    if (tr) {
      target.dispatch(tr)
    }

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
export const handleAutocorrectBackspace: Command = (target: EditorView) => {
  const tr = handleReplacement(target, [undoMagicQuotePlugin])

  if (tr) {
    target.dispatch(tr)

    return true
  }

  return false
}

/**
 * Adds magic quotes instead of simple quotes, if applicable
 *
 * @param   {string}  quote  The quote to replace, either ' or "
 *
 * @return  {Command}        Returns a Command function
 */
export const handleAutoCorrectPrimaryQuote: Command = (target: EditorView) => {
  const tr = handleReplacement(target, [primaryMagicQuotePlugin])

  if (tr) {
    target.dispatch(tr)

    return true
  }

  return false

}

export const handleAutoCorrectSecondaryQuote: Command = (target: EditorView) => {
  const tr = handleReplacement(target, [secondaryMagicQuotePlugin])

  if (tr) {
    target.dispatch(tr)

    return true
  }

  return false

}

