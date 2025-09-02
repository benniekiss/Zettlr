/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Table of Contents field
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This state field keeps an updated table of contents for
 *                  Markdown documents.
 *
 * END HEADER
 */

import { StateField, MapMode } from '@codemirror/state'
import { markdownToAST, extractASTNodes } from '@common/modules/markdown-utils'
import { type ASTNode } from '../../markdown-utils/markdown-ast'
/**
 * Takes a heading (the full line) and transforms it into an ID. This function
 * will first look for a Pandoc-style ID ({#heading-id}), then for a named
 * anchor (<a name="heading-id"></a>), and if both fail, transform the text into
 * an ID utilizing the Pandoc algorithm.
 *
 * @param   {string}  headingString  The heading string to generate an ID for
 *
 * @return  {string}                 The generated ID
 */
function headingToID (headingString: string): string {
  // If there are Pandoc attributes inside this header, and they include an ID,
  // then we should use that one.
  const pandocAttrs = /\{(.+)\}$/.exec(headingString)
  if (pandocAttrs !== null) {
    const attrs = pandocAttrs[1].split(' ').map(x => x.trim()).filter(x => x !== '')
    const id = attrs.find(x => x.startsWith('#'))
    if (id !== undefined) {
      return id.substring(1)
    }
  }

  // A named anchor is also a valid heading ID, so if there is one, return that.
  const namedAnchor = /<a(?:.+)name=['"]?([^'"]+)['"]?(?:.*)>(?:.*)<\/a>/i.exec(headingString)
  if (namedAnchor !== null) {
    return namedAnchor[1]
  }

  // If both of these "explicit" overriding methods work, transform what's left
  // of the content into an ID utilizing Pandoc's algorithm.

  let text = headingString
  // Remove HTML elements
  text = text.replace(/<.+>/i, '')
  // Remove all formatting, links, etc.
  text = text.replace(/[*_]{1,3}(.+)[*_]{1,3}/g, '$1')
  text = text.replace(/`[^`]+`/g, '$1')
  text = text.replace(/\[.+\]\(.+\)/g, '')
  // Remove all footnotes.
  text = text.replace(/\[\^.+\]/g, '')
  // Replace all spaces and newlines with hyphens.
  text = text.replace(/[\s\n]/g, '-')
  // Remove all non-alphanumeric characters, except underscores, hyphens, and periods.
  text = text.replace(/[^a-zA-Z0-9_.-]/g, '')
  // Convert all alphabetic characters to lowercase.
  text = text.toLowerCase()
  // Remove everything up to the first letter (identifiers may not begin with a number or punctuation mark).
  const letterMatch = /[a-z]/.exec(text)
  const firstLetter = (letterMatch !== null) ? letterMatch.index : 0
  text = text.substring(firstLetter)
  // If nothing is left after this, use the identifier section.
  if (text.length === 0) {
    text = 'section'
  }

  return text
}

export interface ToCEntry {
  /**
   * The one-indexed line number of the heading
   */
  line: number
  /**
   * The character where the entry begins
   */
  pos: number
  /**
   * The text contents of the heading (without the heading formatting)
   */
  text: string
  /**
   * The level of the heading (1-6)
   */
  level: number
  /**
   * A human-readable title numbering (e.g. 1.2, 2.5.1)
   */
  renderedLevel: string
  /**
   * An ID used to link to this heading
   */
  id: string
}

/**
 * This function generates a rendering level for a list of Table of Contents
 *
 * @param   {ToCEntry[]}  headings  A list of headings
 *
 * @return  {ToCEntry[]}          The ToC
 */
function generateToc (headings: ToCEntry[]): ToCEntry[] {
  let h1 = 0
  let h2 = 0
  let h3 = 0
  let h4 = 0
  let h5 = 0
  let h6 = 0

  for (const entry of headings) {
    switch (entry.level) {
      case 1: {
        h1++
        h2 = h3 = h4 = h5 = h6 = 0
        entry.renderedLevel = [h1].join('.')
        break
      }
      case 2: {
        h2++
        h3 = h4 = h5 = h6 = 0
        entry.renderedLevel = [ h1, h2 ].join('.')
        break
      }
      case 3: {
        h3++
        h4 = h5 = h6 = 0
        entry.renderedLevel = [ h1, h2, h3 ].join('.')
        break
      }
      case 4: {
        h4++
        h5 = h6 = 0
        entry.renderedLevel = [ h1, h2, h3, h4 ].join('.')
        break
      }
      case 5: {
        h5++
        h6 = 0
        entry.renderedLevel = [ h1, h2, h3, h4, h5 ].join('.')
        break
      }
      case 6: {
        h6++
        entry.renderedLevel = [ h1, h2, h3, h4, h5, h6 ].join('.')
        break
      }
      default:
        break
    }
  }

  return headings
}

export const tocField = StateField.define<ToCEntry[]>({
  create (state) {
    const tocEntries: ToCEntry[] = []

    const ast = markdownToAST(state.doc.toString())
    const headings: ASTNode[] = extractASTNodes(ast, 'Heading')

    for (const node of headings) {
      if (node.type === 'Heading') {
        const nodeLine = state.doc.lineAt(node.from)
        tocEntries.push({
          line: nodeLine.number,
          pos: node.from,
          text: nodeLine.text,
          level: node.level,
          renderedLevel: '',
          id: headingToID(nodeLine.text)
        })
      }
    }

    return generateToc(tocEntries)
  },

  update (value, transaction) {
    if (!transaction.docChanged) {
      return value
    }

    // map old headings to new positions
    const tocEntries: ToCEntry[] = []
    for (const entry of value) {
      // we track the changes and associate with the characters after the position
      // to cleanup any headings that may have been deleted in the transaction.
      const newPos = transaction.changes.desc.mapPos(entry.pos, 1,  MapMode.TrackAfter)
      if (newPos !== null) {
        const newLine = transaction.newDoc.lineAt(newPos)
        const text = newLine.text
        // finally, make sure the line is still a heading
        const ast = markdownToAST(text)
        const headings: ASTNode[] = extractASTNodes(ast, 'Heading')
        if (headings.length !== 0) {
          entry.line = newLine.number
          entry.pos = newPos
          entry.text = text
          tocEntries.push({
            ...entry,
            line: newLine.number,
            pos: newLine.from,
            text: text
          })
        }
      }
    }

    // Iterate over the changes and push any new headings into the list
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      const lineBefore = Math.min(transaction.newDoc.lineAt(fromB).number - 1, 1)
      const from = transaction.newDoc.line(lineBefore).from
      const to = transaction.newDoc.lineAt(toB).to
      const text = transaction.newDoc.sliceString(from, to)

      const ast = markdownToAST(text)
      const headings: ASTNode[] = extractASTNodes(ast, 'Heading')

      for (const node of headings) {
        if (node.type === 'Heading') {
          const nodeLine = transaction.newDoc.lineAt(node.from)
          tocEntries.push({
            line: nodeLine.number,
            pos: nodeLine.from,
            text: nodeLine.text,
            level: node.level,
            renderedLevel: '',
            id: headingToID(nodeLine.text)
          })
        }
      }
    })
    // sort the list
    tocEntries.sort((a, b) => a.line - b.line)
    // filter out duplicate entries where
    // later entries override earlier ones.
    const sortedToC = Array.from(
      new Map(tocEntries.map(obj => [ obj.line, obj ])).values()
    )

    return generateToc(sortedToC)
  }
})
