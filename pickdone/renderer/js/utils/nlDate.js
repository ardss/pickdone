import { FMT } from './core.js'
/**
 * Natural-language date parsing — rules from the project spec analysis
 * Supports: today/tomorrow/day after tomorrow/three days from now, "in N days", N weeks/months/years from now, next-X-week/this-week-X, weekend,
 *       this year/next year/year after/year after next M月D日 (Month-Day), YYYY年M月D日 (full Chinese date), YYYY-MM-DD, M月D日, etc., including Chinese numerals
 */
import { dayjs } from './core.js'

const CN_NUM = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }

function cnToNum (t) {
  if (t == null || t === '') return NaN
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  const chars = t.split('')
  const tenIdx = chars.indexOf('十')
  if (tenIdx === -1) {
    let acc = NaN
    for (const c of chars) {
      const v = CN_NUM[c]
      if (v === undefined) return NaN
      acc = Number.isNaN(acc) ? v : acc * 10 + v
    }
    return acc
  }
  const before = t.slice(0, tenIdx); const after = t.slice(tenIdx + 1)
  const b = before === '' ? 1 : CN_NUM[before]
  const a = after === '' ? 0 : CN_NUM[after]
  if (b === undefined || a === undefined) return NaN
  return 10 * b + a
}

const NUM_RE = '(\\d{1,4}|[零〇一二两三四五六七八九十]{1,3})'
const WEEK_CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 }

/**
 * Parses a date from text; returns {date: dayjs|null, label: matched fragment, restText: text with the date words removed}
 */
function parseDateCore (text, base = dayjs()) {
  const raw = String(text || '')
  const trimmed = raw.trim()

  // Full numeric dates YYYY-MM-DD / YYYY.M.D / YYYY/M/D / YYYY年M月D日 (Chinese full date; consumed only when the whole segment matches this format)
  let m = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!m) m = trimmed.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]$/)
  if (m) {
    // Calendar validity: reject carry-over dates like "Feb 30" (dayjs setters carry over silently)
    const yy = +m[1]; const mm = +m[2]; const dd = +m[3]
    if (mm < 1 || mm > 12 || dd < 1 || dd > base.year(yy).month(mm - 1).daysInMonth()) return { date: null, label: '', restText: trimmed }
    const d = base.year(yy).month(mm - 1).date(dd)
    return { date: d.startOf('day'), label: d.format(FMT.cnFull), restText: '' }
  }

  // Chinese relative expressions
  const relative = [
    { re: /大后天/, add: 3, label: '大后天' },
    { re: /后天/, add: 2, label: '后天' },
    { re: /明天|明日/, add: 1, label: '明天' },
    { re: /今天|今日/, add: 0, label: '今天' }
  ]
  for (const r of relative) {
    if (r.re.test(trimmed)) {
      return {
        date: base.add(r.add, 'day').startOf('day'),
        label: r.label,
        restText: trimmed.replace(r.re, '').trim()
      }
    }
  }

  m = trimmed.match(new RegExp(`^${NUM_RE}\\s*天(?:以)?后`))
  if (m) {
    const n = cnToNum(m[1])
    if (!Number.isNaN(n)) {
      return { date: base.add(n, 'day').startOf('day'), label: `${n}天后`, restText: trimmed.slice(m[0].length).trim() }
    }
  }

  m = trimmed.match(new RegExp(`^${NUM_RE}\\s*(?:个)?(?:周|星期|礼拜)(?:以)?后`))
  if (m) {
    const n = cnToNum(m[1])
    if (!Number.isNaN(n)) {
      return { date: base.add(7 * n, 'day').startOf('day'), label: `${n}周后`, restText: trimmed.slice(m[0].length).trim() }
    }
  }

  m = trimmed.match(new RegExp(`^${NUM_RE}\\s*(?:个)?月(?:以)?后`))
  if (m) {
    const n = cnToNum(m[1])
    if (!Number.isNaN(n)) {
      return { date: base.add(n, 'month').startOf('day'), label: `${n}个月后`, restText: trimmed.slice(m[0].length).trim() }
    }
  }

  // 下X周Y / 本周Y (week X of next week / week X of this week)
  m = trimmed.match(/^(下下|下|本|这个|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/)
  if (m) {
    const weekOffset = { '下': 1, '下下': 2 }[m[1]] || 0
    const target = WEEK_CN[m[2]]
    const cur = base.isoWeekday()
    let diff = target - cur + 7 * weekOffset
    // Bare "周X" (no prefix) defaults to the future occurrence for users: roll a negative diff forward one week, so saying "周五" on "周日" doesn't create an already-expired task
    if (m[1] == null && diff < 0) diff += 7
    // "本周" semantics follow isoWeek (Monday is the first day of the week): saying "本周一" on Sunday refers to this week's already-past Monday (diff<0 goes backward),
    // never +7 into next week — "下周X" is expressed independently by the weekOffset=1 branch
    const prefix = m[1] === '下' ? '下周' : (m[1] === '下下' ? '下下周' : '本周')
    return {
      date: base.add(diff, 'day').startOf('day'),
      label: `${prefix}${m[2]}`,
      restText: trimmed.slice(m[0].length).trim()
    }
  }

  // Weekend
  if (/^(这|本|这个)?周末/.test(trimmed)) {
    const off = 6 - base.isoWeekday()
    return {
      date: base.add(off >= 0 ? off : off + 7, 'day').startOf('day'),
      label: '周末',
      restText: trimmed.replace(/^(这|本|这个)?周末/, '').trim()
    }
  }

  // 今年/明年/后年/大后年 M月D日 (year optional)
  let yearWord = null; let yOff = 0
  for (const [w, o] of [['大后年', 3], ['后年', 2], ['明年', 1], ['今年', 0]]) {
    if (trimmed.indexOf(w) !== -1) { yearWord = w; yOff = o; break }
  }
  m = trimmed.match(new RegExp(`${NUM_RE}\\s*月\\s*${NUM_RE}\\s*[日号]`))
  if (m && yearWord) {
    // Only matches when the text starts with "今年/明年..." or the phrase stands alone
    const mo = cnToNum(m[1]); const da = cnToNum(m[2])
    if (!Number.isNaN(mo) && !Number.isNaN(da)) {
      const target = base.year(base.year() + yOff).month(mo - 1).date(da)
      return {
        date: target.startOf('day'),
        label: (yearWord || '') + `${mo}月${da}日`,
        restText: trimmed.replace(yearWord || '', '').replace(m[0], '').trim()
      }
    }
  }

  // M月D日 (standalone)
  m = trimmed.match(new RegExp(`^${NUM_RE}\\s*月\\s*${NUM_RE}\\s*[日号]$`))
  if (m) {
    const mo = cnToNum(m[1]); const da = cnToNum(m[2])
    if (!Number.isNaN(mo) && !Number.isNaN(da)) {
      // Calendar validity: dayjs setters carry out-of-range values (Feb 30 → Mar 2); validate and reject first
      // Month must also be validated: "month 13, day 5" would be silently carried by month(12) into January of next year (same defect family as Feb 30)
      if (mo < 1 || mo > 12) return { date: null, label: '', restText: trimmed }
      const days = base.month(Math.max(0, mo - 1)).daysInMonth()
      if (da < 1 || da > days) return { date: null, label: '', restText: trimmed } // signature consistent with other branches
      let target = base.month(mo - 1).date(da)
      // Past month/day rolls over to next year (e.g. entering "March 5" in August)
      if (target.isBefore(base, 'day')) target = target.add(1, 'year')
      return {
        date: target.startOf('day'),
        label: `${mo}月${da}日`,
        restText: ''
      }
    }
  }

  return { date: null, label: '', restText: trimmed }
}

/** Time-of-day phrase: "(morning|afternoon|evening…)? X o'clock[half|Y minutes]" / "HH:MM" */
const TIME_RE = /(上午|早上|凌晨|中午|下午|午后|晚上|今晚)?\s*(\d{1,2})[点时:：]\s*(半|[0-5]?\d)?\s*分?/

/**
 * Public entry: core date parsing + time-of-day phrase extraction ("周五下午3点" → date+15:00 / "next monday 3pm" → date+15:00)
 * No date word but time matched → lands on today (rolls to tomorrow if the time has passed)
 * Bilingual Chinese/English NL expressions supported:
 *   Chinese: 今天 (today)/明天 (tomorrow)/后天 (day after tomorrow)/大后天/N天后 (in N days)/下周X (next week X)/本周X (this week X)/周末 (weekend)/M月D日 (Month-Day)/YYYY-MM-DD etc.
 *   English: today/tomorrow/yesterday/tonight/this monday/next monday/in N days/+Nd/this week/on Mon/Jan 15/2026-01-15 etc.
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
  const core = parseDateCore(raw, base)
  const scope = core.restText || raw
  const m = scope.match(TIME_RE)
  if (!m) return core
  let h = parseInt(m[2], 10)
  const min = m[3] === '半' ? 30 : (m[3] != null ? parseInt(m[3], 10) : 0)
  if (Number.isNaN(h) || h > 23 || Number.isNaN(min) || min > 59) return core
  const period = m[1]
  if ((period === '下午' || period === '午后' || period === '晚上') && h < 12) h += 12
  // "noon 1 o'clock" = 13:00 (not forced to 12:00); "noon 11/12" keep the original hour
  if (period === '中午' && h >= 1 && h <= 3) h += 12
  const date = core.date ? core.date.hour(h).minute(min).second(0) : (function () {
    let d = base.hour(h).minute(min).second(0)
    if (d.isBefore(base)) d = d.add(1, 'day') // time-only and already past → roll to tomorrow
    return d
  })()
  return {
    date,
    label: (core.label ? core.label + ' ' : '') + `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    restText: scope.replace(m[0], '').trim()
  }
}

/** English NL parsing:
 *  - today / tonight / tomorrow / yesterday
 *  - this monday / next monday / on monday / on mon (defaults to next occurrence; rolls a week if today's has passed)
 *  - this weekend (= Saturday)
 *  - in 3 days / in 1 week / in 2 months
 *  - +Nd / +Nw / +Nm (CLI-friendly syntax, reuses dayjs.add)
 *  - 2026-01-15 / 2026/1/15 / Jan 15 / Jan 15, 2026 / January 15
 *  - Time: 3pm / 3:30pm / 15:00 (parsed first in the English version; the Chinese version uses the original TIME_RE)
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

