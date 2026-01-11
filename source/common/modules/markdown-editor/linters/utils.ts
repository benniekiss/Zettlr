/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Linter Utilities
 * CVM-Role:        Linter
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     These utilites are used to prepare text ranges
 *                  and filter diagnostics for linting.
 *
 * END HEADER
 */
import {
  StateField,
  StateEffect,
  ChangeSet,
  type StateEffectType,
  type Transaction,
  type ChangeDesc,
  type EditorState
} from '@codemirror/state'
import { forEachDiagnostic, linter, type Diagnostic } from '@codemirror/lint'
import { ensureSyntaxTree } from '@codemirror/language'
import type { Tree, TreeCursor } from '@lezer/common'
import type { ViewUpdate } from '@codemirror/view'

type LintRange = { from: number, to: number }

/**
 * This function moves a cursor to the next node, and if `filter`
 * is provided, it will move it to the next node matching one in `filter`.
 *
 * @param   {TreeCursor}   cursor  The TreeCursor
 * @param   {Set<string>}  filter  A set of strings with node names
 *
 * @return  {boolean}              Whether the node was moved successfully.
 */
function filterCursor (cursor: TreeCursor, direction: -1 | 1, filter?: Set<string>): boolean {
  const moveCursor = direction === -1 ? cursor.prev.bind(cursor) : cursor.next.bind(cursor)

  while (filter && !filter.has(cursor.name)) {
    if (!moveCursor(false)) { return false }
  }

  return true
}

/**
 * This function takes a range and expands it to the nearest
 * node boundary before `from` and after `to`
 *
 * @param   {EditorState} state    The Editor State
 * @param   {number}      from     The beginning of the selection
 * @param   {number}      to       The end of the selection
 * @param   {number}      context  Expand the selection by `context`
 *                                 number of nodes before `from` and after `to`
 * @param   {Set<string>} [filter] Optional. A set of strings to filter nodes by.
 * @param   {Tree}        [tree]   Optional. A pre-computed Tree object.
 *
 * @return  {LintRange[}                The selection expanded to the nearest node boundaries
 */
function getNodePosition (state: EditorState, from: number, to: number, context: number = 0, filter?: Set<string>, tree?: Tree | null): LintRange {
  tree = tree ?? ensureSyntaxTree(state, state.doc.length, 1000)

  // if we don't have the tree, bail out with the whole document.
  if (!tree) {
    return { from: 0, to: state.doc.length }
  }

  const cursorA: TreeCursor = tree.topNode.cursor()
  if (!cursorA.childBefore(from)) {
    cursorA.firstChild()
  }
  filterCursor(cursorA, -1, filter)

  const cursorB: TreeCursor = tree.topNode.cursor()
  if (!cursorB.childAfter(to)) {
    cursorB.lastChild()
  }
  filterCursor(cursorB, 1, filter)

  while (context-- > 0) {
    const hasPrev = cursorA.prev(false)
    const hasNext = cursorB.next(false)
    // if we are at the end in both directions, fail early
    if (!hasPrev && !hasNext) { break }

    filterCursor(cursorA, -1, filter)
    filterCursor(cursorB, 1, filter)
  }

  return { from: cursorA.from, to: cursorB.to }
}

/**
 * Test whether a range overlaps any range in a list of ranges.
 *
 * @param   {LintRange[}    r       The range to test
 * @param   {LintRange[]}  ranges  A list of ranges to test against
 *
 * @return  {boolean}          Whether the range overlaps any range in ranges.
 */
function rangesOverlap (r: LintRange, ranges: LintRange[]): boolean {
  return ranges.some(range => {
    // zero-width range
    if (r.from === r.to) {
      // only count as overlap if range actually contains the point r.from
      return r.from < range.to && r.to > range.from
    }
    return !(r.to < range.from || r.from > range.to)
  })
}

/**
 * Merge overlapping ranges in a list of ranges
 *
 * @param   {LintRange[]}  ranges  A list of { from, to } ranges.
 *
 * @return  {LintRange[]}          A new list of merged ranges.
 */
function mergeRanges (ranges: LintRange[]): LintRange[] {
  if (ranges.length <= 1) {
    return [...ranges]
  }

  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  const merged: LintRange[] = [{ ...sorted[0] }]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const next = sorted[i]

    if (next.from <= prev.to + 1) {
      prev.to = Math.max(prev.to, next.to)
    } else {
      merged.push({ ...next })
    }
  }

  return merged
}

export const TEXTNODE_FILTER = new Set([
  'Paragraph',
  'Blockquote'
])

/**
 * This factory function returns a StateEffect and Statefield to control linting contexts.
 *
 * @return  {{ effect: StateEffectType<{ from: number, to?: number }|null>, field: StateField<ChangeDesc> }}
 */
export function changesFieldEffectFactory (): { effect: StateEffectType<{ from: number, to?: number }|null>, field: StateField<ChangeDesc> } {
  const setChangesEffect = StateEffect.define<{ from: number, to?: number }|null>()

  const lintChangesField = StateField.define<ChangeDesc>({
    // create a ChangeSet that covers the entire document so that
    // the entire document is linted on startup.
    create: (state) => ChangeSet.of({ from: 0, to: state.doc.length, insert: state.doc.toString() }, state.doc.length).desc,
    update (value, transaction: Transaction) {
      let changes = transaction.changes.desc

      for (let e of transaction.effects) {
        if (e.is(setChangesEffect)) {
          if (e.value === null) {
            return ChangeSet.empty(transaction.newDoc.length).desc
          }

          changes = changes.composeDesc(ChangeSet.of({
            from: e.value.from,
            to: e.value.to,
            insert: transaction.newDoc.sliceString(e.value.from, e.value.to)
          }, transaction.newDoc.length).desc)
        }
      }

      if (transaction.changes.empty) {
        return value
      }

      return value.composeDesc(changes)
    }
  })

  return { effect: setChangesEffect, field: lintChangesField }
}

/**
 * Prepare ranges and diagnostics for linting.
 *
 * @param   {EditorView}              view          The codemirror editor view
 * @param   {StateField<ChangeDesc>}  field         A `StateField` which returns a `ChangeDesc`
 * @param   {string}                  [source]      Optional. A diagnostic source to filter
 * @param   {ContextCallbacks}        [callback]    Optional. A callback which expands the range
 * @param   {number}                  [context]     Optional. Passed to `callback` to set how
 *                                                  much to expand the range by
 *
 * @return  {{ ranges: LintRange[], diagnostics: Diagnostic[] }}  The new ranges to lint and the remaining valid diagnostics
 */
export function prepareDiagnostics (
  state: EditorState,
  field: StateField<ChangeDesc>,
  source?: string,
  context?: number,
  filter?: Set<string>,
): { ranges: LintRange[], diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  let ranges: LintRange[] = []

  const changes = state.field(field)

  changes.iterChangedRanges((_, __, fromB, toB) => {
    // we expand the context to ensure a better lint
    const { from, to } = getNodePosition(state, fromB, toB, context, filter)
    ranges.push({ from, to })
  })

  // `forEachDiagnostic` tracks the new position of the diagnostic, so
  // we can just push the diagnostic with the updated `from` and `to`.
  forEachDiagnostic(state, (d, from, to) => {
    // if `source` was provided, filter the diagnostics
    // which match, otherwise, run over all diagnostics.
    const isFiltered = source !== undefined ? d.source?.includes(source) ?? false : true

    if (isFiltered) {
      if (!rangesOverlap({ from, to }, ranges)) {
        diagnostics.push({ ...d, from, to })
      } else {
        // since the changed ranges overlap with the diagnostic
        // we need to expand the context to include the entire diagnostic
        // to ensure we lint correctly, and we need to ensure that the
        // range is on a node-boundary
        ranges.push(getNodePosition(state, from, to, 0, filter))
      }
    }
  })

  // sort the ranges and merge any overlapping regions
  ranges = mergeRanges(ranges)

  return { ranges, diagnostics }
}

export const hideLinterToolTipEffect = StateEffect.define<boolean>()
export const refreshLinterEffect = StateEffect.define<boolean>()

function hideOn (tr: Transaction): boolean | null {
  for (const e of tr.effects) {
    if (e.is(hideLinterToolTipEffect)) {
      if (e.value) {
        return true
      }
    }
  }

  return null
}

function needsRefresh (update: ViewUpdate): boolean {
  for (const tr of update.transactions) {
    for (const e of tr.effects) {
      if (e.is(refreshLinterEffect)) {
        if (e.value) {
          return true
        }
      }
    }
  }

  return false
}

export const linterConfig =  linter(null, {
  delay: 1000,
  hideOn,
  needsRefresh
})
