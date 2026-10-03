/**
 * "Today midnight" single source (domain-3 renderer view time caliber, 2026-09-23).
 * Components used to inline dayjs().startOf('day') each on their own (37 sites / 22 files in the
 * renderer), which both duplicates the expression and bypasses the store's cross-midnight
 * refresh (store/todo.js todayTimestamp + the 60s dirt-check). Callers that need reactive
 * cross-midnight updates should still read store.state.todo.todayTimestamp; these helpers cover
 * non-reactive computations.
 *
 * SELF-CONTAINED CALENDAR MATH (2026-10-03): the three primitives are pure local-calendar
 * computations — local midnight of a day, and a whole-calendar-day step. The JS Date constructor
 * computes exactly those in local time (day-of-month overflow normalizes across month/year
 * boundaries; DST transitions are absorbed because every field is interpreted as local wall
 * time — the same semantics dayjs's startOf('day')/.add(n,'day') provide). Binding them to the
 * renderer's dayjs UMD global made the module un-runnable outside the shell: node-env unit tests
 * import store modules (e.g. category.js mergeableLsTombstones) that land here, and a bare
 * node_modules import is architecturally forbidden (no bundler; dayjs ships as a CJS UMD tag).
 * With the math inlined there is NO external binding left to break — the module runs identically
 * in the renderer shell and in node.
 */

/** Day-start ts of today (or of the injected `now`), non-reactive */
export function today0 (now = Date.now()) { return dayStart(now) }

/** Day-start ts of an arbitrary ts (normalizes any moment to its own day's midnight) */
export function dayStart (ts) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Calendar day shift: the ONLY sanctioned sibling-day stepping primitive (day-caliber domain,
 * 2026-10-03). Returns `ts` moved n CALENDAR days (time-of-day preserved as local wall time).
 * Call sites must NOT reinvent `ts ± n*86400000`: local midnights are 23h/25h apart across a
 * DST transition, so ms arithmetic silently lands 23:00 of the same day (fall-back) or skips an
 * hour of the next day (spring-forward) — exact-equality dayStart filters then drop rows.
 * (Duration divisors like `(end - start) / 86400000` for day-fraction percentages are NOT day
 * stepping and stay legal.) Enforced by the day-arithmetic guard in
 * tests/unit/renderer/dw3-domain3-time-caliber.test.mjs.
 */
export function dayShift (ts, n) {
  const d = new Date(ts)
  return new Date(
    d.getFullYear(), d.getMonth(), d.getDate() + n,
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()
  ).getTime()
}
