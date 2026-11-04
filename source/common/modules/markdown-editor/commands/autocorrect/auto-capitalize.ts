import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

const LOWERCASE_RE = /\b(\p{Ll})\p{L}+\p{P}*$/vd

/**
 * Autocapitalize words at the start of sentences.
 *
 * @param   {string}    text    The text to correct. Will only affect the last word.
 * @param   {number}    pos     The document-relative start position of `text`.
 *
 * @returns {ChangeSpec|null}   A ChangeSpec representing the replacement, or null
 *                              if no replacement was made.
 */
export const autoCapitalizePlugin: AutocorrectPlugin =  {
  correct (options, view, range, tree) {
    if (!options.capitalization.autoCapitalize) { return null }

    if (!range.empty) { return null }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) { return null }

    const line = view.state.doc.lineAt(pos)
    const text = view.state.sliceDoc(line.from, pos)

    const locale: string = window.config.get('appLang')
    const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' })

    // Matches the last word of the string if it starts with a lowercase letter
    const match = LOWERCASE_RE.exec(text)
    if (match?.indices && match.indices[1] !== undefined) {
      const [ from, to ] = match.indices[1]

      const isProtected = nodeAtPos(line.from + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(line.from + to, tree, PROTECTED_NODES, -1)
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
        return { from: line.from + from, to: line.from + to, insert: match[1].toLocaleUpperCase(locale) }
      }
    }

    return null
  }
}
