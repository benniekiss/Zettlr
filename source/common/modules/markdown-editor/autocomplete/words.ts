/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Word suggestions
 * CVM-Role:        Autocomplete Plugin
 * Maintainer:      Bennie Milburn
 * License:         GNU GPL v3
 *
 * Description:     This plugin suggests words, optionally configured
 *                  to only show words of a minimum length.
 *
 *                  Adapted from the codemirror plugin,
 *                  [completeAnyWord](https://codemirror.net/docs/ref/#autocomplete.completeAnyWord)
 *
 * END HEADER
 */

import type { Text } from '@codemirror/state'
import type { Completion } from '@codemirror/autocomplete'
import { configField } from '../util/configuration'
import type { AutocompletePlugin } from '.'

const enum LIMITS {
  Range = 25_000, // Only process this many chars before and after the query position
  MinCacheLen = 1000, // Minimum length before a text is cached
  MaxList = 2000, // Maximum number of words to return
}

function wordRE (wordChars: string) {
  const escaped = wordChars.replace(/[\]\-\\]/g, '\\$&')

  return new RegExp(`[\\p{Alphabetic}\\p{Number}_${escaped}'-]+`, 'ug')
}

function mapRE (re: RegExp, f: (source: string) => string) {
  return new RegExp(f(re.source), 'u')
}

const wordCaches: { [wordChars: string]: WeakMap<Text, readonly Completion[]> } = {}

function wordCache (wordChars: string) {
  return wordCaches[wordChars] ?? (wordCaches[wordChars] = new WeakMap<Text, readonly Completion[]>())
}

function storeWords (doc: Text, wordRE: RegExp, result: Completion[], seen: { [word: string]: boolean }, ignoreAt: number) {
  for (let lines = doc.iterLines(), pos = 0; !lines.next().done;) {
    const { value } = lines
    let match

    wordRE.lastIndex = 0
    while (match = wordRE.exec(value)) {
      if (!seen[match[0]] && pos + match.index != ignoreAt) {
        result.push({ type: 'text', label: match[0] })
        seen[match[0]] = true

        if (result.length >= LIMITS.MaxList) { return }
      }
    }

    pos += value.length + 1
  }
}

function collectWords (doc: Text, cache: WeakMap<Text, readonly Completion[]>, wordRE: RegExp, ignoreAt: number) {
  const cached = cache.get(doc)
  if (cached) {
    return cached
  }

  const result: Completion[] = []
  const seen: { [word: string]: boolean } = {}

  if (doc.children) {
    let pos = 0
    for (const ch of doc.children) {
      if (ch.length >= LIMITS.MinCacheLen) {
        for (let c of collectWords(ch, cache, wordRE, ignoreAt - pos)) {
          if (!seen[c.label]) {
            seen[c.label] = true
            result.push(c)
          }
        }
      } else {
        storeWords(ch, wordRE, result, seen, ignoreAt - pos)
      }
      pos += ch.length + 1
    }
  } else {
    storeWords(doc, wordRE, result, seen, ignoreAt)
  }

  if (doc.length >= LIMITS.MinCacheLen && result.length < LIMITS.MaxList) {
    cache.set(doc, result)
  }

  return result
}

export const words: AutocompletePlugin = {
  applies (ctx) {
    const { active, numChars } = ctx.state.field(configField).autocorrect.suggestWords
    if (!active) { return false }

    const wordChars = ctx.state.languageDataAt<string>('wordChars', ctx.pos)[0] ?? ''
    const re = wordRE(wordChars)
    const token = ctx.matchBefore(mapRE(re, s => s + '$'))

    if (!token || (ctx.pos - token.from) < numChars ) { return false }

    return token.from
  },
  entries (ctx, query) {
    const { minLength } = ctx.state.field(configField).autocorrect.suggestWords

    const wordChars = ctx.state.languageDataAt<string>('wordChars', ctx.pos)[0] ?? ''
    const re = wordRE(wordChars)

    // Normalize the range to line positions to stabilize cache lookups
    const from = ctx.state.doc.lineAt(Math.max(ctx.pos - LIMITS.Range, 0)).from
    const to = ctx.state.doc.lineAt(Math.min(ctx.pos + LIMITS.Range, ctx.state.doc.length)).to
    const doc = ctx.state.doc.slice(from, to)

    this.validFor = mapRE(re, s => '^' + s)

    const options = collectWords(doc, wordCache(wordChars), re, ctx.pos - query.length)
    return options.filter(c => c.label.length >= minLength)
  },
}
