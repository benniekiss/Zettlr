import { nodeAtPos } from '../../util/node-in-selection'
import { PROTECTED_NODES, type AutocorrectPlugin } from '.'

// Matches the last word of the string if it starts with two
// upper-case letters and is followed by all-lowercase letters.
const UPPERCASE_RE = /\b(\p{Lu})(\p{Lu})\p{Ll}+\p{P}*$/vd

/**
 * Autocorrect words with two leading capital letters to title case.
 *
 * @param   {string}    text    The text to correct. Will only affect the last word.
 * @param   {number}    pos     The document-relative start position of `text`.
 *
 * @returns {ChangeSpec|null}   A ChangeSpec representing the replacement, or null
 *                              if no replacement was made.
 */
export const normalizeCapitalsPlugin: AutocorrectPlugin = {
  correct (options, view, range, tree) {
    if (!options.capitalization.doubleCaps) { return null }

    if (!range.empty) { return null }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) { return null }

    const line = view.state.doc.lineAt(pos)
    const text = view.state.sliceDoc(line.from, pos)

    const locale: string = window.config.get('appLang')

    const match = UPPERCASE_RE.exec(text)
    if (!match?.indices || match.indices[1] === undefined || match.indices[2] === undefined) {
      return null
    }

    const [from] = match.indices[1]
    const [ , to ] = match.indices[2]

    const isProtected = nodeAtPos(line.from + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(line.from + to, tree, PROTECTED_NODES, -1)

    if (isProtected !== null) {
      return null
    }

    const insert = match[1] + match[2].toLocaleLowerCase(locale)

    return { from: line.from + from, to: line.from + to, insert }
  }
}
