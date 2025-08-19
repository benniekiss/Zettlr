/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        CodeMirror Extension
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A configurable line number extension for CodeMirror.
 *
 * END HEADER
 */

import {
  EditorView,
} from '@codemirror/view'
import {
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { configUpdateEffect } from '../util/configuration'

/**
 * Toggle whether to show line pilcrows (¶ markers)
 */
export const showLinePilcrowEffect = StateEffect.define<boolean>()

/**
 * A StateField to track the current pilcrow toggle state.
 */
const showLinePilcrowField = StateField.define<boolean>({
  create () {
    return false
  },

  update (value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(configUpdateEffect) && effect.value.showLinePilcrow !== undefined) {
        value = effect.value.showLinePilcrow
      } else if (effect.is(showLinePilcrowEffect)) {
        value = effect.value
      }
    }
    return value
  },

  provide: f =>
    EditorView.editorAttributes.compute([f], state =>
      state.field(f) ? { class: 'pilcrow' } : {} as Record<string, string>
    )
})

/**
 * A configurable pilcrow renderer.
 *
 * @param   {boolean}      show  Initial setting for the renderer
 *                                    (default: false)
 *
 * @return  {Extension[]}             The extension.
 */
export function showLinePilcrow (show?: boolean): Extension[] {
  return [
    showLinePilcrowField.init(() => show === true)
  ]
}
