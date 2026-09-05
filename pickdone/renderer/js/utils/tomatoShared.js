/**
 * Tomato timer shared pure logic — independent of window/store; the main window and float window share one implementation for completion decisions.
 * Idempotency trio: remainSecOf (countdown) / phaseToken (phase identity token) / dedupeById (record dedupe).
 * When multiple windows concurrently trigger the same completion transition: the token blocks side effects (notification/audio/snow gain), and a deterministic tomatoId + dedupe block duplicate accounting.
 */

/** Remaining seconds; returns null when not running or startedAt is missing (not part of the countdown) */
export function remainSecOf (status, startedAt, tomatoTime, restTime, now = Date.now()) {
  if ((status !== 'startTomatoTime' && status !== 'startRestTime') || !startedAt) return null
  const total = (status === 'startRestTime' ? (restTime || 5) : (tomatoTime || 25)) * 60
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000)) // clamp to 0 first: flooring a negative fraction gives -1, which would silently add 1 second (right after clicking, the display-layer ts may be earlier than startedAt)
  return Math.max(0, total - elapsed)
}

/** Phase identity token: unique identifier for one "entering a running state" (startedAt changes after resume/giveUp, i.e. a new identity) */
export function phaseToken (status, startedAt) {
  return `${status}:${startedAt}`
}

/** Dedupe by tomatoId (keep the first; records without an id are kept as-is) */
export function dedupeById (list) {
  const seen = new Set()
  const out = []
  for (const r of list || []) {
    const id = r && r.tomatoId
    if (id) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(r)
  }
  return out
}

/** Countdown display mm:ss (seconds floored, negatives treated as 0) — previously inlined separately in TomatoBar/TomatoPanel/TomatoFloatPage,
 *  where fixing one missed the other two; import uniformly from here.
 *  The main process (tomato-taskbar.js, CJS) can't import ESM, so an equivalent inline copy remains there and must be kept in sync when changed. */
export function formatMMSS (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
