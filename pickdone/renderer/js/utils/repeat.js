import { FMT } from './core.js'
/**
 * Repeating-task engine — batch pre-expansion (semantics aligned with the reference repeatSettingsV2)
 * Tasks in the same group share a repeatId (written to repeatId); the group tail auto-appends a hint
 */
import { dayjs } from './core.js'

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
export function normalizeRepeatType (s) { return REPEAT_TYPE_MAP[s] || 'day' }
export function normalizeYearType (s) { return REPEAT_YEAR_TYPE_MAP[s] || 'gregorian' }

export function isWeekend (d) { return d.isoWeekday() > 5 }

/* ===== Lunar conversion (ISC solarlunar; the original js-calendar-converter is GPL so the library had to be swapped) =====
 * The library is injected dynamically as UMD/ESM: in the browser setLunarLib() is called at main.js startup; in Node unit tests it's injected after require.
 * When not injected, the lunar branch is safely skipped (returns an empty sequence), no throw. */
let lunarLib = null
export function setLunarLib (lib) { lunarLib = lib }

/** Lunar (y,m,d) → solar dayjs; returns null when the library is missing or the date is invalid (e.g. a non-existent 29th lunar day) */
function lunarToSolar (y, m, d) {
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

/**
 * Generate the repeating date sequence
 * @param baseTs first entry's timestamp
 * @param settings repeatSettingsV2
 * @param holidayList [{dateString:'YYYY-MM-DD', holiday:true|false}]
 * @returns [dayjs...] including the first day
 */
export function expandRepeatDates (baseTs, settings, holidayList = []) {
  const s = Object.assign({}, REPEAT_DEFAULTS, settings, { repeatType: normalizeRepeatType(settings.repeatType || REPEAT_DEFAULTS.repeatType), repeatYearType: normalizeYearType(settings.repeatYearType || REPEAT_DEFAULTS.repeatYearType) })
  const holSet = new Set(holidayList.filter(h => h.holiday).map(h => h.dateString))
  const workdaySet = new Set(holidayList.filter(h => !h.holiday).map(h => h.dateString))

  const skipDate = d => {
    if (s.statutoryWorkdays) {
      if (holSet.has(d.format(FMT.date))) return true
      if (isWeekend(d) && !workdaySet.has(d.format(FMT.date))) return true
    } else {
      if (s.skipStatutoryHolidays && holSet.has(d.format(FMT.date))) return true
      if (s.skipWeekends && isWeekend(d)) return true
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
        for (const wd of [...(s.repeatWeekDays || [])].sort((a, b) => a - b)) {
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
        for (const md of [...(s.repeatMonthDays || [])].sort((a, b) => a - b)) {
          const dim = cursor.daysInMonth()
          // End-of-month clamp: the 31st in a 30-day month falls onto the month's last day (universal calendar semantics); the original continue made a 1-31 monthly repeat silently vanish for entire 2/4/6/9/11 months
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
          const target = lunarToSolar(yy, s.repeatYearMonth, s.repeatYearMonthDay)
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


