/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Statistics Field
 * CVM-Role:        Extension
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file defines a set of StateFields that are used to keep
 *                  a few statistics such as word counts available to the
 *                  overlying MarkdownEditor instance.
 *
 * END HEADER
 */

import { StateField, type EditorState } from '@codemirror/state'
import { markdownToAST } from '@common/modules/markdown-utils'
import { countAll } from '@common/util/counter'

export const countField = StateField.define<{ chars: number, words: number }>({
  create (state: EditorState) {
    const ast = markdownToAST(state.doc.toString())
    return countAll(ast)
  },

  update (value, transaction) {
    // If someone provided the markClean effect, we'll exchange the saved doc
    // so that, when comparing documents with cleanDoc.eq(state.doc), it will
    // return true.
    if (!transaction.docChanged) {
      return value
    }

    let { words, chars } = value

    transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
      const processSegment = (state: EditorState, from: number, to: number, sign: 1 | -1) => {
        const startWord = state.wordAt(from)
        const endWord = state.wordAt(to)

        let start
        let end

        if (startWord === null) {
          start = from
        } else {
          start = startWord.from
        }

        if (endWord === null) {
          end = to
        } else {
          end = endWord.to
        }

        const text = state.doc.sliceString(start, end)
        let counts = countAll(markdownToAST(text))

        // we have to account for single character words.
        if (counts.words === 0 && /^\p{L}$|^\p{N}$/u.test(text.trim())) {
          counts = { words: 1, chars: 1 }
        }

        words += sign * counts.words
        chars += sign * counts.chars
      }

      processSegment(transaction.startState, fromA, toA, -1)
      processSegment(transaction.state, fromB, toB, +1)
    })

    return { words, chars }
  },

  compare (a, b): boolean {
    return a.chars === b.chars && a.words === b.words
  }
})
