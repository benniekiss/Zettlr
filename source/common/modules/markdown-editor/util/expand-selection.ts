import { type EditorView } from '@codemirror/view'

export function getWordPosition (view: EditorView, from: number, to: number): { from: number, to: number } {
  const fromWord = view.state.wordAt(from)
  const toWord = view.state.wordAt(to)

  const newFrom: number = fromWord ? fromWord.from : from
  const newTo: number = toWord ? toWord.to : to

  return { from: newFrom, to: newTo }
}

export function getSurroundingLinePosition (view: EditorView, from: number, to: number, context: number = 0): { from: number, to: number } {
  const totalLines = view.state.doc.lines
  let fromLine = Math.max(1, view.state.doc.lineAt(from).number - context)
  let toLine = Math.min(totalLines, view.state.doc.lineAt(to).number + context)

  // we expand the context to the top of the previous block
  let prevBlock: boolean = false
  let currentBlock: boolean = true

  while (fromLine > 1) {
    if (view.state.doc.line(fromLine - 1).text.trim() === '') {
      // we hit a newline, so we are no longer in the starting block
      currentBlock = false
      // we hit the top of the previous block
      if (prevBlock) {
        break
      }
    // if we aren't in the current block and hit text,
    // it means we are now in the previous block
    } else if (!currentBlock) {
      prevBlock = true
    }
    fromLine--
  }

  // we expand the context to the bottom of the next block
  let nextBlock: boolean = false
  currentBlock = true

  while (toLine < totalLines) {
    if (view.state.doc.line(toLine + 1).text.trim() === '') {
      // we hit a newline, so we are no longer in the starting block
      currentBlock = false
      // we hit the bottom of the next block
      if (nextBlock) {
        break
      }
    // if we aren't in the current block and hit text,
    // it means we are now in the next block
    } else if (!currentBlock) {
      nextBlock = true
    }
    toLine++
  }

  const newFrom = view.state.doc.line(fromLine).from
  const newTo = view.state.doc.line(toLine).to

  return { from: newFrom, to: newTo }
}

export function mergeRangesInPlace (ranges: { from: number, to: number }[]): void {
  if (ranges.length <= 1) {
    return
  }

  ranges.sort((a, b) => a.from - b.from)

  let writeIndex = 0 // last merged index

  for (let readIndex = 1; readIndex < ranges.length; readIndex++) {
    const current = ranges[writeIndex]
    const next = ranges[readIndex]

    if (next.from <= current.to + 1) {
      // merge into current
      current.to = Math.max(current.to, next.to)
    } else {
      // move next up to the next slot
      writeIndex++
      ranges[writeIndex] = next
    }
  }

  // cut off the leftovers
  ranges.length = writeIndex + 1
}
