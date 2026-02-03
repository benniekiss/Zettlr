import type { Text } from '@codemirror/state'
import type { Completion } from '@codemirror/autocomplete'
import { configField } from '../util/configuration'
import type { AutocompletePlugin } from '.'

const enum LIMITS { Range = 50000, MinCacheLen = 1000, MaxList = 2000 }

function wordRE (wordChars: string) {
  const escaped = wordChars.replace(/[\]\-\\]/g, '\\$&')

  return new RegExp(`[\\p{Alphabetic}\\p{Number}_${escaped}'-]+`, 'ug')
}

function mapRE (re: RegExp, f: (source: string) => string) {
  return new RegExp(f(re.source), 'u')
}

const wordCaches: { [wordChars: string]: WeakMap<Text, readonly Completion[]> } = {}

function wordCache (wordChars: string) {
  let cache = wordCaches[wordChars]
  if (cache === undefined) {
    cache = new WeakMap<Text, readonly Completion[]>()
    wordCaches[wordChars] = cache
  }
  return cache
}

function storeWords (doc: Text, wordRE: RegExp, result: Completion[], seen: { [word: string]: boolean }, ignoreAt: number, minLength: number) {
  for (let lines = doc.iterLines(), pos = 0; !lines.next().done;) {
    let { value } = lines
    let match

    wordRE.lastIndex = 0
    while (match = wordRE.exec(value)) {
      const m = match[0]

      if (!seen[m] && pos + match.index != ignoreAt) {
        if (m.length < minLength) { continue }

        result.push({ type: 'text', label: m })
        seen[m] = true

        if (result.length >= LIMITS.MaxList) { return }
      }
    }

    pos += value.length + 1
  }
}

function collectWords (doc: Text, cache: WeakMap<Text, readonly Completion[]>, wordRE: RegExp, to: number, ignoreAt: number, minLength: number) {
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
        for (let c of collectWords(ch, cache, wordRE, to - pos, ignoreAt - pos, minLength)) {
          if (!seen[c.label]) {
            seen[c.label] = true
            result.push(c)
          }
        }
      } else {
        storeWords(ch, wordRE, result, seen, ignoreAt - pos, minLength)
      }
      pos += ch.length + 1
    }
  } else {
    storeWords(doc, wordRE, result, seen, ignoreAt, minLength)
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

    this.validFor = mapRE(re, s => '^' + s)

    const options = collectWords(ctx.state.doc, wordCache(wordChars), re, LIMITS.Range, ctx.pos - query.length, minLength)
    return options.filter(c => c.label.startsWith(query))
  },
}
