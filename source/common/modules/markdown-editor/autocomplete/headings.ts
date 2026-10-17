/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Headings Autocomplete
 * CVM-Role:        Autocomplete Plugin
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This plugin manages insertion of internal (heading) links.
 *
 * END HEADER
 */

import type { EditorState } from '@codemirror/state'
import { type AutocompletePlugin } from '.'
import { tocField } from '../plugins/toc-field'


function getEntries (state: EditorState): { label: string, apply: string }[] {
  const entries = state.field(tocField)

  return entries.map(entry => {
    return {
      label: entry.text,
      apply: entry.id
    }
  })

}

export const headings: AutocompletePlugin = {
  applies (ctx) {
    const match = ctx.matchBefore(/\]\(#[^()]*$/)
    return match !== null ? match.from + 3 : false
  },
  entries (ctx, query) {
    query = query.toLowerCase()
    const entries = getEntries(ctx.state)
    return entries.filter(entry => {
      return entry.label.toLowerCase().includes(query)
    })
  },
  fields: []
}
