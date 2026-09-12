/** Round-7 H1 regression: English/Chinese bilingual boundary fixes in nlDate.js
 *  - English time-only ("3pm"/"15:00") lands on today with past-rolls-to-tomorrow (parity with "3点")
 *  - Bare "Jan 15" already past rolls to next year (parity with "1月15日")
 *  - Mixed CJK+Latin input ("明天3pm") keeps the English time phrase instead of dropping it
 *  Run: node --test tests/unit/dates/h7-bilingual-boundaries.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs'
import { parseNaturalDate } from '../../../renderer/js/utils/nlDate.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

/** Fixed base 2026-09-15 (Tuesday) 12:00 — matches the existing suite's base */
const base = dayjs('2026-09-15T12:00:00')

function d (text) {
  const r = parseNaturalDate(text, base)
  return r.date
}

test('EN time-only lands on today (parity with Chinese "3点")', () => {
  // 15:00 is after base 12:00 → today, not null
  assert.equal(d('3pm').format('YYYY-MM-DD'), '2026-09-15')
  assert.equal(d('15:00').format('YYYY-MM-DD'), '2026-09-15')
  // Parity: the Chinese "下午3点" (same 15:00 wall time) also lands on today
  assert.equal(d('下午3点').format('YYYY-MM-DD'), '2026-09-15')
  const en = parseNaturalDate('9am', base)
  const cn = parseNaturalDate('9点', base)
  assert.equal(en.date.format('YYYY-MM-DD HH:mm'), '2026-09-16 09:00')
  assert.equal(cn.date.format('YYYY-MM-DD HH:mm'), '2026-09-16 09:00')
})

test('EN time-only already passed rolls to tomorrow (parity with Chinese)', () => {
  // base 12:00 → 9am/09:00 already passed → 2026-09-16
  assert.equal(d('9am').format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(d('09:00').format('YYYY-MM-DD'), '2026-09-16')
})

test('Bare "Jan 15" already past rolls to next year (parity with "1月15日")', () => {
  // base 2026-09-15: 2026-01-15 passed → 2027-01-15
  assert.equal(d('Jan 15').format('YYYY-MM-DD'), '2027-01-15')
  // Parity: Chinese M月D日 does the same
  assert.equal(d('1月15日').format('YYYY-MM-DD'), '2027-01-15')
  // A future bare month-day in the same year does NOT roll
  assert.equal(d('Dec 25').format('YYYY-MM-DD'), '2026-12-25')
  assert.equal(d('12月25日').format('YYYY-MM-DD'), '2026-12-25')
  // Explicit year pins the year regardless
  assert.equal(d('Jan 15 2026').format('YYYY-MM-DD'), '2026-01-15')
})

test('Mixed CJK+Latin input keeps the English time phrase ("明天3pm")', () => {
  const r = parseNaturalDate('明天3pm', base)
  assert.ok(r.date, 'mixed input should parse')
  // tomorrow = 2026-09-16, 3pm = 15:00 (after base 12:00, no roll needed)
  assert.equal(r.date.format('YYYY-MM-DD HH:mm'), '2026-09-16 15:00')
  assert.ok(r.label.includes('15:00'), 'label should contain the time, got ' + r.label)
})

test('Mixed CJK+Latin input with a passed English time rolls to next day', () => {
  // "明天9am" = 2026-09-16 09:00 is not before base... use "今天9am": today 09:00 passed → tomorrow
  const r = parseNaturalDate('今天9am', base)
  assert.equal(r.date.format('YYYY-MM-DD HH:mm'), '2026-09-16 09:00')
})

test('Mixed CJK+Latin 24h time and 周X combos', () => {
  const r1 = parseNaturalDate('周五15:00', base)
  // 周五 bare = next Friday = 2026-09-18
  assert.equal(r1.date.format('YYYY-MM-DD HH:mm'), '2026-09-18 15:00')
  const r2 = parseNaturalDate('明天 3:30pm 买菜', base)
  assert.equal(r2.date.format('YYYY-MM-DD HH:mm'), '2026-09-16 15:30')
  assert.ok(r2.restText.includes('买菜'), 'leftover text preserved, got ' + r2.restText)
})
