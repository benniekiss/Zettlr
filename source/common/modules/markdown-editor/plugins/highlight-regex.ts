/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Regex highlight plugin
 * CVM-Role:        ViewPlugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin renders custom regex expressions using a MatchDecorator
 *
 * END HEADER
 */

import { RangeSet } from '@codemirror/state'
import { Decoration, type EditorView, MatchDecorator, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { configField } from '../util/configuration'

function render (view: EditorView): MatchDecorator[] {
  const { customHighlighter: customDecos } = view.state.field(configField)

  const decos = []

  for (const { pattern, style } of customDecos) {
    try {
      const regexp = new RegExp(pattern, 'dg')

      const matchDeco = new MatchDecorator({
        regexp: regexp,
        decorate: (add, from, to, match, view) => {
          if (!match.indices) {
            return
          }

          const d = Decoration.mark({ class: style })

          // No capturing groups, so style the entire match
          if (match.indices.length === 1) {
            add(from, to, d)
            return
          }

          // There are capturing groups, so only style those ranges
          //
          // Note: The matching occurs line by line, so to get the correct
          // offset of the indices, we need the line position. The `from` and
          // `to` positions provided by the `decorate`  method refer to
          // document-relative positions of the entire matched string, while
          // `match.indices` positions are string-relative. If we were to
          // calculate the offset based on `from`, this would only work if the
          // matched groups occured at the start of the line.
          const line = view.state.doc.lineAt(from)
          for (const [ mFrom, mTo ] of match.indices.slice(1)) {
            add(line.from + mFrom, line.from + mTo,  d)
          }
        }
      })

      decos.push(matchDeco)
    } catch (err: unknown) {
      console.error(`Could not parse regex, ${pattern}: `, err)
    }
  }

  return decos
}

export const customHighlighter = ViewPlugin.define(view => ({
  decorations: render(view).map(deco => ({ match: deco, decorations: deco.createDeco(view) })),

  update (u: ViewUpdate) {
    const configChanged = u.startState.field(configField).customHighlighter !== u.state.field(configField).customHighlighter

    if (configChanged) {
      // Re-render decorations if the config has changed
      this.decorations = render(u.view).map(deco => ({
        match: deco,
        decorations: deco.createDeco(u.view)
      }))
    } else {
      this.decorations = this.decorations.map(deco => ({
        ...deco,
        decorations: deco.match.updateDeco(u, deco.decorations)
      }))
    }
  }
}), {
  decorations (value) {
    return RangeSet.join(value.decorations.flatMap(deco => deco.decorations))
  }
})
