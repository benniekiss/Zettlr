/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Info Statusbar Items
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
*
 * Description:     This file defines a set of info statusbar items
 *
 * END HEADER
 */

import { type EditorState } from '@codemirror/state'
import { type EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import localiseNumber from '@common/util/localise-number'
import { countAll } from '@common/util/counter'
import { type StatusbarItem } from '.'
import { countField } from '../plugins/statistics-fields'
import { configField } from '../util/configuration'
import { markdownToAST } from '../../markdown-utils'

/**
 * Displays the cursor position
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element
 */
export function cursorStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const mainOffset = state.selection.main.head
  const line = state.doc.lineAt(mainOffset)
  return {
    content: `${line.number}:${mainOffset - line.from + 1}`
  }
}

function countSelection (state: EditorState): { words: number, chars: number } {
  const sel = state.selection.main
  const ast = markdownToAST(state.sliceDoc(sel.from, sel.to))
  return countAll(ast)
}

/**
 * Displays the word count, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function wordcountStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  if (!state.selection.main.empty) {
    const { words } = countSelection(state)
    return {
      content: trans('%s selected', localiseNumber(words))
    }
  }

  const counter = state.field(countField, false)
  const config = state.field(configField, false)
  if (counter === undefined || config?.countChars === true) {
    return null
  } else {
    return {
      content: trans('%s words', localiseNumber(counter.words))
    }
  }
}

/**
 * Displays the character count, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function charcountStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  if (!state.selection.main.empty) {
    const { chars } = countSelection(state)
    return {
      content: trans('%s selected', localiseNumber(chars))
    }
  }

  const counter = state.field(countField, false)
  const config = state.field(configField, false)
  if (counter === undefined|| config?.countChars === false) {
    return null
  } else {
    return {
      content: trans('%s characters', localiseNumber(counter.chars))
    }
  }
}

/**
 * Displays an input mode indication, if applicable
 *
 * @param   {EditorState}    state  The EditorState
 * @param   {EditorView}     view   The EditorView
 *
 * @return  {StatusbarItem}         Returns the element or null
 */
export function inputModeStatus (state: EditorState, _view: EditorView): StatusbarItem|null {
  const config = state.field(configField, false)
  if (config === undefined) {
    return null
  } else if (config.inputMode !== 'default') {
    return {
      content: 'Mode: ' + (config.inputMode === 'vim' ? 'Vim' : 'Emacs')
    }
  } else {
    return null
  }
}
