/**
 * EditPanel interaction helpers (2026-09-25 P2) — small pure-ish units extracted so the
 * behavior test can drive them without mounting the SFC.
 */

/** v-click-outside handler for the category dropdown pop. The directive is a capture-phase
 *  document mousedown; clicking the header row while the pop is OPEN used to close the pop on
 *  mousedown and the header's own click handler then toggled it straight back open — the pop
 *  could never be dismissed via its header. Header-originated outside clicks are ignored here
 *  so the header click handler owns the toggle exclusively. */
export function catOutsideClose (ctx, e) {
  const row = ctx.$el && ctx.$el.querySelector('.ep-cat-row')
  if (row && row.contains && row.contains(e.target)) return
  ctx.catOpen = false
}
