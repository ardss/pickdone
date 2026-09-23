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
