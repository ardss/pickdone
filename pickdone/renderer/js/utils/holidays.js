/**
 * Statutory holiday data — renderer-side re-export of the single source shared/holidays.mjs
 * (dw wave5 2026-09-24: the hand-rolled mirror here and its main-process twin in
 * src/main/core/holidays.js were verbatim duplicates; both now consume shared/holidays.mjs,
 * which carries the maintenance notes and the update discipline).
 */
export { HOLIDAY_DATA, getHolidayList } from '../../../shared/holidays.mjs'
