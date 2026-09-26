/**
 * Extracted from store/todo.js (structure-size ratchet): view-shape constants, the Vue-proxy
 * stripper, and small view filter helpers. No behavior change — code moved verbatim.
 */

export const DEFAULT_VIEWS = () => ({
    todayTodoList: [],
    todayDoneList: [],
    todayXNext: [], // TodayX "Next" group: today + ALL overdue uncompleted (uncapped, sorted by dayStart/todoTime) — cannot reuse recent.expiredUncompleted (capped by expUncompletedDays)
    todayXOpen: [], // TodayX "Unscheduled" group: no-date uncompleted, unsorted — always shown, unlike recent.noDate (gated by showNoDate)
    yesterdayTodoList: [],
  calendar: [],
  todoBox: [],
  todoBoxCount: 0,
  completed: [],
    recycleBin: []
})

// Fields affecting a view's group membership (one-to-one with computeViews' grouping criteria):
// delete/deletedAt (active/recycle bin), todoTime/dayStart (date grouping), complete/completedAt (completed grouping), categoryId (todo-box category filter)
// Only writes to these fields need an immediate full view rebuild; the rest (title/description/subtask plain-text edits) take the lightweight path
export const VIEW_AFFECTING_FIELDS = ['delete', 'deletedAt', 'todoTime', 'dayStart', 'complete', 'completedAt', 'categoryId']
export const VIEWS_DEBOUNCE_MS = 600 // View-rebuild debounce for plain-text edits: staggered from EditPanel's 350ms save cadence; continuous typing recomputes only once

/** Strip Vue reactive proxies before IPC: rows come straight from reactive state, and a shallow spread
 *  ({ ...raw }) only unwraps the top level — nested arrays (reminderOffsets/reminderExtra/subtasks JSON is a
 *  string, but reminderOffsets etc. stay Proxies) still fail the structured clone inside invoke
 *  ("An object could not be cloned" = the whole upsertMany batch silently dropped, same root cause
 *  safeUpsert's JSON round-trip documents for single rows) */
export function deproxyRows (rows) { return JSON.parse(JSON.stringify(rows)) }

export function showNoDateFilter (arr, settings) {
  return settings.showNoDate ? arr : []
}

/* Calendar view data: for the current month's span (±half a year), the daily set can render directly from raw todoList rows */
export function buildCalendarList (live) { return live.slice() }
