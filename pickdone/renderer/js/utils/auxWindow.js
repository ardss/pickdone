/** Review P3 (2026-09-22): centralized aux-window detection. The same hash regex was hand-copied in
 *  todoBackup.js, habits.js and settings.js (settings negated) — a new aux route (or a hash rename)
 *  would have needed three synchronized edits. Every aux-window check goes through this helper. */
export function isAuxWindow () {
  try {
    return !!(typeof window !== 'undefined' && window.location && window.location.hash && /__tomato-float|__quick-add/.test(window.location.hash))
  } catch { return false } // non-browser env
}
