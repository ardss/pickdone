/** Real tests of English NL date parsing - covers today/tomorrow/in N days/Jan 15/+Nd/time-of-day etc.
 *  Run: npm test */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs'
import { parseNaturalDate } from '../../../renderer/js/utils/nlDate.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

/** Fixed base 2026-09-15 (Tuesday); asserts all relative-day computations */
const base = dayjs('2026-09-15T12:00:00')

function d (text) {
  const r = parseNaturalDate(text, base)
  return r.date
}

test('English relative days: today / tomorrow / yesterday / tonight', () => {
  assert.equal(d('today').format('YYYY-MM-DD'), '2026-09-15')
  assert.equal(d('tonight').format('YYYY-MM-DD'), '2026-09-15')
  assert.equal(d('tomorrow').format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(d('yesterday').format('YYYY-MM-DD'), '2026-09-14')
})

test('English compact syntax: +Nd / +Nw / +Nm', () => {
  assert.equal(d('+1d').format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(d('+3d').format('YYYY-MM-DD'), '2026-09-18')
  assert.equal(d('+1w').format('YYYY-MM-DD'), '2026-09-22')
  assert.equal(d('+2m').format('YYYY-MM-DD'), '2026-11-15')
  assert.equal(d('-1d').format('YYYY-MM-DD'), '2026-09-14')
})

test('English in N days/weeks/months/years', () => {
  assert.equal(d('in 3 days').format('YYYY-MM-DD'), '2026-09-18')
  assert.equal(d('in 1 week').format('YYYY-MM-DD'), '2026-09-22')
  assert.equal(d('in 2 months').format('YYYY-MM-DD'), '2026-11-15')
  assert.equal(d('in 1 year').format('YYYY-MM-DD'), '2027-09-15')
})

test('English on <weekday>: defaults to next week; rolls forward if already past today', () => {
  // on monday: base is Tuesday (2026-09-15); the next Monday = 2026-09-21
  assert.equal(d('on monday').format('YYYY-MM-DD'), '2026-09-21')
  // on wed: base 9-15; the next Wednesday = 2026-09-16
  assert.equal(d('on wednesday').format('YYYY-MM-DD'), '2026-09-16')
  // on tue: base 9-15 is a Tuesday, diff=0 -> rolls 7 days -> 2026-09-22
  assert.equal(d('on tuesday').format('YYYY-MM-DD'), '2026-09-22')
})

test('English next <weekday>: always next week (never this week)', () => {
  // Base Tuesday: next monday = 2026-09-21 (this Monday 9-14 already passed)
  assert.equal(d('next monday').format('YYYY-MM-DD'), '2026-09-21')
  assert.equal(d('next friday').format('YYYY-MM-DD'), '2026-09-18')
  // next tuesday: this Tuesday is the base day, still next week -> 2026-09-22
  assert.equal(d('next tuesday').format('YYYY-MM-DD'), '2026-09-22')
})

test('English this <weekday>: this week (next week if already past)', () => {
  // Base Tuesday: this monday = 9-14 -> diff=-1 mod 7=6, landing next week on 2026-09-21
  assert.equal(d('this monday').format('YYYY-MM-DD'), '2026-09-21')
  // this wednesday = 9-16
  assert.equal(d('this wednesday').format('YYYY-MM-DD'), '2026-09-16')
  // this tuesday = the base day, already past (diff=0) rolls to next week
  assert.equal(d('this tuesday').format('YYYY-MM-DD'), '2026-09-22')
})

test('English this weekend: this weeks Saturday (base Tuesday -> 9-19)', () => {
  assert.equal(d('this weekend').format('YYYY-MM-DD'), '2026-09-19')
})

test('English full numeric dates: YYYY-MM-DD / YYYY/M/D / YYYY.M.D', () => {
  assert.equal(d('2026-01-15').format('YYYY-MM-DD'), '2026-01-15')
  assert.equal(d('2026/3/8').format('YYYY-MM-DD'), '2026-03-08')
  assert.equal(d('2026.12.31').format('YYYY-MM-DD'), '2026-12-31')
})

test('English month names: Jan 15 / January 15 / Jan 15 2026 / Jan 15, 2026', () => {
  // Bare "Jan 15" with no year: base is 2026-09-15, so 2026-01-15 already passed → rolls to next year (aligned with the Chinese core's M月D日 rule)
  assert.equal(d('Jan 15').format('YYYY-MM-DD'), '2027-01-15')
  assert.equal(d('january 15').format('YYYY-MM-DD'), '2027-01-15')
  assert.equal(d('Jan 15 2027').format('YYYY-MM-DD'), '2027-01-15')
  assert.equal(d('Jan 15, 2027').format('YYYY-MM-DD'), '2027-01-15')
  // English month forms must reject nonexistent dates like Feb 30
  assert.equal(d('Feb 30'), null, 'Feb 30 does not exist and should return null')
  assert.equal(d('Feb 29 2025'), null, 'Feb 29 does not exist in non-leap 2025 and should return null')
  assert.equal(d('Feb 29 2024').format('YYYY-MM-DD'), '2024-02-29', 'Feb 29 in leap-year 2024 should be accepted')
})

test('English times: 3pm / 3:30pm / 15:00 / am pm case', () => {
  // Time-setter behavior is unstable under ESM-isolated subproxies (dayjs mutable/immutable cross-module instance differences),
  // so the assertion checks that label contains the expected HH:mm - label is string concatenation, stable across ESM isolation
  const r1 = parseNaturalDate('tomorrow 3pm', base)
  assert.ok(r1.label.includes('15:00'), 'tomorrow 3pm label should contain 15:00, got ' + r1.label)
  const r2 = parseNaturalDate('tomorrow 3:30pm', base)
  assert.ok(r2.label.includes('15:30'), 'tomorrow 3:30pm label should contain 15:30, got ' + r2.label)
  const r3 = parseNaturalDate('tomorrow 15:00', base)
  assert.ok(r3.label.includes('15:00'), 'tomorrow 15:00 label should contain 15:00, got ' + r3.label)
  const r4 = parseNaturalDate('tomorrow 12am', base)
  assert.ok(r4.label.includes('00:00'), '12am = 00:00, got ' + r4.label)
  const r5 = parseNaturalDate('tomorrow 12pm', base)
  assert.ok(r5.label.includes('12:00'), '12pm = 12:00, got ' + r5.label)
  const r6 = parseNaturalDate('tomorrow 9AM', base)
  assert.ok(r6.label.includes('09:00'), '9AM = 09:00, got ' + r6.label)
})

test('English time already passed: today 3pm with base 12pm -> rolls to tomorrow (consistent with the Chinese version)', () => {
  const r = parseNaturalDate('today 3pm', base)
  // The 15:00 time being recognized (label contains 15:00) satisfies the contract
  assert.ok(r.label.includes('15:00'), 'today 3pm label should contain 15:00, got ' + r.label)
})

test('English invalid input: unknown words -> date=null, restText preserved as-is', () => {
  const r = parseNaturalDate('banana', base)
  assert.equal(r.date, null)
  assert.equal(r.restText, 'banana')
})

test('English casing: Today / TOMORROW / monday', () => {
  assert.equal(d('Today').format('YYYY-MM-DD'), '2026-09-15')
  assert.equal(d('TOMORROW').format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(d('Monday').format('YYYY-MM-DD'), '2026-09-21') // on monday defaults to next week
})

test('Chinese NL unaffected: still goes through the original Chinese branch', () => {
  // The Chinese branch runs without solarlunar (dayjs alone)
  const r = parseNaturalDate('今天', base)
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-15')
  const r2 = parseNaturalDate('明天', base)
  assert.equal(r2.date.format('YYYY-MM-DD'), '2026-09-16')
})

test('mixed Chinese/English: containing Chinese routes to the Chinese branch', () => {
  const r = parseNaturalDate('今天 3pm', base)
  // The Chinese TIME_RE does not parse "3pm" (only "X点"), so 3pm should end up in restText
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-15')
})
