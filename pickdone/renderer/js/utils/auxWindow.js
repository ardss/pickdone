/** Review P3 (2026-09-22): centralized aux-window detection. The same hash regex was hand-copied in
 *  todoBackup.js, habits.js and settings.js (settings negated) — a new aux route (or a hash rename)
 *  would have needed three synchronized edits. Every aux-window check goes through this helper. */
export function isAuxWindow () {
  try {
    return !!(typeof window !== 'undefined' && window.location && window.location.hash && /__tomato-float|__quick-add/.test(window.location.hash))
  } catch { return false } // non-browser env
}

/** Float-window-only check (route #__tomato-float). main.js used to hand-copy this regex twice
 *  (isMainShell / isFloatShell), one copy drifted to miss __quick-add — route through the helpers. */
export function isFloatWindow () {
  try {
    return !!(typeof window !== 'undefined' && window.location && window.location.hash && /__tomato-float/.test(window.location.hash))
  } catch { return false }
}
