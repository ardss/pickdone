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

/** [QA r1 #3] true when the native drag was ACCEPTED by the release-point target
 *  (dragend.dropEffect === 'move' — the completion reports the source's effectAllowed, set to
 *  'move' in TodoItem.onDragStart). Measured on Electron 39/Chromium 142 with real SendInput
 *  drags (live probe, 2026-10-29): === 'none' on Esc-cancel (HTML dnd spec: a cancelled drag
 *  forces dropEffect 'none' at dragend). The event's buttons/button fields are USELESS here —
 *  Chromium synthesizes dragend with buttons=0 in BOTH cases, so dropEffect is the only
 *  deterministic renderer-side discriminator for the ACCEPTED case.
 *
 *  IMPORTANT (QA r1-P1 correction): 'move' is NOT the only completed release. dropEffect is
 *  NEGOTIATED WITH the OLE drop target under the cursor, so a REAL release onto a target that
 *  refuses text/move (mspaint etc.) also reports 'none' — same value as an Esc cancel. That
 *  case is isRejectedDropRelease below; the two 'none' flavours are split by the Escape-key
 *  signal recorded in TodoItem (live probe 2026-10-29: Esc-cancel delivers Escape
 *  keydown/keyup to the drag-source DOM ~12ms AFTER dragend; a rejected release delivers no
 *  key events at all), not by anything in this event object.
 *  Fail-closed: a release a foreign app accepts as 'copy'/'link' returns false (a missed bind
 *  is better than an accidental one — same doctrine as isReleaseOutsideViewport). */
export function isCompletedDragRelease (e) {
  return !!(e && e.dataTransfer && e.dataTransfer.dropEffect === 'move')
}

/** [QA r1-P1] true when the drag ended with dropEffect 'none' — the release-point OLE target
 *  REFUSED the text/move offer (measured live: real drag onto mspaint's client area → 'none',
 *  onto notepad → 'move'), or the drag landed where there is no target, or it was Esc-cancelled.
 *  This predicate deliberately does NOT decide "completed vs cancelled": that split needs the
 *  Escape-key evidence from TodoItem's module-level key tracker plus the main process's
 *  buttonDown probe (BUTTON_DOWN still catches an Esc-cancel while the button is held). Only
 *  after BOTH say "not cancelled" may the caller treat this as a completed release and bind. */
export function isRejectedDropRelease (e) {
  return !!(e && e.dataTransfer && e.dataTransfer.dropEffect === 'none')
}
