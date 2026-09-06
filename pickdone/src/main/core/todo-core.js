/**
 * Shared task-semantics core — the single source of truth for write semantics for both the UI renderer and the CLI
 * Ported from renderer/js/store/todo.js (toggleComplete / ensureNextRepeatInstance)
 * and renderer/js/utils/repeat.js (expandRepeatDates, line-by-line equivalent port).
 * Note: the renderer is ESM (depends on window.dayjs); this module is CJS for the main process/CLI;
 * if semantics change, update both sides in sync — walkthrough cases under dev-tools can cross-verify.
 */
const dayjs = require('dayjs')
const isoWeek = require('dayjs/plugin/isoWeek')
dayjs.extend(isoWeek)

/** taskId: tid_<userId><6 random chars>_<ms timestamp> (charset aligned with renderer/js/utils/core.js) */
const RAND_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
function genTaskId (userId, now = Date.now()) {
  let r = ''
  for (let i = 0; i < 6; i++) r += RAND_CHARS[Math.floor(Math.random() * RAND_CHARS.length)]
  return `tid_${userId}${r}_${now}`
}

/* ================= Complete/undo (aligned with toggleComplete) ================= */
/**
 * Completing the main task also checks all its subtasks (isCompleteWithSubtasks, default true in settings).
 * The subtask list is stored as subtasks JSON: [{checked:boolean, ...}]; skip the cascade if the JSON is malformed.
 */
function completePatch (todo, { withSubtasks = true, completedAt } = {}) {
  const patch = { complete: true, completedAt: completedAt || Date.now() }
  if (withSubtasks) {
    try {
      const subs = JSON.parse(todo.subtasks || '[]')
      if (Array.isArray(subs) && subs.length && subs.some(s => !s.checked)) {
        patch.subtasks = JSON.stringify(subs.map(s => ({ ...s, checked: true })))
      }
    } catch { /* skip the cascade when the subtask JSON is malformed */ }
  }
  return patch
}

/* ================= Repeat engine (line-by-line port of utils/repeat.js) ================= */
const REPEAT_DEFAULTS = {
  repeatType: 'day',  // enum day/week/month/year; legacy '天'/'周'/'月'/'年' are compatible via normalizeRepeatType
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

const REPEAT_TYPE_MAP = { '天': 'day', '周': 'week', '月': 'month', '年': 'year', day: 'day', week: 'week', month: 'month', year: 'year' }
const REPEAT_YEAR_TYPE_MAP = { '公历': 'gregorian', '农历': 'lunar', gregorian: 'gregorian', lunar: 'lunar' }
// Must be semantically identical to the renderer's utils/repeat.js: unknown values always fall back to defaults (a past `|| v` passthrough meant the main process
// silently produced an empty sequence for dirty values, breaking the chain, while the renderer expanded by day — the two sides diverged)
function normalizeRepeatType (v) { return REPEAT_TYPE_MAP[v] || 'day' }
function normalizeYearType (v) { return REPEAT_YEAR_TYPE_MAP[v] || 'gregorian' }

function isWeekend (d) { return d.isoWeekday() > 5 }

// Lunar conversion (ISC solarlunar): the main process can require it directly (CJS); semantics aligned with the renderer's setLunarLib
let lunarLib = null
try { lunarLib = (r => r && r.default ? r.default : r)(require('solarlunar')) } catch { /* lunar branch safely skipped when the lib is missing */ }
function lunarToSolar (y, m, d) {
  if (!lunarLib || !lunarLib.lunar2solar) return null
  try {
    const r = lunarLib.lunar2solar(y, m, d)
    if (!r || !r.cYear) return null
    const t = dayjs(r.cYear + '-' + String(r.cMonth).padStart(2, '0') + '-' + String(r.cDay).padStart(2, '0'))
    if (+t.date() !== r.cDay || +(t.month() + 1) !== r.cMonth) return null // reject if dayjs carried a nonexistent date forward
    return t
  } catch { return null }
}

/** Generate the repeat date series (including the first day), returns a dayjs array in ascending order */
function expandRepeatDates (baseTs, settings, holidayList = []) {
  const s = Object.assign({}, REPEAT_DEFAULTS, settings, { repeatType: normalizeRepeatType(settings.repeatType || REPEAT_DEFAULTS.repeatType), repeatYearType: normalizeYearType(settings.repeatYearType || REPEAT_DEFAULTS.repeatYearType) })
  const holSet = new Set(holidayList.filter(h => h.holiday).map(h => h.dateString))
  const workdaySet = new Set(holidayList.filter(h => !h.holiday).map(h => h.dateString))

  const skipDate = d => {
    if (s.statutoryWorkdays) {
      if (holSet.has(d.format('YYYY-MM-DD'))) return true
      if (isWeekend(d) && !workdaySet.has(d.format('YYYY-MM-DD'))) return true
    } else {
      if (s.skipStatutoryHolidays && holSet.has(d.format('YYYY-MM-DD'))) return true
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
          if (md > dim) continue
          const target = cursor.date(md)
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
        // repeatYearType was normalized at entry to gregorian/lunar by normalizeYearType (legacy Chinese values mapped),
        // so the comparison here must use the normalized enum — comparing '农历' used to silently degrade main-process lunar repeats to gregorian
        if (s.repeatYearType === 'lunar') {
          // Lunar years: years where the 29th/30th day does not exist are skipped automatically (same semantics as the renderer's utils/repeat.js)
          const target = lunarToSolar(yy, s.repeatYearMonth, s.repeatYearMonthDay)
          if (target && !target.isBefore(dayjs(baseTs).startOf('day')) && !skipDate(target)) {
            out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
          }
        } else {
          // Calendar-validity guard (aligned with the renderer's repeat.js): dayjs silently carries Feb 30 forward to Mar 2 with isValid()===true
          const mm = String(s.repeatYearMonth).padStart(2, '0')
          if (s.repeatYearMonthDay <= dayjs(`${yy}-${mm}-01`).daysInMonth()) {
            const target = dayjs(`${yy}-${mm}-${String(s.repeatYearMonthDay).padStart(2, '0')}`)
            if (target.isValid() && !target.isBefore(dayjs(baseTs).startOf('day')) && !skipDate(target)) {
              out.push(target.hour(dayjs(baseTs).hour()).minute(dayjs(baseTs).minute()))
            }
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

/**
 * Repeat-group renewal computation (pure function, aligned with the decision part of ensureNextRepeatInstance):
 * when the latest instance in the group is completed, returns the next instance's {todoTime, reminderTime} per the rule; returns null when no renewal is needed.
 * @param completedTodo the task instance that was completed
 * @param group all active instances in the group (repeatId === rid and not deleted)
 * @param rule repeatSettingsV2 (from meta 'repeatRule:<rid>')
 */
function nextRepeatInstance (completedTodo, group, rule, holidayList = []) {
  if (!rule) return null
  // dayStart=0 = no-date task, must not enter renewal logic (it would produce a bogus 1970 instance)
  if (!completedTodo.dayStart) return null
  const valid = group.filter(t => t.dayStart > 0)
  if (!valid.length) return null
  const lastDay = Math.max(...valid.map(t => t.dayStart))
  // Renew only when the completed one is the last (latest) instance in the group; leave untouched if future instances remain
  if (completedTodo.dayStart < lastDay) return null
  const dates = expandRepeatDates(lastDay || completedTodo.todoTime, rule, holidayList)
  const next = dates.map(d => +d).find(ts => ts > (completedTodo.dayStart || 0))
  if (!next) return null
  let remind = 0
  if (completedTodo.reminderTime > 0 && completedTodo.dayStart) {
    const r = dayjs(completedTodo.reminderTime)
    remind = dayjs(next).hour(r.hour()).minute(r.minute()).second(0).valueOf()
  }
  return { todoTime: next, reminderTime: remind, reminderOffsets: Array.isArray(completedTodo.reminderOffsets) ? completedTodo.reminderOffsets : [], reminderExtra: Array.isArray(completedTodo.reminderExtra) ? completedTodo.reminderExtra : [] }
}

module.exports = { genTaskId, completePatch, expandRepeatDates, nextRepeatInstance, REPEAT_DEFAULTS }
