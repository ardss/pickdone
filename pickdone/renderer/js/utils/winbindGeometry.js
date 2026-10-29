/**
 * Window-binding geometry gate (win-bind feature, T8 renderer side).
 *
 * Decides whether a native-HTML5-dnd `dragend` release happened OUTSIDE the app
 * window (= window-binding intent) or inside it (= plain reorder semantics,
 * original behavior). It is the ONLY branch condition TodoItem.onDragEnd adds;
 * the predicate is pure so it stays unit-testable and DIP-free.
 *
 * Coordinate-space contract: event.screenX/Y and window.screenX/outerWidth/
 * outerHeight live in the SAME CSS-pixel screen space (multi-monitor negative
 * coordinates included) — no getCursorScreenPoint DIP conversion is involved
 * (that class of bug is documented at src/main/tomato-float.js' cursor path).
 *
 * Fail-closed: missing/non-finite inputs never report "outside" — an accidental
 * bind is worse than a missed one (Esc cancel paths rely on this).
 */

/** true when the release point lies outside the window's outer bounds (edges inclusive = inside). */
export function isReleaseOutsideViewport (pt, win) {
  if (!pt || !win) return false
  const px = Number(pt.screenX)
  const py = Number(pt.screenY)
  const wx = Number(win.screenX)
  const wy = Number(win.screenY)
  const ww = Number(win.outerWidth)
  const wh = Number(win.outerHeight)
  // Number.isFinite rejects NaN/Infinity/undefined in one shot (fail-closed)
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(wx) ||
      !Number.isFinite(wy) || !Number.isFinite(ww) || !Number.isFinite(wh)) return false
  return !(px >= wx && px <= wx + ww && py >= wy && py <= wy + wh)
}

/** [QA r1 #3] true when the native drag COMPLETED (mouse release), false when it was CANCELLED
 *  (Esc). Measured on Electron 39/Chromium 142 with real SendInput drags (live probe,
 *  2026-10-29): dragend.dropEffect === 'move' on an outside release (the completion reports the
 *  source's effectAllowed, set to 'move' in TodoItem.onDragStart), and === 'none' on Esc-cancel
 *  (HTML dnd spec: a cancelled drag forces dropEffect 'none' at dragend). The event's
 *  buttons/button fields are USELESS here — Chromium synthesizes dragend with buttons=0 in BOTH
 *  cases, so this is the only deterministic renderer-side discriminator. It closes the Esc
 *  mis-bind race that the main process's GetAsyncKeyState check cannot (the identify PS
 *  roundtrip samples the button ~50-100ms after dragend — later than a fast Esc→release).
 *  Fail-closed: a release a foreign app accepts as 'copy'/'link' also returns false (a missed
 *  bind is better than an accidental one — same doctrine as isReleaseOutsideViewport). */
export function isCompletedDragRelease (e) {
  return !!(e && e.dataTransfer && e.dataTransfer.dropEffect === 'move')
}
