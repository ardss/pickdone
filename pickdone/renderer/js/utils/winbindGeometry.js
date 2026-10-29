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
