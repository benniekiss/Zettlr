import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

// These characters can be directly followed by a starting magic quote
const START_CHARS = ' ([{-–—\n\r\t\v\f/\\'

/**
 * Adds magic quotes instead of simple quotes, if applicable
 *
 * @param   {string}  quote  The quote to replace, either ' or "
 *
 * @return  {Command}        Returns a Command function
 */
function getMagicQuotePlugin (quote: '"' | "'"): AutocorrectPlugin {
  return {
    correct (options, state, range,tree) {
      // NOTE we're running through the hassle of definitely inserting quotes as
      // otherwise the quote character would be swallowed, even in "protected"
      // areas of the document.
      const isProtected = nodeAtPos(range.from, tree, PROTECTED_NODES, -1) ?? nodeAtPos(range.to, tree, PROTECTED_NODES, -1)

      if (isProtected) {
        return
      }

      const primary = options.magicQuotes.primary.split('…')
      const secondary = options.magicQuotes.secondary.split('…')
      const quotes = (quote === '"') ? primary : secondary

      let insert

      if (range.empty) {
      // Check the character before and insert an appropriate quote
        const charBefore = state.sliceDoc(range.from - 1, range.from)
        insert = START_CHARS.includes(charBefore) ? quotes[0] : quotes[1]
      } else {
      // Wrap the selection in quotes
        const text = state.sliceDoc(range.from, range.to)
        insert = `${quotes[0]}${text}${quotes[1]}`
      }

      if (!insert) {
        return
      }

      return {
        from: range.from,
        to: range.to,
        insert
      }
    }
  }
}

// Replace primary straight quotes with curly quotes
export const primaryMagicQuotePlugin: AutocorrectPlugin = getMagicQuotePlugin('"')

// Replace secondary straight quotes with curly quotes
export const secondaryMagicQuotePlugin: AutocorrectPlugin = getMagicQuotePlugin("'")

// Replace curly quotes with straight quotes
export const undoMagicQuotePlugin: AutocorrectPlugin = {
  correct (options, state, range, tree) {
    if (!range.empty) {
      return
    }

    if (nodeAtPos(range.from, tree, PROTECTED_NODES, -1)) {
      return
    }

    const primaryMagicQuotes = options.magicQuotes.primary.split('…')
    const secondaryMagicQuotes = options.magicQuotes.secondary.split('…')

    const slice = state.sliceDoc(range.from - 1, range.from)

    if (primaryMagicQuotes.includes(slice) && slice !== '"') {
      return { from: range.from - 1, to: range.from, insert: '"' }
    }

    if (secondaryMagicQuotes.includes(slice) && slice !== "'") {
      return { from: range.from - 1, to: range.from, insert: "'" }
    }
  }
}
