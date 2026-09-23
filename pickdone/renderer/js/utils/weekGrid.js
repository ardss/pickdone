/**
 * Week-grid boundary single source (domain-3 renderer view time caliber, 2026-09-23).
 * Previously three coexisting implementations drifted: CalendarView used dayjs().startOf('week')
 * (Sunday start — no dayjs locale is ever set in the renderer), FilterView/chartModels hardcoded
 * isoWeek (Monday start), and the weekStartDay setting was honored only by DayDateStrip's private
 * helpers. These helpers are extracted verbatim from DayDateStrip.vue ([component-fixes] pure block)
 * so every week-based view resolves boundaries through one module.
 */
import { dayjs } from './core.js'

/** Leading-blank offset for a week-based grid honoring the week-start setting (Mon default / Sun optional) */
export function calGridOffset (dayOfWeek, weekFromSun) { return weekFromSun ? dayOfWeek : (dayOfWeek + 6) % 7 }

/** Column order mapped to the wd0(Sun)..wd6(Sat) i18n keys for the chosen week start */
export function weekHeaderOrder (weekFromSun) { return weekFromSun ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0] }

/** Day-start ts of the first cell of the week containing ts, honoring weekFromSun */
export function weekGridStart (ts, weekFromSun) {
  const d = dayjs(ts)
  return +d.subtract(calGridOffset(d.day(), weekFromSun), 'day').startOf('day')
}

// isoWeek (hard Monday) helpers — FilterView/chartModels keep the hard-Monday window on purpose:
// it pairs with cli/lib.js's week filter window (also isoWeek). Whether they should follow
// settings.weekStartDay like CalendarView/DayDateStrip is a product call pending confirmation;
// the implementation is converged here so the口径 has exactly one place to change.
export function isoWeekStart (ts) { return +dayjs(ts).startOf('isoWeek') }
export function isoWeekEnd (ts) { return +dayjs(ts).endOf('isoWeek') }
