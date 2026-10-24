/**
 * f1 wave — shared core fixes (2026-10-19): shared/repeat-core.mjs + shared/nl-date-core.mjs.
 *
 *  1. yearly repeat Feb-29 rule clamps to Feb 28 in non-leap years (was: whole year vanished)
 *  2. dirty week/month ranges defended: wd 0/8 excluded from week expansion; md=0 clamps to day 1
 *     (was: date(0) minted the PREVIOUS month's last day)
 *  3. "今年2月30日"/"今年13月5日" rejected by the year-prefixed M月D日 branch (was: silently
 *     carried into Mar 2 / next-year Jan)
 *  4. "1个月后" clamps to the target month's last day (was: Jan 31 + 1 month carried into Mar 2/3)
 *  5. 晚上12点 = 00:00 midnight, not 12:00 noon
 *  6. 廿/卅 numerals parsed ("廿三号" → 23, "卅一" → 31)
 *
 * Run: node --test tests/unit/dates/f1-shared-core-fixes-20261019.test.mjs
 */
import '../../setup.mjs'
import { test } from '../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import { expandRepeatDates } from '../../../shared/repeat-core.mjs'
import { parseDateCore, parseChineseNaturalDate, cnToNum } from '../../../shared/nl-date-core.mjs'

const dayjs = globalThis.window.dayjs
const dj = t => dayjs(t)

test('fix1: yearly Feb-29 repeat clamps to Feb 28 in non-leap years (no vanished years)', () => {
  const base = +dj(new Date(2027, 0, 15, 9, 0)) // 2027-2029 span, 2028 leap
  const rule = { repeatType: 'year', repeatInterval: 1, repeatYearCount: 3, repeatYearType: 'gregorian', repeatYearMonth: 2, repeatYearMonthDay: 29 }
  const dates = expandRepeatDates(base, rule, [], { dayjs }).map(d => d.format('YYYY-MM-DD'))
  assert.deepEqual(dates, ['2027-02-28', '2028-02-29', '2029-02-28'],
    'each year must yield exactly one instance; only the leap year keeps the 29th')
})

test('fix2a: dirty weekday values (0/8) are excluded, no extra cross-week instances', () => {
  const base = +dj(new Date(2026, 9, 19, 9, 0)) // Monday 2026-10-19
  const rule = { repeatType: 'week', repeatInterval: 1, repeatWeekCount: 2, repeatWeekDays: [0, 1, 3, 8] }
  const dates = expandRepeatDates(base, rule, [], { dayjs })
  assert.equal(dates.length, 4, '2 weeks x 2 valid weekdays (Mon/Wed) only')
  for (const d of dates) {
    const wd = d.isoWeekday()
    assert.ok(wd === 1 || wd === 3, `got weekday ${wd}, must be Mon or Wed: ${d.format('YYYY-MM-DD')}`)
  }
})

test('fix2b: md=0 clamps to day 1, not the previous month\u2019s last day', () => {
  const base = +dj(new Date(2026, 9, 19, 9, 0)) // 2026-10-19
  const rule = { repeatType: 'month', repeatInterval: 1, repeatMonthCount: 4, repeatMonthDays: [0] }
  const dates = expandRepeatDates(base, rule, [], { dayjs }).map(d => d.format('YYYY-MM-DD'))
  assert.deepEqual(dates, ['2026-11-01', '2026-12-01', '2027-01-01'],
    'date(0) previously landed on 09-30/10-31 (previous month\u2019s last day)')
})

test('fix3: year-prefixed invalid dates are rejected, not carried (今年2月30日 → no date)', () => {
  const base = dj(new Date(2026, 7, 28, 10, 0))
  for (const text of ['今年2月30日买菜', '明年13月5日开会', '今年4月31日']) {
    const r = parseDateCore(text, base)
    assert.equal(r.date, null, `"${text}" must not silently carry`)
    assert.equal(r.restText, text, 'the whole text must fall back as restText')
  }
  // valid year-prefixed dates still parse
  const ok = parseDateCore('今年3月5日买菜', base)
  assert.equal(+ok.date, +new Date(2026, 2, 5))
  // leap-year-aware validity: 今年2月29日 in 2026 (non-leap) rejected
  assert.equal(parseDateCore('今年2月29日', base).date, null)
  // 明年2月29日 from 2026 → 2027, non-leap → also rejected
  assert.equal(parseDateCore('明年2月29日', base).date, null)
})

test('fix4: "1个月后" from Jan 31 clamps to Feb 28/29 (no carry into March)', () => {
  assert.equal(+parseChineseNaturalDate('1个月后', dj(new Date(2026, 0, 31, 10, 0))).date, +new Date(2026, 1, 28))
  assert.equal(+parseChineseNaturalDate('1个月后', dj(new Date(2027, 0, 31, 10, 0))).date, +new Date(2027, 1, 28))
  assert.equal(+parseChineseNaturalDate('3个月后', dj(new Date(2026, 0, 31, 10, 0))).date, +new Date(2026, 3, 30))
  // normal months unaffected
  assert.equal(+parseChineseNaturalDate('1个月后', dj(new Date(2026, 0, 15, 10, 0))).date, +new Date(2026, 1, 15))
})

test('fix5: 晚上12点 = midnight 00:00, not noon', () => {
  const base = dj(new Date(2026, 7, 28, 10, 0))
  const r = parseChineseNaturalDate('晚上12点', base)
  assert.equal(r.date.hour(), 0)
  assert.equal(r.date.minute(), 0)
  // anchored to a date phrase it still lands on midnight of that day
  const r2 = parseChineseNaturalDate('明天晚上12点半', base)
  assert.equal(+r2.date, +new Date(2026, 7, 29, 0, 30))
  // 晚上11点 keeps the 23:00 mapping
  assert.equal(parseChineseNaturalDate('晚上11点', base).date.hour(), 23)
  // 下午12点 stays noon (unchanged semantics, only evening hours remap)
  assert.equal(parseChineseNaturalDate('下午12点', base).date.hour(), 12)
})

test('fix6: 廿/卅 numerals parse (廿三号 → 23, 卅一 → 31)', () => {
  assert.equal(cnToNum('廿'), 20)
  assert.equal(cnToNum('廿三'), 23)
  assert.equal(cnToNum('卅'), 30)
  assert.equal(cnToNum('卅一'), 31)
  const base = dj(new Date(2026, 1, 10, 10, 0)) // 2026-02-10, so 3月 rolls forward, not past
  const r = parseChineseNaturalDate('3月廿三号', base)
  assert.equal(+r.date, +new Date(2026, 2, 23))
  assert.equal(r.restText, '')
  const r2 = parseChineseNaturalDate('3月卅一号', base)
  assert.equal(+r2.date, +new Date(2026, 2, 31))
})
