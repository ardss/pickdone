/**
 * Shared sort-score core (P3-7, dw wave): single source for nextSort — previously the CLI kept a
 * verbatim copy (nextSortCli) of the renderer's utils/core.js nextSort. Both ends compute the same
 * ±512 step / 1024 baseline convention; pure function, no dependencies.
 *
 * Sort score (fround precision aligned with project baseline).
 *  custom mode displays by taskSort descending: addToTop = above the max; appending to the bottom must go below the min (minS-512).
 */
export function nextSort (addToTop, minS, maxS) {
  let s
  if (!minS && !maxS) s = 1024 // first element of the list, arbitrary baseline
  else if (addToTop) s = maxS + 512
  else s = minS - 512
  return Math.fround(s)
}

/* ================= F-B2 (dw wave 3): manual-reorder scale, single source =================
 * Two reorder idioms previously existed as private twins with overlapping scales — the renderer's
 * TodoItem._writeSort (whole-table 9999→-9999 linear rewrite on drag / Ctrl+Up/Down) and the CLI's
 * sortTask (±100 margin + midpoint insertion). Both now call these pure functions so the two
 * scales are defined once; store/todo.js's ±64 add-jitter stays renderer-side (domain 3).
 */

/** Linear rewrite scale for a whole ordered list: index 0 (top) gets +top, the last index -top.
 *  Exact same arithmetic as the previous TodoItem._writeSort inline (step = 2*top/len). */
export function reorderScale (n, top = 9999) {
  const step = (top * 2) / Math.max(1, n)
  return Array.from({ length: n }, (_, i) => Math.fround(top - i * step))
}

/**
 * Midpoint/neighbor sort for moving one row within an ordered list. B2 (2026-09-24) direction
 * fix: `sorts` is in APP DISPLAY order — taskSort DESCENDING, exactly the order the App's
 * sortMode.js custom mode renders (`b.taskSort - a.taskSort`). `idx` is the mover's display
 * index, `refIdx` the reference index for before|after (also display order: 'before' = above
 * on screen). Previously the contract said "ascending", so the CLI's `sort top` produced
 * min-100 — the visually BOTTOM row (P1 cross-end inversion, daily 0924).
 * Returns { sort } with the new score, or { edge: true } when an up/down move would leave the
 * list (caller decides the user-facing error). Same ±100 fixed-margin convention the CLI
 * sortTask used inline — precision degrades only when no beyond-row exists, order never flips.
 */
export function moveWithin (sorts, idx, pos, refIdx = -1) {
  const at = i => (sorts[i] == null ? 0 : sorts[i])
  const mid = (a, b) => Math.fround((a + b) / 2)
  // Display order is descending, so "above on screen" = a LARGER taskSort: top over-flows +100
  // past the current max, bottom under-flows -100 past the current min.
  if (pos === 'top') return { sort: sorts.length ? at(0) + 100 : 100 }
  if (pos === 'bottom') return { sort: sorts.length ? at(sorts.length - 1) - 100 : -100 }
  if (pos === 'up' || pos === 'down') {
    const ni = pos === 'up' ? idx - 1 : idx + 1
    if (ni < 0 || ni >= sorts.length) return { edge: true }
    const bi = pos === 'up' ? idx - 2 : idx + 2
    const beyond = bi >= 0 && bi < sorts.length
    return { sort: beyond ? mid(at(ni), at(bi)) : at(ni) + (pos === 'up' ? 100 : -100) }
  }
  if (pos === 'before' || pos === 'after') {
    if (refIdx < 0 || refIdx >= sorts.length) return { edge: true }
    if (pos === 'before') {
      const bi = refIdx - 1
      return { sort: bi >= 0 ? mid(at(bi), at(refIdx)) : at(refIdx) + 100 }
    }
    const bi = refIdx + 1
    return { sort: bi < sorts.length ? mid(at(refIdx), at(bi)) : at(refIdx) - 100 }
  }
  return { edge: true }
}
