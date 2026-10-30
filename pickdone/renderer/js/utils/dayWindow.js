/**
 * DayDeck window helpers. Pure so they are unit-testable without mounting the component.
 * [A3] clampToDayWindow — the old ±7-day edge clamp.
 * [w16-deck 2026-10-28] window builders/bucketing: base window today ±30 days, extendable to
 * cover an out-of-window selection (capped), single-pass bucketing with consumer-side
 * dayStart() normalization (todayBounds.js) and a capped today-card overdue zone.
 */
import { dayStart, dayShift } from './todayBounds.js'

export const DECK_SPAN_DAYS = 30 // base window: ±30 days around today
export const DECK_MAX_HORIZON_DAYS = 180 // extension cap (per side): keeps the card array bounded
export const DECK_OVERDUE_CAP = 5 // overdue rows shown on the today card before the +N badge

/**
 * Clamp a timestamp to a member of a sorted ascending day-timestamp window.
 * - an exact member passes through (the usual strip click);
 * - a ts inside the window's span but not an exact member snaps to the NEAREST member (also
 *   absorbs the ±1h drift a fixed 86400000ms window accumulates across a DST transition);
 * - a ts BEFORE the window clamps to the first day, AFTER clamps to the last day;
 * - an empty window returns the input unchanged.
 *
 * [w16-deck] role narrowed: with the window now EXTENDING to cover the user's selection this is
 * only the beyond-horizon fallback (front the nearest cap edge) — it must never feed a store
 * write-back.
 *
 * @param {number[]} days sorted ascending start-of-day timestamps
 * @param {number} ts candidate timestamp
 * @returns {number} a timestamp guaranteed to be a member of `days` (unless days is empty)
 */
export function clampToDayWindow (days, ts) {
  if (!Array.isArray(days) || !days.length) return ts
  const n = Number(ts) || 0
  if (days.includes(n)) return n
  if (n <= days[0]) return days[0]
  const last = days[days.length - 1]
  if (n >= last) return last
  let best = days[0]
  for (const d of days) if (Math.abs(d - n) < Math.abs(best - n)) best = d
  return best
}

/**
 * [w16-deck] The card window: today ±DECK_SPAN_DAYS, extended to cover `selTs` when the user
 * picked a day outside it (up to DECK_MAX_HORIZON_DAYS per side; beyond the cap the window
 * stops at the cap edge and the caller fronts that edge WITHOUT rewriting the selection).
 * Steps via dayShift (calendar days) so DST 23h/25h midnights stay exact members.
 *
 * @param {number} today0 local midnight of today
 * @param {number} selTs raw store selection (0 = none) — normalized here via dayStart()
 * @returns {number[]} sorted ascending local-midnight timestamps
 */
export function deckWindowDays (today0, selTs) {
  const t0 = dayStart(today0)
  const min0 = dayShift(t0, -DECK_SPAN_DAYS)
  const max0 = dayShift(t0, DECK_SPAN_DAYS)
  const sel = selTs ? dayStart(selTs) : 0
  const min = sel && sel < min0 ? Math.max(sel, dayShift(t0, -DECK_MAX_HORIZON_DAYS)) : min0
  const max = sel && sel > max0 ? Math.min(sel, dayShift(t0, DECK_MAX_HORIZON_DAYS)) : max0
  const out = []
  for (let ts = min; ts <= max; ts = dayShift(ts, 1)) out.push(ts)
  return out
}

/**
 * [w16-deck] Single-pass bucketing (one walk over `list`, not a filter per card — the window
 * grew from 15 to 61+ cards and per-card filters would be O(days x tasks)):
 * - a row belongs to the card of its dayStart()-NORMALIZED local midnight (fixes the drift
 *   amplifier: cross-timezone synced rows with non-midnight/ISO-string dayStart used to
 *   strict-equality-match no card and fall into the today overdue zone);
 * - rows older than the window start (windowStart = days[0], so a backward extension drains
 *   the zone) and still incomplete join the TODAY card's overdue zone; shown rows are capped
 *   at DECK_OVERDUE_CAP (`overdueShown`), the full count stays on `overdue` for the label and
 *   the numeric +N badge — nearest day first;
 * - deleted rows and dayStart-less rows are ignored (old contract).
 *
 * @param {Array} list source tasks (pre-filtered by the parent view)
 * @param {number[]} days deckWindowDays() output
 * @param {number} today0 local midnight of today
 * @returns {{ts: number, all: Array, overdue: Array, overdueShown: Array, futureN: number}[]}
 */
export function deckCards (list, days, today0) {
  const byDay = new Map(days.map(ts => [ts, []]))
  const windowStart = days.length ? days[0] : Infinity
  const windowEnd = days.length ? days[days.length - 1] : Infinity
  const overdue = []
  let futureN = 0
  for (const t of (Array.isArray(list) ? list : [])) {
    if (!t || t.delete || !t.dayStart) continue
    const ds = dayStart(t.dayStart)
    const bucket = byDay.get(ds)
    if (bucket) bucket.push(t)
    else if (!t.complete && ds < windowStart) overdue.push(t)
    // [w17] the future horizon cap truncates too: incomplete rows dated beyond the window END
    // used to fall into NO bucket with no signal (the past direction had the +N badge). Count
    // them onto the LAST card as a pure numeric badge (same incomplete-only contract as overdue).
    else if (!t.complete && ds > windowEnd) futureN++
  }
  if (overdue.length > 1) overdue.sort((a, b) => dayStart(b.dayStart) - dayStart(a.dayStart))
  return days.map((ts, i) => ({
    ts,
    all: byDay.get(ts) || [],
    overdue: ts === dayStart(today0) ? overdue : [],
    overdueShown: ts === dayStart(today0) ? overdue.slice(0, DECK_OVERDUE_CAP) : [],
    futureN: i === days.length - 1 ? futureN : 0
  }))
}

/**
 * [w17] Re-anchor the deck's front INDEX after the card window changed. `front` is a bare index:
 * when `days` shrinks or shifts (midnight tick, daySelectedTs reset to 0) a stale front can point
 * outside the window — every card display:none (blank board) and the arrow-key guards die.
 * - the selection (dayStart()-normalized; ts=0 anchors to today0) is fronted when it is a member;
 * - a beyond-cap selection fronts the nearest cap edge via clampToDayWindow (same semantics as the
 *   store watcher / created alignment — never feeds a store write-back);
 * - an empty window returns 0.
 *
 * @param {number[]} days deckWindowDays() output
 * @param {number} today0 local midnight of today
 * @param {number} selTs raw store selection (0 = none)
 * @returns {number} a valid index into `days`
 */
export function anchorFrontIndex (days, today0, selTs) {
  if (!Array.isArray(days) || !days.length) return 0
  const target = dayStart(selTs || today0 || 0)
  let idx = days.indexOf(target)
  if (idx < 0) idx = days.indexOf(clampToDayWindow(days, target))
  return idx >= 0 ? idx : 0
}
