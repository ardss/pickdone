/* Date sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Date parsing (today/tomorrow/+Nd/YYYY-MM-DD[ HH:mm]/timestamps/Chinese NL fallback) + lunar annotation. */
module.exports = ({ CliError, dayjs, nlDate }) => {
  /* ================= Date parsing ================= */
  /** Supports today/tomorrow/yesterday/+N/-N days, YYYY-MM-DD, YYYY-MM-DD HH:mm, timestamps */
  function parseDate (s) {
    if (s == null || s === '') return 0
    const str = String(s).trim().toLowerCase()
    // Explicitly accept only 13-digit ms timestamps (avoids a 12-digit seconds value being parsed as ms → 1970)
    if (/^[+-]?\d{13}$/.test(str)) return parseInt(str, 10) // timestamp
    const now = dayjs()
    // Relative offsets: +3d / -1w / +2m, and offset-with-time like +2d 16:30
    const offTime = str.match(/^([+-])(\d+)([dwm])\s+(\d{1,2}):(\d{2})$/)
    const offMatch = str.match(/^([+-])(\d+)([dwm])$/)
    if (offTime || offMatch) {
      const sign = (offTime || offMatch)[1]
      const n = parseInt((offTime || offMatch)[2]) * (sign === '+' ? 1 : -1)
      const unit = { d: 'day', w: 'week', m: 'month' }[(offTime || offMatch)[3]]
      const base = now.add(n, unit)
      if (offTime) return +base.hour(+offTime[4]).minute(+offTime[5]).second(0).millisecond(0)
      return +base
    }
    if (str === 'today' || str === '今天') return +now
    if (str === 'tomorrow' || str === '明天') return +now.add(1, 'day')
    if (str === 'yesterday' || str === '昨天') return +now.subtract(1, 'day')
    // Keyword+time combos (tomorrow 09:00 / 明天11点) resolve deterministically before nlDate: "tomorrow" said in the small hours would
    // colloquially land on today's daytime per Chinese usage, but for the CLI's AI users tomorrow must be unambiguous (+1 day)
    const kw = str.match(/^(today|tomorrow|yesterday)\s+(\d{1,2}):(\d{2})$/)
    if (kw) {
      const base = { today: now, tomorrow: now.add(1, 'day'), yesterday: now.subtract(1, 'day') }[kw[1]]
      return +base.hour(+kw[2]).minute(+kw[3]).second(0).millisecond(0)
    }
    // Bare M/D, M.D, M-D (no year) must be intercepted BEFORE dayjs(): V8's fallback Date parse
    // turns '9/22' into 2001-09-22 and reports it valid (P2-1). Current year + explicit month/day
    // validation, same interception the shared parseMilestoneDateCore applies.
    const bareMd = str.match(/^(\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
    if (bareMd) {
      const mo = +bareMd[1]; const d2 = +bareMd[2]
      if (mo < 1 || mo > 12) throw new CliError(`invalid date: "${s}" (month ${mo} does not exist)`)
      const days = dayjs().month(mo - 1).daysInMonth()
      if (d2 < 1 || d2 > days) throw new CliError(`invalid date: "${s}" (${mo}-${d2} is not a valid month/day — month ${mo} has ${days} days)`)
      let base = dayjs().month(mo - 1).date(d2)
      if (bareMd[3] != null) base = base.hour(+bareMd[3]).minute(+bareMd[4]).second(0).millisecond(0)
      else base = base.startOf('day')
      return +base
    }
    const d = dayjs(str)
    if (!d.isValid()) {
      // Chinese natural-language date fallback (后天/下周五/3天后/周末/M月D日…): same rule set as the renderer's nlDate, saving AI conversion tokens
      const nl = nlDate.parseNaturalDate(String(s).trim())
      if (nl && nl.date) return +nl.date
      throw new CliError(`cannot parse date: "${s}" (supported: today/tomorrow/+3d/YYYY-MM-DD[ HH:mm], plus Chinese forms like 后天/下周五/8月15日)`)
    }
    // dayjs silent carry-over (2025-02-29 → 2025-03-01) — split Y/M/D and validate explicitly, aligned with the renderer's nlDate
    const dateMatch = str.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/)
    if (dateMatch) {
      const y = +dateMatch[1]; const mo = +dateMatch[2]; const d2 = +dateMatch[3]
      const days = dayjs().year(y).month(mo - 1).daysInMonth()
      if (mo < 1 || mo > 12 || d2 < 1 || d2 > days) throw new CliError(`invalid date: "${s}" (${y}-${mo} has only ${days} days)`)
    }
    return +d
  }

  /** Deadline → 00:00 of that day (consistent with the renderer's dayjs(todoTime).startOf('day')) */
  function dayStartOf (ts) { return ts ? +dayjs(ts).startOf('day') : 0 }

  /* ---------------- Lunar annotation (solarlunar, same ISC dependency the App's calendar/repeat use) ---------------- */
  let _solarlunar = null
  function solarlunar () {
    if (!_solarlunar) _solarlunar = (r => (r && r.default) ? r.default : r)(require('solarlunar'))
    return _solarlunar
  }

  /** Short lunar annotation for a task's displayed date: "七月廿九" (null when the task has no date or the lib is missing) */
  function lunarOf (t) {
    const ts = t && (t.todoTime || t.dayStart)
    if (!ts) return null
    try {
      const d = dayjs(ts)
      const l = solarlunar().solar2lunar(d.year(), d.month() + 1, d.date())
      return l && l.monthCn && l.dayCn ? l.monthCn + l.dayCn : null
    } catch { return null }
  }

  /** Full annotation for --json rows: "YYYY-MM-DD · 七月廿九" (null for undated tasks) */
  function lunarAnnotate (t) {
    const short = lunarOf(t)
    if (!short) return null
    return dayjs(t.todoTime || t.dayStart).format('YYYY-MM-DD') + ' · ' + short
  }

  /* ---------------- Reminder re-anchor on a reschedule (moved verbatim from lib.js, D18-DOM2 size-ratchet) ----------------
   * Review P1 2026-09-11; renderer parity: EditPanel.applyDate. Shared by `edit --date` (pickdone.js)
   * and `batch date` (batchRun) — the two channels used to diverge: batch bypassed the entry-layer
   * re-anchor and left the main reminder on the old day. Moving the date carries reminders along:
   * the main reminder re-anchors to the new date at its original time-of-day (stays absent when
   * there was none) and reminderExtra rows shift by the same day-diff. Returns the fields to merge
   * into the patch; empty object when there is nothing to carry. */
  function dateChangeReminderPatch (before, newTodoTime) {
    const patch = {}
    if (!newTodoTime || !before) return patch
    if (before.reminderTime) {
      // EditPanel.applyDate takes hour/minute from the OLD reminder and keeps the NEW timestamp's
      // base (seconds/millis — 0 for explicit dates). maint/d23 P3: the CLI used to also copy the
      // OLD reminder's second/millisecond, so an old reminder carrying :07 seconds produced a
      // sub-minute divergence from the App's reminder for the same edit.
      const r = dayjs(before.reminderTime)
      patch.reminderTime = +dayjs(newTodoTime).hour(r.hour()).minute(r.minute())
    }
    const extras = Array.isArray(before.reminderExtra) ? before.reminderExtra : []
    const oldDay = before.todoTime ? +dayjs(before.todoTime).startOf('day') : 0
    if (extras.length && oldDay) {
      const shift = +dayjs(newTodoTime).startOf('day').diff(oldDay, 'day')
      if (shift) patch.reminderExtra = extras.map(x => +dayjs(x).add(shift, 'day'))
    }
    return patch
  }

  return { parseDate, dayStartOf, lunarOf, lunarAnnotate, dateChangeReminderPatch }
}
