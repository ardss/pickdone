/**
 * "Today midnight" single source (domain-3 renderer view time caliber, 2026-09-23).
 * Components used to inline dayjs().startOf('day') each on their own (37 sites / 22 files in the
 * renderer), which both duplicates the expression and bypasses the store's cross-midnight
 * refresh (store/todo.js todayTimestamp + the 60s dirt-check). This wave only converges the
 * domain-3 files; the remaining sites (store/todo.js, EditPanel, taskMenu.js, …) belong to
 * other domains and stay untouched. Callers that need reactive cross-midnight updates should
 * still read store.state.todo.todayTimestamp; these helpers cover non-reactive computations.
 */
import { dayjs } from './core.js'

/** Day-start ts of today (or of the injected `now`), non-reactive */
export function today0 (now = Date.now()) { return +dayjs(now).startOf('day') }

/** Day-start ts of an arbitrary ts (normalizes any moment to its own day's midnight) */
export function dayStart (ts) { return +dayjs(ts).startOf('day') }

/**
 * Calendar day shift: the ONLY sanctioned sibling-day stepping primitive (day-caliber domain,
 * 2026-10-03). Returns `ts` moved n calendar days via dayjs .add(n,'day'), i.e. DST-aware.
 * Call sites must NOT reinvent `ts ± n*86400000`: local midnights are 23h/25h apart across a
 * DST transition, so ms arithmetic silently lands 23:00 of the same day (fall-back) or skips an
 * hour of the next day (spring-forward) — exact-equality dayStart filters then drop rows.
 * (Duration divisors like `(end - start) / 86400000` for day-fraction percentages are NOT day
 * stepping and stay legal.) Enforced by the day-arithmetic guard in
 * tests/unit/renderer/dw3-domain3-time-caliber.test.mjs.
 */
export function dayShift (ts, n) { return +dayjs(ts).add(n, 'day') }
