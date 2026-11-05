import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

// Maximum string search length for replacements.
// This is likely far outside of what a user would
// input as an autocorrect target.
const MAX_SEARCH_LENGTH = 200

// A cache of computed regexes
const REGEX_CACHE: { whole: Map<string, RegExp>, partial: Map<string, RegExp> } = {
  whole: new Map,
  partial: new Map,
}

/**
 * Parse a string into a RegExp. If the string is in the form  of
 * `/pattern/flags`, then the returned RegExp will be created based on the
 * provided pattern and flags. If it is a plain string, i.e., not contained
 * within slashes (`/`), then the string is escaped and appended with a
 * line-ending assertion and converted into a RegExp object.
 *
 * @param {string}    key               The string to parse
 * @param {boolean}   matchWholeWords   Whether the regex should match whole words
 *
 * @returns {RegExp}                    The newly created regex from `key`.
 */
function parseAutocorrectKey (key: string, matchWholeWords: boolean): RegExp|undefined {
  const cache = matchWholeWords ? REGEX_CACHE.whole : REGEX_CACHE.partial
  const cached_re = cache.get(key)
  if (cached_re) {
    return cached_re
  }

  // Using `\b` (word boundary) checks here would produce unexpected results for
  // non-word character replacements, such as `-->` to `→`. In those instances,
  // `matchWholeWords` would only match if the replacement is preceded by a word
  // character. Instead, check for a preceding non-word character using a
  // lookbehind to exclude the character from the match and assert the correct
  // semantics for `matchWholeWords`
  const prefix = matchWholeWords ? '(?<=^|\\W)' : ''

  let body = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let flags = ''

  // Parse potential regex patterns, which are enclosed in forward slashes
  if (key.length >= 2 && key.startsWith('/')) {
    // There may be flags after the key
    const lastSlash = key.lastIndexOf('/')

    if (lastSlash > 0) {
      body = key.slice(1, lastSlash)
      flags = key.slice(lastSlash + 1)

      // Validate flags
      if (!/^[gimsuy]*$/.test(flags)) {
        flags = ''
      }
    }
  }

  if (!body.endsWith('$')) {
    body += '$'
  }

  if (!body.startsWith(prefix)) {
    body = prefix + body
  }

  try {
    const re = new RegExp(body, flags)
    cache.set(key, re)

    return re
  } catch (err: unknown) {
    console.info('[autocorrect] Failed to parse string as `RegExp`: ', key, err instanceof Error ? err : 'unknown error')
  }
}

// Autocorrect replacement plugin
export const autoReplacePlugin: AutocorrectPlugin = {
  correct (options, state, range, tree) {
    if (!range.empty) {
      return
    }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) {
      return
    }

    const line = state.doc.lineAt(pos)
    const endPos = pos - line.from
    const startPos = Math.max(0, endPos - MAX_SEARCH_LENGTH)
    const slice = line.text.slice(startPos, endPos)

    // Make a deep copy of the autocorrect (to not mess with the order),
    // sort by key length descending.
    const replacements = options.replacements
      .map(e => { return { ...e } })
      .sort((a, b) => b.key.length - a.key.length)

    for (let { key, value } of replacements) {
      const re = parseAutocorrectKey(key, options.matchWholeWords)

      // The regex could not be parsed
      if (!re) {
        continue
      }

      value = slice.replace(re, value)

      // Nothing was replaced since the value after replacement is the same.
      if (value === slice) {
        continue
      }

      const start = line.from + startPos + slice.search(re)

      // `range.from` is not in a protected area, but start is.
      if (nodeAtPos(start, tree, PROTECTED_NODES, -1) !== null) {
        continue
      }

      return { from: line.from + startPos, to: pos, insert: value }
    }
  }
}
