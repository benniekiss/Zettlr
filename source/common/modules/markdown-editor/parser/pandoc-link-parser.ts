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

import { InlineContext, type InlineParser } from '@lezer/markdown'

const linkClosingRe = /^\]\((?<url>.+)\)/

const linkTitleRe = /(?:^|[ \t]+)(?:"(?<double>(?:\\.|[^"])+)"|'(?<single>(?:\\.|[^'])+)'|\((?<parens>(?:\\.|[^\)])+)\))$/d

export const pandocLinkParser: InlineParser = {
  name: 'pandoc-link-parser',
  after: 'Link',
  parse: (ctx, next, pos) => {
    if (next !== 93) { // 93 === ']'
      return -1
    }

    if (!ctx.hasOpenLink) {
      return -1
    }

    // We find the closest delimiter, which
    // could be a link (`[`) or an image (`![`)
    const openingLink = ctx.findOpeningDelimiter(InlineContext.linkStart)
    const openingImage = ctx.findOpeningDelimiter(InlineContext.imageStart)
    const opening = (openingLink ?? -1) > (openingImage ?? -1) ? openingLink : openingImage
    if (opening === null) {
      return -1
    }

    const delim = ctx.getDelimiterAt(opening)
    if (!delim) {
      return -1
    }

    const match = linkClosingRe.exec(ctx.text.slice(pos - ctx.offset))
    if (!match?.groups) {
      return -1
    }

    const isLink = delim.to - delim.from === 1
    let linkContents = ctx.takeContent(opening)

    // Remove nested links, which are invalid
    if (isLink) {
      const linkType = ctx.parser.nodeSet.types.find(node => node.is('Link'))?.id
      const urlType = ctx.parser.nodeSet.types.find(node => node.is('URL'))?.id
      linkContents = linkContents.filter(el => el.type !== linkType && el.type !== urlType)
    }

    // The url may contain additional parenthesis, so we need
    // to count the internal ones to track potential matching pairs
    // to find the external matching closing one.
    let depth = 0
    let stop = 0
    let url = match.groups.url
    let linkEnd = pos + 1

    while (stop <= url.length) {
      const char = url.charAt(stop)

      // Found the closing parenthesis
      if (char === ')' && depth === 0) { break }

      if (char === ')') { depth-- }
      if (char === '(') { depth++ }
      stop++
    }

    url = url.substring(0, stop)

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

    // Closing marks (2) + url text
    linkEnd += 2 + url.length

    const openingMark = ctx.elt('LinkMark', delim.from, delim.to)
    const closingMark = ctx.elt('LinkMark', pos, pos + 1)

    // This child node structure mirrors the codemirror Link structure
    const children = [ openingMark, ...linkContents, closingMark, openingUrlMark, ...urlContents, closingUrlMark ]

    return ctx.addElement(ctx.elt(isLink ? 'Link' : 'Image', delim.from, linkEnd, children))
  }
}
