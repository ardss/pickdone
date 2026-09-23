/**
 * Shared repeat engine — the single source of truth for expandRepeatDates, used by BOTH the
 * renderer (renderer/js/utils/repeat.js) and the main process/CLI (src/main/core/todo-core.js).
 * Replaces the hand-maintained line-by-line port that had already drifted semantically:
 *   (a) month branch — the main process still did `if (md > dim) continue` while the renderer
 *       clamps effDay = min(md, dim); a monthly 31-day task lost its occurrence in every short
 *       month on the main-process side.
 *   (b) week branch — the renderer dedupes repeatWeekDays with a Set, the main process did not,
 *       so duplicated weekday entries produced duplicate instances on the main-process side.
 * The alignment to the renderer's clamp+dedupe semantics is a deliberate behavior fix.
 *
 * Pure module: the dayjs factory and the lunar conversion are injected by the caller
 * (browser passes the UMD global, Node passes require('dayjs')), same pattern as
 * shared/limits.mjs / shared/parse-date.mjs.
 */

export const REPEAT_DEFAULTS = {
  repeatType: 'day',  // enum: day/week/month/year; legacy values '天'/'周'/'月'/'年' kept compatible via normalizeRepeatType
  repeatInterval: 1,
  repeatDayCount: 90,
  repeatWeekCount: 52,
  repeatMonthCount: 24,
  repeatYearCount: 5,
  repeatWeekDays: [1, 2, 3, 4, 5],
  repeatMonthDays: [1],
  repeatYearMonth: 1,
  repeatYearMonthDay: 1,
  repeatYearType: '公历',
  skipStatutoryHolidays: false,
  skipWeekends: false,
  statutoryWorkdays: false
}

/** Legacy Chinese → new English enum mapping (with historical fault tolerance); new code uniformly uses day/week/month/year, both renderer and CLI pass through here before writing */
const REPEAT_TYPE_MAP = { '天': 'day', '周': 'week', '月': 'month', '年': 'year', 'day': 'day', 'week': 'week', 'month': 'month', 'year': 'year' }
const REPEAT_YEAR_TYPE_MAP = { '公历': 'gregorian', '农历': 'lunar', 'gregorian': 'gregorian', 'lunar': 'lunar' }
// Unknown values always fall back to defaults: a past `|| v` passthrough meant the main process
// silently produced an empty sequence for dirty values, breaking the chain, while the renderer
// expanded by day — the two sides diverged.
export function normalizeRepeatType (s) { return REPEAT_TYPE_MAP[s] || 'day' }
export function normalizeYearType (s) { return REPEAT_YEAR_TYPE_MAP[s] || 'gregorian' }

export function isWeekend (d) { return d.isoWeekday() > 5 }

/** Lunar (y,m,d) → solar dayjs; returns null when the library is missing or the date is invalid
 *  (e.g. a non-existent 29th lunar day). lunarLib is the ISC solarlunar module (UMD/default shaped). */
export function makeLunarToSolar (dayjs, lunarLib) {
  return function lunarToSolar (y, m, d) {
    if (!lunarLib || !lunarLib.lunar2solar) return null
    try {
      const r = lunarLib.lunar2solar(y, m, d)
      if (!r || !r.cYear) return null
      const [yy, mm, dd] = [r.cYear, r.cMonth, r.cDay]
      const t = dayjs(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`)
      // Round-trip validation: dayjs silently carries over non-existent dates, must reject
      if (+t.date() !== dd || +(t.month() + 1) !== mm) return null
      return t
    } catch { return null }
  }
}

/* ================= Repeat-group renewal (single source for CLI + renderer) ================= */

/**
 * Is the completed instance the last (latest) one in its repeat group? Only the last instance
 * renews; future instances must be left untouched. No-date instances (dayStart=0) never renew
 * (they would expand a bogus 1970 chain).
 * @param completedTodo the instance that was completed
 * @param group all active instances in the group (repeatId === rid, not deleted)
 */
export function isLastRepeatInstance (completedTodo, group) {
  if (!completedTodo || !completedTodo.dayStart) return false
  const valid = (group || []).filter(t => t.dayStart > 0)
  if (!valid.length) return false
  const lastDay = Math.max(...valid.map(t => t.dayStart))
  return completedTodo.dayStart >= lastDay
}

/**
 * Fields a renewed instance carries over from the instance being renewed (P2-4 single source —
 * the CLI twin (cli/lib.js renewal) and the renderer twin (store/todo.js ensureNextRepeatInstance
 * → addTodo payload) must agree on exactly this set; the D5 parity fixes had to be applied twice
 * before this was extracted). `t.x || 0` semantics are the established contract on both ends.
 */
export function renewalCarryFields (t, next) {
  return {
    reminderTime: next.reminderTime,
    reminderOffsets: Array.isArray(t.reminderOffsets) ? t.reminderOffsets : [],
    reminderExtra: Array.isArray(t.reminderExtra) ? t.reminderExtra : [],
    difficulty: t.difficulty || 0,
    priority: t.priority || 0,
    deadlineTs: t.deadlineTs || 0,
    important: t.important || 0,
    urgent: t.urgent || 0,
    repeatId: t.repeatId
  }
}

/**
 * Repeat-group renewal computation (pure): when the last instance in the group is completed,
 * returns the next instance's {todoTime, reminderTime} per the rule; null when no renewal is needed.
 * @param deps { dayjs, lunarToSolar } — same injection as expandRepeatDates
 */
export function nextRepeatInstance (completedTodo, group, rule, holidayList = [], deps) {
  if (!rule) return null
  if (!isLastRepeatInstance(completedTodo, group)) return null
  const { dayjs } = deps
  const valid = group.filter(t => t.dayStart > 0)
  const lastDay = Math.max(...valid.map(t => t.dayStart))
  const dates = expandRepeatDates(lastDay || completedTodo.todoTime, rule, holidayList, deps)
  const next = dates.map(d => +d).find(ts => ts > (completedTodo.dayStart || 0))
  if (!next) return null
  let remind = 0
  if (completedTodo.reminderTime > 0 && completedTodo.dayStart) {
    const r = dayjs(completedTodo.reminderTime)
    remind = dayjs(next).hour(r.hour()).minute(r.minute()).second(0).valueOf()
  }
  return {
    todoTime: next,
    reminderTime: remind,
    reminderOffsets: Array.isArray(completedTodo.reminderOffsets) ? completedTodo.reminderOffsets : [],
    reminderExtra: Array.isArray(completedTodo.reminderExtra) ? completedTodo.reminderExtra : []
  }
}

/**
 * Generate the repeating date sequence
 * @param baseTs first entry's timestamp
 * @param settings repeatSettingsV2
 * @param holidayList [{dateString:'YYYY-MM-DD', holiday:true|false}]
 * @param deps { dayjs, lunarToSolar } — injected (browser UMD global vs Node require; lunar optional)
 * @returns [dayjs...] including the first day, ascending
 */
export function expandRepeatDates (baseTs, settings, holidayList = [], deps) {
  const { dayjs, lunarToSolar } = deps
  if (typeof dayjs !== 'function') throw new Error('expandRepeatDates: dayjs dependency must be injected')
  const s = Object.assign({}, REPEAT_DEFAULTS, settings, { repeatType: normalizeRepeatType(settings.repeatType || REPEAT_DEFAULTS.repeatType), repeatYearType: normalizeYearType(settings.repeatYearType || REPEAT_DEFAULTS.repeatYearType) })
  const holSet = new Set(holidayList.filter(h => h.holiday).map(h => h.dateString))
  const workdaySet = new Set(holidayList.filter(h => !h.holiday).map(h => h.dateString))

  const isWknd = d => d.isoWeekday() > 5
  const FMT_DATE = 'YYYY-MM-DD'
  const skipDate = d => {
    if (s.statutoryWorkdays) {
      if (holSet.has(d.format(FMT_DATE))) return true
      if (isWknd(d) && !workdaySet.has(d.format(FMT_DATE))) return true
    } else {
      if (s.skipStatutoryHolidays && holSet.has(d.format(FMT_DATE))) return true
      if (s.skipWeekends && isWknd(d)) return true
    }
    return false
  }

  const out = []
  const pushDay = i => dayjs(baseTs).add(i * s.repeatInterval, 'day')

  switch (s.repeatType) {
    case 'day':
      for (let i = 0; i < s.repeatDayCount; i++) {
        const d = pushDay(i)
        if (!skipDate(d)) out.push(d)
      }
      break
    case 'week': {
      let anchor = dayjs(baseTs)
      for (let w = 0; w < s.repeatWeekCount; w++) {
        // Set dedupe: duplicated weekday entries must not produce duplicate instances
        for (const wd of [...new Set(s.repeatWeekDays || [])].sort((a, b) => a - b)) {
          // Weekdays within the current week that are >= the anchor day; then jumps one week at a time
          const startOfWeek = anchor.startOf('isoWeek')
          const target = startOfWeek.add(wd - 1, 'day')
          if (target.isBefore(dayjs(baseTs).startOf('day'))) continue
          if (!skipDate(target)) out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
        }
        anchor = anchor.add(s.repeatInterval, 'week')
      }
      break
    }
    case 'month': {
      let cursor = dayjs(baseTs).date(1)
      for (let mi = 0; mi < s.repeatMonthCount; mi++) {
        for (const md of [...new Set(s.repeatMonthDays || [])].sort((a, b) => a - b)) {
          const dim = cursor.daysInMonth()
          // End-of-month clamp: the 31st in a 30-day month falls onto the month's last day
          // (universal calendar semantics); the old main-process `if (md > dim) continue` made a
          // 1-31 monthly repeat silently vanish for entire 2/4/6/9/11 months
          const effDay = Math.min(md, dim)
          const target = cursor.date(effDay)
          if (target.isBefore(dayjs(baseTs).startOf('day'))) continue
          if (!skipDate(target)) out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
        }
        cursor = cursor.add(s.repeatInterval, 'month')
      }
      break
    }
    case 'year': {
      const y = dayjs(baseTs).year()
      const years = Math.max(1, s.repeatYearCount)
      for (let yi = 0; yi < years; yi++) {
        const yy = y + yi * s.repeatInterval
        if (s.repeatYearType === 'gregorian') {
          // Calendar validity check: non-existent dates like "Feb 30" are silently carried by dayjs into "Mar 2", must reject
          const mm = String(s.repeatYearMonth).padStart(2, '0')
          const dd = s.repeatYearMonthDay
          if (dd <= dayjs(`${yy}-${mm}-01`).daysInMonth()) {
            const target = dayjs(`${yy}-${mm}-${String(dd).padStart(2, '0')}`)
            if (target.isValid() && !target.isBefore(dayjs(baseTs).startOf('day')) && !skipDate(target)) {
              out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
            }
          }
        } else if (s.repeatYearType === 'lunar') {
          // Lunar yearly: fixed lunar month/day → converted per solar year (leap month falls back to the plain month; years lacking 29th/30th lunar days are skipped automatically)
          const target = lunarToSolar ? lunarToSolar(yy, s.repeatYearMonth, s.repeatYearMonthDay) : null
          if (target && !target.isBefore(dayjs(baseTs).startOf('day')) && !skipDate(target)) {
            out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
          }
        }
      }
      break
    }
    default:
      break
  }
  return out.sort((a, b) => a.valueOf() - b.valueOf())
}
