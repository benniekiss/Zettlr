/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Image and Link parser
 * CVM-Role:        View
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     A parser for images and links that, contrary to the
 *                  built-in parser, allows spaces and non-encoded characters
 *                  in URLs, allowing users the ability to paste readable,
 *                  non-URL-encoded file paths. This is similar to pandoc's parsing.
 *
 *                  Note: This should only handle link nodes with URLs, and all other link
 *                  types should end up being handled by the default link parser.
 *
 * END HEADER
 */

import { type InlineParser, type DelimiterType, InlineContext } from '@lezer/markdown'

const PandocLinkDelimiter: DelimiterType = {}

const linkClosingRe = /^\](?:\((?<url>.+)\)|\[(?<label>.*)\])/

const linkTitleRe = /(?:^|[ \t]+)(?:"(?<double>(?:\\.|[^"])+)"|'(?<single>(?:\\.|[^'])+)'|\((?<parens>(?:\\.|[^\)])+)\))$/d

// Link destinations can contain nested and balanced internal
// parenthesis (for URLs) and brackets (for labels). So we need
// to walk the destination text to find the correct, balanced
// closing mark since the regex is a greedy match.
function findEndOfLink (destination: string, opening: string, closing: string): string {
  let depth = 0
  let stop = 0

  while (stop <= destination.length) {
    const char = destination.charAt(stop)

    // Found the closing parenthesis
    if (char === closing && depth === 0) { break }

    if (char === closing) { depth-- }
    if (char === opening) { depth++ }

    // Skip the next character if the current
    // one is an escape character
    if (char === '\\') { stop++ }

    stop++
  }

  return destination.substring(0, stop)
}

export const pandocLinkParser: InlineParser = {
  name: 'pandoc-link-parser',
  before: 'Link',
  parse: (ctx, next, pos) => {
    if (next === 91) { // 91 === '['
      // Add the default link delimiter so that the
      // URL parser knows when to terminate early
      // due to internal logic.
      ctx.addDelimiter(InlineContext.linkStart, pos, pos + 2, true, false)
      return ctx.addDelimiter(PandocLinkDelimiter, pos, pos + 1, true, false)
    }

    if (next === 33 && ctx.char(pos + 1) === 91) { // 33 === '!', 91 === '['
      // Add the default image delimiter so that the
      // URL parser knows when to terminate early
      // due to internal logic.
      ctx.addDelimiter(InlineContext.imageStart, pos, pos + 2, true, false)
      return ctx.addDelimiter(PandocLinkDelimiter, pos, pos + 2, true, false)
    }

    if (next !== 93) { // 93 === ']'
      return -1
    }

    const opening = ctx.findOpeningDelimiter(PandocLinkDelimiter)
    if (opening === null) {
      return -1
    }

    const delim = ctx.getDelimiterAt(opening)
    if (!delim) {
      return -1
    }

    let linkEnd = pos + 1
    let linkContents = ctx.takeContent(opening - 1)

    const isLink = delim.to - delim.from === 1
    // Remove nested links, which are invalid
    if (isLink) {
      const linkType = ctx.parser.nodeSet.types.find(node => node.is('Link'))?.id
      const urlType = ctx.parser.nodeSet.types.find(node => node.is('URL'))?.id
      linkContents = linkContents.filter(el => el.type !== linkType && el.type !== urlType)
    }

    const linkDest = []
    const match = linkClosingRe.exec(ctx.text.slice(pos - ctx.offset))

    if (match?.groups?.url !== undefined) {
      let url = findEndOfLink(match.groups.url, '(', ')')
      let destination = url

      const urlContents = []
      const title = linkTitleRe.exec(destination)

      if (title?.indices?.groups) {
        destination = url.substring(0, title.index)

        const linkTitleIndices = title.indices.groups.double ?? title.indices.groups.single ?? title.indices.groups.parens
        urlContents.push(ctx.elt('LinkTitle', pos + 2 + linkTitleIndices[0], pos + 2 + linkTitleIndices[1]))
      }

      urlContents.unshift(ctx.elt('URL', pos + 2, pos + 2 + destination.length))

      const openingUrlMark = ctx.elt('LinkMark', pos + 1, pos + 2)
      const closingUrlMark = ctx.elt('LinkMark', pos + 2 + url.length, pos + 3 + url.length)

      linkDest.push(openingUrlMark, ...urlContents, closingUrlMark)
      // Closing marks (2) + url text
      linkEnd += 2 + url.length
    } else if (match?.groups?.label !== undefined) {
      let label = findEndOfLink(match.groups.label, '[', ']')

      // The label marks `[` and `]` are not parsed separately
      linkDest.push(ctx.elt('LinkLabel', pos + 2, pos + 3 + label.length))
      linkEnd += 2 + label.length
    }

    const openingMark = ctx.elt('LinkMark', delim.from, delim.to)
    const closingMark = ctx.elt('LinkMark', pos, pos + 1)

    // This child node structure mirrors the codemirror Link structure
    const children = [ openingMark, ...linkContents, closingMark, ...linkDest ]

    return ctx.addElement(ctx.elt(isLink ? 'Link' : 'Image', delim.from, linkEnd, children))
  }
}
