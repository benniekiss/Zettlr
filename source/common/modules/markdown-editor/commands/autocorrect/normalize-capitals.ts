import { nodeAtPos } from '../../util/node-in-selection'
import { PROTECTED_NODES, type AutocorrectPlugin } from '.'

// Matches the last word of the string if it starts with two
// upper-case letters and is followed by all-lowercase letters.
const UPPERCASE_RE = /\b(\p{Lu})(\p{Lu})\p{Ll}+\p{P}*$/vd

// Normalize words with two leading capital letters to title case.
export const normalizeCapitalsPlugin: AutocorrectPlugin = {
  correct (options, state, range, tree) {
    if (!options.capitalization.doubleCaps) {
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

    const match = UPPERCASE_RE.exec(text)
    if (!match?.indices || match.indices[1] === undefined || match.indices[2] === undefined) {
      return
    }

    const [from] = match.indices[1]
    const [ , to ] = match.indices[2]

    const isProtected = nodeAtPos(line.from + from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(line.from + to, tree, PROTECTED_NODES, -1)

    if (isProtected !== null) {
      return
    }

    const insert = match[1] + match[2].toLocaleLowerCase(locale)

    return { from: line.from + from, to: line.from + to, insert }
  }
}
