import { PROTECTED_NODES, type AutocorrectPlugin } from '.'
import { nodeAtPos } from '../../util/node-in-selection'

/**
 * Parse a string into a RegExp. If the string is in the form  of
 * `/pattern/flags`, then the returned RegExp will be created based on the
 * provided pattern and flags. If it is a plain string, i.e., not contained
 * within slashes (`/`), then the string is escaped and appended with a
 * line-ending assertion and converted into a RegExp object.
 *
 * @param {string}    key   The string to parse
 *
 * @returns {RegExp}        The newly created regex from `key`.
 */
function parseAutocorrectKey (key: string, matchWholeWords: boolean): RegExp|undefined {
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
    return new RegExp(body, flags)
  } catch (err: unknown) {
    console.info('[autocorrect] Failed to parse string as `RegExp`: ', key, err instanceof Error ? err : 'unknown error')
  }
}

export const autoReplacePlugin: AutocorrectPlugin = {
  correct (options, view, range, tree) {
    if (!range.empty) { return null }

    const pos = range.from - 1

    if (nodeAtPos(pos, tree, PROTECTED_NODES, -1)) { return null }

    const line = view.state.doc.lineAt(pos)

    // Make a deep copy of the autocorrect (to not mess with the order), sort by
    // key length descending.
    const endPos = pos - line.from
    // Limit test strings to 200 characters. This is likely far outside
    // of what a user would input as an autocorrect target.
    const startPos = Math.max(0, endPos - 200)

    const slice = line.text.slice(startPos, endPos)

    for (let { key, value } of options.replacements) {
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

      if (nodeAtPos(start, tree, PROTECTED_NODES, -1) !== null) {
        continue // `range.from` is not in a protected area, but start is.
      }

      return { from: line.from + startPos, to: pos, insert: value }
    }

    return null
  }
}
