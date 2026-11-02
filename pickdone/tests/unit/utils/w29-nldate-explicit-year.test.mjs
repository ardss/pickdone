/* w29 P3 regression: English NL date + explicit time roll-forward.
 *
 * Bug: with an explicit time ("3pm"), parseEnglishDate rolled the date forward one day whenever
 * the combined datetime was in the past — but (a) it never re-checked, and (b) it applied the
 * same roll to dates the user pinned with an EXPLICIT year, so "Jan 15 2020 3pm" was silently
 * re-dated to Jan 16 2020 (still in the past, AND no longer the date the user typed).
 *
 * Fix: an explicit year (YYYY-MM-DD numeric or "Mon D YYYY" / "Mon YYYY") is never rolled
 * forward; implicit dates keep the single corrective roll (kept even if base has moved past it
 * — one corrective roll max, no multi-day shifts).
 *
 * Run: node --test tests/unit/utils/w29-nldate-explicit-year.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs'

const { parseNaturalDate } = await import('../../../renderer/js/utils/nlDate.js')
const { dayjs } = await import('../../../renderer/js/utils/core.js')

// base = 2026-03-10 10:00 local — "3pm" alone would be future, "9am" past
const base = dayjs('2026-03-10 10:00:00')

test('P3: "Jan 15 2020 3pm" keeps the user\'s literal date (no roll-forward despite being past)', () => {
  const r = parseNaturalDate('Jan 15 2020 3pm', base)
  assert.ok(r.date, 'date parses')
  assert.equal(r.date.year(), 2020, 'explicit year preserved')
  assert.equal(r.date.month(), 0, 'January preserved')
  assert.equal(r.date.date(), 15, 'the 15th is NOT nudged to the 16th')
  assert.equal(r.date.hour(), 15, 'explicit time applied')
})

test('P3: numeric explicit year "2020-01-15 3pm" is likewise not re-dated', () => {
  const r = parseNaturalDate('2020-01-15 3pm', base)
  assert.ok(r.date, 'date parses')
  assert.equal(r.date.year(), 2020)
  assert.equal(r.date.month(), 0)
  assert.equal(r.date.date(), 15, 'explicit YYYY-MM-DD date word semantics untouched')
  assert.equal(r.date.hour(), 15)
})

test('P3: implicit date + past explicit time still rolls forward (e.g. "today 9am" typed at 10am)', () => {
  const r = parseNaturalDate('today 9am', base)
  assert.ok(r.date, 'date parses')
  assert.equal(r.date.date(), 11, 'rolls to tomorrow 9am')
  assert.equal(r.date.hour(), 9)
  assert.ok(!r.date.isBefore(base), 'implicit roll never lands in the past')
})

test('P3: bare "Jan 15 3pm" (no year) still year-rolls, then applies time without further nudging', () => {
  const r = parseNaturalDate('Jan 15 3pm', base)
  assert.ok(r.date, 'date parses')
  assert.equal(r.date.year(), 2027, 'bare Jan 15 already past in 2026 rolls to 2027 (existing rule)')
  assert.equal(r.date.month(), 0)
  assert.equal(r.date.date(), 15)
  assert.equal(r.date.hour(), 15)
})

test('P3: "tomorrow 3pm" (future date, future time) is untouched by the roll logic', () => {
  const r = parseNaturalDate('tomorrow 3pm', base)
  assert.equal(r.date.date(), 11)
  assert.equal(r.date.hour(), 15)
})
