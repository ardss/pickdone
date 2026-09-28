/**
 * Viewport clamping for the page-root hover tips (pure, moved verbatim from
 * StatisticsView.vue methods). Each helper takes the tip state + the rendered
 * tip element and returns the position patch to apply, or null when unchanged.
 */

/** Timeline following tooltip: defaults to the mouse's upper right (CSS transform offset), then clamped by measured size after render to prevent overflow —
 *  near the right edge it flips horizontally to the mouse's left; if that goes past the top edge it flips below the mouse (user feedback: popovers overflowed at screen edges) */
export function clampTipPos (t, el, stateKey) {
  const w = el.offsetWidth, h = el.offsetHeight, pad = 8, vw = window.innerWidth, vh = window.innerHeight
  let px, py
  if (stateKey === 'tlTip') {
    px = t.x + 12; py = t.y - h - 10                       // default: upper right
    if (px + w + pad > vw) px = Math.max(pad, t.x - w - 12) // near right edge -> flip left
    if (py < pad) py = Math.min(t.y + 16, vh - h - pad)     // near top edge -> flip below
    if (py + h + pad > vh) py = vh - h - pad
  } else {
    px = Math.min(Math.max(t.x, w / 2 + pad), vw - w / 2 - pad) // centered above the cell, clamped horizontally into the viewport
    py = t.y
  }
  if (px !== t.px || py !== t.py) return { px, py }
  return null
}

/** Heatmap tooltip: centered above the cell, clamped horizontally; a cell close to the
 *  screen top flips below the cell (clampHmTip switch, styled via .hm-tip--below) */
export function clampHmTipPos (t, el) {
  const w = el.offsetWidth, h = el.offsetHeight, pad = 8
  const px = Math.min(Math.max(t.x, w / 2 + pad), window.innerWidth - w / 2 - pad)
  const below = t.y - h - 10 < pad            // cell close to screen top -> flip below the cell
  const py = below ? t.y + (t.ch || 0) + 8 : t.y
  if (px !== t.px || below !== t.below || py !== t.py) return { px, py, below }
  return null
}
