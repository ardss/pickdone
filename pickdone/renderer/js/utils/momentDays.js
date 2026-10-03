/**
 * Moments (HabitView countdown/memorial) date math — pure helper, extracted A14 (2026-10-02).
 * The component's daysDiff used to read the dayjs() wall clock directly — the exact staleness
 * class the same file's todayKey was migrated away from (a zero-reactive-dependency computed
 * caches its first value, so post-midnight renders keep writing into yesterday's bucket).
 * Callers now pass "today" explicitly (store.todo.todayTimestamp, already a day-start ts via
 * setTodayTs), which makes the diff reactive and unit-testable.
 */
import { dayjs } from './core.js'

/** Whole days from today (day-start ts) to `date` (negative = past, 0 = today, positive = future) */
export function daysDiffFromToday (date, todayStartTs) {
  const target = +dayjs(date).startOf('day')
  const today = +dayjs(todayStartTs == null ? Date.now() : todayStartTs).startOf('day')
  return Math.round((target - today) / 86400000)
}
