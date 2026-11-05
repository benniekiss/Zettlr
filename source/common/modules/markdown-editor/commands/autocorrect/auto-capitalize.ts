import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

// Matches the last word of the string if it starts with a lowercase letter
const LOWERCASE_RE = /\b(\p{Ll})\p{L}+\p{P}*$/vd

// Capitalize words at the start of sentences.
export const autoCapitalizePlugin: AutocorrectPlugin =  {
  correct (options, state, range, tree) {
    if (!options.capitalization.autoCapitalize) {
      return
    }

    if (!range.empty) {
      return
    }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) {
      return
    }

    const line = state.doc.lineAt(pos)
    const text = state.sliceDoc(line.from, pos)

    const locale: string = window.config.get('appLang')
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })

    const match = LOWERCASE_RE.exec(text)
    if (match?.indices && match.indices[1] !== undefined) {
      const [ from, to ] = match.indices[1]

      const isProtected = nodeAtPos(line.from + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(line.from + to, tree, PROTECTED_NODES, -1)
      if (isProtected !== null) {
        return
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
        return { from: line.from + from, to: line.from + to, insert: match[1].toLocaleUpperCase(locale) }
      }
    }
  }
}
