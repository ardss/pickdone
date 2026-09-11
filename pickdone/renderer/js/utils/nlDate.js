import { FMT } from './core.js'
/**
 * Natural-language date parsing — the Chinese rule set is single-sourced in
 * shared/nl-date-core.cjs (also used by cli/nl-date.cjs; architecture review
 * item 5). This file keeps only the renderer-side extras: the English NL
 * branch and the Chinese/English dispatch.
 */
import { dayjs } from './core.js'
import { parseChineseNaturalDate } from '../../../shared/nl-date-core.mjs'

/** English NL parsing:
 *  - today / tonight / tomorrow / yesterday
 *  - this monday / next monday / on monday / on mon (defaults to next occurrence; rolls a week if today's has passed)
 *  - this weekend (= Saturday)
 *  - in 3 days / in 1 week / in 2 months
 *  - +Nd / +Nw / +Nm (CLI-friendly syntax, reuses dayjs.add)
 *  - 2026-01-15 / 2026/1/15 / Jan 15 / Jan 15, 2026 / January 15
 *  - Time: 3pm / 3:30pm / 15:00 (parsed first in the English version; the Chinese version uses the shared core's TIME_RE)
 */
const EN_MONTHS = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 }
const EN_WEEK = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }
function parseEnglishDate (text, base) {
  let restText = text
  let date = null
  let label = ''

  // Step 1: strip English time words from text first (recording into h/min/hasTime)
  // This lets later "date + time" combos (e.g. tomorrow 3pm) reuse the same logic
  let h = 0, min = 0, hasTime = false
  let datePart = text
  const m12a = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (m12a) {
    h = parseInt(m12a[1], 10)
    min = m12a[2] != null ? parseInt(m12a[2], 10) : 0
    const pm = /pm/i.test(m12a[3])
    if (pm && h < 12) h += 12
    if (!pm && h === 12) h = 0
    hasTime = true
    datePart = text.replace(m12a[0], '').trim()
    restText = datePart
  } else {
    const m24a = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
    if (m24a) {
      h = parseInt(m24a[1], 10)
      min = parseInt(m24a[2], 10)
      hasTime = true
      datePart = text.replace(m24a[0], '').trim()
      restText = datePart
    }
  }

  // Step 2: parse the date from datePart (time already stripped)
  const lc = datePart.toLowerCase()
  // Relative days (before week, avoiding conflict between today and thursday)
  if (/^today$|^\btonight\b/.test(lc)) { date = base.startOf('day'); label = 'today' }
  else if (/^tomorrow$/.test(lc)) { date = base.add(1, 'day').startOf('day'); label = 'tomorrow' }
  else if (/^yesterday$/.test(lc)) { date = base.subtract(1, 'day').startOf('day'); label = 'yesterday' }
  // +Nd compact syntax (CLI-friendly)
  else if (/^[+-]\d+[dwm]$/.test(lc)) {
    const sign = lc[0] === '-' ? -1 : 1
    const absN = Math.abs(parseInt(lc, 10))
    const u = lc.slice(-1)
    const n = sign * absN
    if (u === 'd') date = base.add(n, 'day').startOf('day')
    else if (u === 'w') date = base.add(n, 'week').startOf('day')
    else if (u === 'm') date = base.add(n, 'month').startOf('day')
    label = lc
  }
  // in N days/weeks/months/years
  else {
    let m = lc.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/)
    if (m) {
      const n = parseInt(m[1], 10)
      const u = m[2].toLowerCase()
      const unit = u.startsWith('day') ? 'day' : u.startsWith('week') ? 'week' : u.startsWith('month') ? 'month' : 'year'
      date = base.add(n, unit).startOf('day')
      label = m[0]
    } else {
      // Full numeric dates YYYY-MM-DD / YYYY/M/D / YYYY.M.D
      m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?=\b|$)/)
      if (m) {
        const y = +m[1]; const mo = +m[2]; const d = +m[3]
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= base.year(y).month(mo - 1).daysInMonth()) {
          date = base.year(y).month(mo - 1).date(d).startOf('day')
          label = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        }
      } else {
        // Jan 15 / January 15 / Jan 15 2026 / Jan 15, 2026
        m = lc.match(/^([a-z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?/)
        if (m) {
          const mo = EN_MONTHS[m[1]]
          const d = +m[2]
          const y = m[3] ? +m[3] : base.year()
          if (mo != null && d >= 1 && d <= base.year(y).month(mo).daysInMonth()) {
            date = base.year(y).month(mo).date(d).startOf('day')
            label = `${m[1]} ${d}${m[3] ? ' ' + m[3] : ''}`
          }
        } else {
          // on/this/next <weekday>
          m = lc.match(/^(?:on\s+|this\s+|next\s+)?(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/)
          if (m) {
            const targetDow = EN_WEEK[m[1]]
            const baseDow = base.day() // 0=Sun
            let diff = (targetDow - baseDow + 7) % 7
            // on <weekday> defaults to next week; this <weekday> this week (next week if already past); next <weekday> always next week
            const isNext = lc.startsWith('next ')
            const isOn = lc.startsWith('on ')
            const isThis = lc.startsWith('this ')
            // Bare weekday (no prefix) defaults to on = next occurrence
            if (isOn || (!isThis && !isNext)) diff = diff === 0 ? 7 : diff
            else if (isNext) diff = diff === 0 ? 7 : diff
            else if (isThis && diff === 0) diff = 7
            date = base.add(diff, 'day').startOf('day')
            label = m[0]
          } else if (/^this\s+weekend$|^weekend$/.test(lc)) {
            // This Saturday (0-6 days from now)
            const baseDow = base.day()
            const diff = (6 - baseDow + 7) % 7
            date = base.add(diff || 7, 'day').startOf('day')
            label = 'weekend'
          }
        }
      }
    }
  }

  // Time was already extracted in step 1; below only applies h/min onto date

  if (!date) return { date: null, label: '', restText: text }
  if (hasTime) {
    if (h > 23 || min > 59) return { date, label, restText: text }
    let d = date.hour(h).minute(min).second(0)
    // Explicit time given: already past → roll forward one day (consistent with the Chinese version)
    if (d.isBefore(base)) d = d.add(1, 'day')
    date = d
    label = (label ? label + ' ' : '') + `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  }
  return { date, label, restText: restText || text }
}

/**
 * Public entry — dispatches Chinese input to the shared core (single source
 * with the CLI) and English input to the renderer-only branch above.
 * Bilingual Chinese/English NL expressions supported:
 *   Chinese (shared core): 今天 (today)/明天 (tomorrow)/后天 (day after tomorrow)/大后天/N天后 (in N days)/下周X (next week X)/本周X (this week X)/周末 (weekend)/M月D日 (Month-Day)/YYYY-MM-DD etc.
 *   English (renderer-only): today/tomorrow/yesterday/tonight/this monday/next monday/in N days/+Nd/this week/on Mon/Jan 15/2026-01-15 etc.
 */
export function parseNaturalDate (text, base = dayjs()) {
  const raw = String(text || '').trim()
  if (!raw) return { date: null, label: '', restText: '' }
  // English branch: check if purely English / Latin letters clearly outnumber Chinese first (avoids misjudging "今天" = today)
  const hasLatin = /[A-Za-z]/.test(raw)
  const hasCJK = /[一-鿿]/.test(raw)
  if (hasLatin && !hasCJK) {
    return parseEnglishDate(raw, base)
  }
  // Chinese path: shared core; the full-date label format stays locale-aware via FMT.cnFull
  return parseChineseNaturalDate(raw, base, FMT.cnFull)
}
