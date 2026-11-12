/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Text Replacement Autocorrect
 * CVM-Role:        Utility Function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     Text replacement autocorrect plugin.
 *
 * END HEADER
 */

import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

// Autocorrect replacement plugin
export const autoReplacePlugin: AutocorrectPlugin = {
  correct (options, state, range, tree) {
    if (!range.empty) {
      return null
    }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) {
      return null
    }

    const maxKeyLength = options.replacements[0].key.length

    const line = state.doc.lineAt(pos)
    const from = Math.max(0, pos - maxKeyLength)
    const slice = line.text.slice(from, pos)

    for (let { key, value } of options.replacements) {
      if (slice.endsWith(key)) {
        const startOfReplacement = pos - key.length
        if (nodeAtPos(startOfReplacement, tree, PROTECTED_NODES, -1) != null) {
          break // `range.from` is not in a protected area, but start is.
        }

        const charBefore = startOfReplacement === 0
          ? ' ' // Assume a space which makes below's code simpler
          : state.sliceDoc(startOfReplacement - 1, startOfReplacement)

        if (options.matchWholeWords && !/\W/.test(charBefore)) {
          // We should match whole words, but the replacement is
          // not preceeded by a non-word character.
          break
        }

        return { from: startOfReplacement, to: pos, insert: value }
      }
    }

    return null
  }
}
