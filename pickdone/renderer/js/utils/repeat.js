/**
 * Repeating-task engine — batch pre-expansion (semantics aligned with the reference repeatSettingsV2)
 * Tasks in the same group share a repeatId (written to repeatId); the group tail auto-appends a hint
 *
 * The engine itself is the shared single source (shared/repeat-core.mjs, also used by the main
 * process / CLI via src/main/core/todo-core.js); this module injects the browser's UMD dayjs
 * global and keeps the renderer-only surface (setLunarLib, cleanupOrphanRepeatRule).
 */
import { dayjs } from './core.js'
import {
  expandRepeatDates as coreExpandRepeatDates,
  nextRepeatInstance as coreNextRepeatInstance,
  isLastRepeatInstance,
  renewalCarryFields,
  makeLunarToSolar,
  REPEAT_DEFAULTS,
  normalizeRepeatType,
  normalizeYearType,
  isWeekend
} from '../../../shared/repeat-core.mjs'

export { REPEAT_DEFAULTS, normalizeRepeatType, normalizeYearType, isWeekend, isLastRepeatInstance, renewalCarryFields }

/* ===== Lunar library injection (ISC solarlunar; the original js-calendar-converter is GPL so the library had to be swapped) =====
 * The library is injected dynamically as UMD/ESM: in the browser setLunarLib() is called at main.js startup; in Node unit tests it's injected after require.
 * When not injected, the lunar branch is safely skipped (returns an empty sequence), no throw. */
let lunarLib = null
export function setLunarLib (lib) { lunarLib = lib }

/**
 * Generate the repeating date sequence
 * @param baseTs first entry's timestamp
 * @param settings repeatSettingsV2
 * @param holidayList [{dateString:'YYYY-MM-DD', holiday:true|false}]
 * @returns [dayjs...] including the first day
 */
export function expandRepeatDates (baseTs, settings, holidayList = []) {
  return coreExpandRepeatDates(baseTs, settings, holidayList, { dayjs, lunarToSolar: makeLunarToSolar(dayjs, lunarLib) })
}

/** Repeat-group renewal (single source: shared/repeat-core.mjs) — bound to the browser dayjs/lunar lib */
export function nextRepeatInstance (completedTodo, group, rule, holidayList = []) {
  return coreNextRepeatInstance(completedTodo, group, rule, holidayList, { dayjs, lunarToSolar: makeLunarToSolar(dayjs, lunarLib) })
}

/** U-2 (2026-09-20): orphan repeat-rule cleanup (renderer twin of the CLI convention — deleteMeta over
 *  setMeta(''), since an empty-string tombstone keeps the orphan meta row alive). deleteMeta takes the
 *  BARE key string: the array form was bound as positional params and always threw (hidden by .catch),
 *  so orphan rules lingered forever. Extracted so the modal path is unit-testable without a .vue loader. */
export async function cleanupOrphanRepeatRule (rid) {
  if (!rid || typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
  try {
    const rest = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId: rid })
    if (!rest.length) {
      window.todoAPI.dbCall('deleteMeta', 'repeatRule:' + rid).catch(() => {})
    }
  } catch (e) { /* cleanup failure must not affect deletion */ }
}
