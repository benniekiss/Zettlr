/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        defaultMenu function
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Contains a utility function to show a basic Markdown context
 *                  menu
 *
 * END HEADER
 */

import { type EditorView } from '@codemirror/view'
import { trans } from '@common/i18n-renderer'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import { type SyntaxNode } from '@lezer/common'
import { applyBold, applyItalic, insertLink, applyBlockquote, applyOrderedList, applyBulletList, applyTaskList } from '../commands/markdown'
import { cut, copyAsPlain, copyAsHTML, paste, pasteAsPlain } from '../util/copy-paste-cut'
import { getTransformSubmenu } from './transform-items'

/**
 * Shows a default context menu for the given node at the given coordinates in
 * the given view.
 *
 * @param   {EditorView}                view    The view
 * @param   {SyntaxNode}                node    The node
 * @param   {{ x: number, y: number }}  coords  The screen coordinates
 */
export async function defaultMenu (view: EditorView, node: SyntaxNode, coords: { x: number, y: number }): Promise<void> {
  const tpl: AnyMenuItem[] = [
    {
      label: trans('Bold'),
      accelerator: 'CmdOrCtrl+B',
      type: 'normal',
      action () { applyBold(view) }
    },
    {
      label: trans('Italic'),
      accelerator: 'CmdOrCtrl+I',
      type: 'normal',
      action () { applyItalic(view) }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Insert link'),
      accelerator: 'CmdOrCtrl+K',
      type: 'normal',
      action () { insertLink(view) }
    },
    {
      label: trans('Insert unordered list'),
      type: 'normal',
      action () { applyBulletList(view) }
    },
    {
      label: trans('Insert numbered list'),
      type: 'normal',
      action () { applyOrderedList(view) }
    },
    {
      label: trans('Insert task list'),
      accelerator: 'CmdOrCtrl+T',
      type: 'normal',
      action () { applyTaskList(view) }
    },
    {
      label: trans('Insert blockquote'),
      type: 'normal',
      action () { applyBlockquote(view) }
    },
    {
      label: trans('Insert table'),
      type: 'normal',
      action () { view.dispatch(view.state.replaceSelection('| | |\n|-|-|\n| | |\n')) }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Cut'),
      accelerator: 'CmdOrCtrl+X',
      type: 'normal',
      action () { cut(view) }
    },
    {
      label: trans('Copy'),
      accelerator: 'CmdOrCtrl+C',
      type: 'normal',
      action () { copyAsPlain(view) }
    },
    {
      label: trans('Copy as HTML'),
      accelerator: 'CmdOrCtrl+Alt+C',
      type: 'normal',
      action () { copyAsHTML(view) }
    },
    {
      label: trans('Paste'),
      accelerator: 'CmdOrCtrl+V',
      type: 'normal',
      action () { paste(view) }
    },
    {
      label: trans('Paste without style'),
      accelerator: 'CmdOrCtrl+Shift+V',
      type: 'normal',
      action () { pasteAsPlain(view) }
    },
    {
      type: 'separator'
    },
    {
      label: trans('Select all'),
      accelerator: 'CmdOrCtrl+A',
      type: 'normal',
      action () { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }) }
    },
    {
      type: 'separator'
    },
    getTransformSubmenu(view)
  ]

  showPopupMenu(coords, tpl)
}
