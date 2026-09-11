/**
 * Natural-language DATE parsing core — the Chinese rule set shared verbatim by
 * the CLI (cli/nl-date.cjs) and the renderer (renderer/js/utils/nlDate.js).
 * Extracted to kill the dual implementation (architecture review item 5): the
 * two copies used to be kept in sync only by comments and drifted.
 *
 * Format: ESM (.mjs), dependency-free and pure — no DOM/window, no i18n, no
 * dayjs import. CJS consumers (the CLI) load it via require(esm), supported
 * since Node 22.12 (CI pins node 22; Electron 39 embeds node 22.x).
 *
 * Extraction boundary:
 *   SHARED (this file):
 *     - Chinese numeral conversion (cnToNum), regex fragments, week table
 *     - parseDateCore: the Chinese date rule set (今天/明天/后天/N天后/N周后/
 *       下X周Y/本周Y/周末/今年..X月X日/M月D日/YYYY-MM-DD/YYYY年M月D日),
 *       including calendar-validity rejects (Feb 30, month 13) and
 *       isoWeek-based 本周 semantics (base must come from an isoWeek-extended
 *       dayjs — consumers extend their own instance)
 *     - TIME_RE + applyChineseTime (parseChineseNaturalDate): time-of-day
 *       phrase composition ("周五下午3点" → date + 15:00, passed time rolls
 *       to tomorrow)
 *   RENDERER-ONLY (renderer/js/utils/nlDate.js): the English NL branch
 *     (parseEnglishDate) and the Chinese/English dispatch — kept on the
 *     renderer side because the CLI does not need it.
 *   CALLER-SUPPLIED: `base` (an isoWeek-extended dayjs instance; required)
 *     and cnFullFormat — the renderer's FMT.cnFull is locale-aware
 *     ('YYYY年M月D日' vs 'MMM D, YYYY'), the CLI pins the Chinese format.
 */

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
 * Parse a date from text; returns {date: dayjs|null, label: matched fragment, restText: text with the date words removed}
 * base: required, isoWeek-extended dayjs instance. cnFullFormat: dayjs format for the full-date label (caller-supplied, see header).
 */
function parseDateCore (text, base, cnFullFormat = 'YYYY年M月D日') {
  const raw = String(text || '')
  const trimmed = raw.trim()

  // Full numeric date YYYY-MM-DD / YYYY.M.D / YYYY/M/D / YYYY年M月D日 (the whole string must be that format to be consumed)
  let m = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!m) m = trimmed.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]$/)
  if (m) {
    // Calendar validity: reject carry-over dates like Feb 30 (dayjs setters silently carry)
    const yy = +m[1]; const mm = +m[2]; const dd = +m[3]
    if (mm < 1 || mm > 12 || dd < 1 || dd > base.year(yy).month(mm - 1).daysInMonth()) return { date: null, label: '', restText: trimmed }
    const d = base.year(yy).month(mm - 1).date(dd)
    return { date: d.startOf('day'), label: d.format(cnFullFormat), restText: '' }
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

  // 下X周Y / 本周Y
  m = trimmed.match(/^(下下|下|本|这个|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/)
  if (m) {
    const weekOffset = { '下': 1, '下下': 2 }[m[1]] || 0
    const target = WEEK_CN[m[2]]
    const cur = base.isoWeekday()
    let diff = target - cur + 7 * weekOffset
    // Bare "周X" (no prefix) defaults to the future one: a negative diff rolls forward a week, avoiding "Friday said on Sunday" creating an already-past task
    if (m[1] == null && diff < 0) diff += 7
    // "本周" semantics follow isoWeek (Monday starts the week): "本周一" said on Sunday refers to this week's past Monday (diff<0 rolls back),
    // it must not +7 into next week — "下周X" is expressed independently by the weekOffset=1 branch
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

  // 今年/明年/后年/大后年 X月X日 (year may be omitted)
  let yearWord = null; let yOff = 0
  for (const [w, o] of [['大后年', 3], ['后年', 2], ['明年', 1], ['今年', 0]]) {
    if (trimmed.indexOf(w) !== -1) { yearWord = w; yOff = o; break }
  }
  m = trimmed.match(new RegExp(`${NUM_RE}\\s*月\\s*${NUM_RE}\\s*[日号]`))
  if (m && yearWord) {
    // Only hits when the text starts with "今年/明年..." or the phrase stands alone
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
      // Calendar validity: dayjs setters carry out-of-range values (Feb 30 → Mar 2), validate and reject first
      // The month must be validated too: "13月5日" would be silently carried by month(12) into January of the next year (same defect family as Feb 30)
      if (mo < 1 || mo > 12) return { date: null, label: '', restText: trimmed }
      const days = base.month(Math.max(0, mo - 1)).daysInMonth()
      if (da < 1 || da > days) return { date: null, label: '', restText: trimmed } // signature consistent with other branches
      let target = base.month(mo - 1).date(da)
      // A past month/day rolls to next year (e.g. entering "3月5日" in August)
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

/** Time-of-day phrase: "(上午|下午|晚上…)? X点[半|Y分]" / "HH:MM" */
const TIME_RE = /(上午|早上|凌晨|中午|下午|午后|晚上|今晚)?\s*(\d{1,2})[点时:：]\s*(半|[0-5]?\d)?\s*分?/

/**
 * Public entry: core date parsing + time-of-day phrase extraction ("周五下午3点" → date + 15:00)
 * A time match with no date words → today (rolls to tomorrow if the time already passed)
 * base: required, isoWeek-extended dayjs. cnFullFormat: caller-supplied label format for full dates (see header).
 */
function parseChineseNaturalDate (text, base, cnFullFormat = 'YYYY年M月D日') {
  const core = parseDateCore(text, base, cnFullFormat)
  const scope = core.restText || String(text || '')
  const m = scope.match(TIME_RE)
  if (!m) return core
  let h = parseInt(m[2], 10)
  const min = m[3] === '半' ? 30 : (m[3] != null ? parseInt(m[3], 10) : 0)
  if (Number.isNaN(h) || h > 23 || Number.isNaN(min) || min > 59) return core
  const period = m[1]
  if ((period === '下午' || period === '午后' || period === '晚上') && h < 12) h += 12
  // 中午1点 = 13:00 (not forced to 12:00); 中午11/12点 keep the original hour
  if (period === '中午' && h >= 1 && h <= 3) h += 12
  const date = core.date ? core.date.hour(h).minute(min).second(0) : (function () {
    let d = base.hour(h).minute(min).second(0)
    if (d.isBefore(base)) d = d.add(1, 'day') // time-only and already passed → roll to tomorrow
    return d
  })()
  return {
    date,
    label: (core.label ? core.label + ' ' : '') + `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    restText: scope.replace(m[0], '').trim()
  }
}

export { parseChineseNaturalDate, parseDateCore, cnToNum, TIME_RE }
