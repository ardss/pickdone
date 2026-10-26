/** W10 (2026-10-26) — English NL date phrases must match ANYWHERE in the text, not only at ^.
 *  Previously every step-2 pattern anchored at the start of the time-stripped text, so
 *  "meeting tomorrow" parsed no date and "meeting tomorrow 3pm" fell into the time-only
 *  fallback: silently scheduled TODAY at 15:00 with "meeting tomorrow" left in the title.
 *  The Chinese single-source (shared/nl-date-core.mjs relative loop) already matched date
 *  words anywhere — these tests pin the mirrored fix in parseEnglishDate.
 *  Run: node --test tests/unit/dates/w10-nl-en-unanchored.test.mjs */
import { test } from '../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'
import '../../setup.mjs'
import { parseNaturalDate } from '../../../renderer/js/utils/nlDate.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

/** Fixed base 2026-09-15 (Tuesday); asserts all relative-day computations */
const base = dayjs('2026-09-15T12:00:00')

function p (text) { return parseNaturalDate(text, base) }

test('W10 date words mid-text: "meeting tomorrow"', () => {
  const r = p('meeting tomorrow')
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(r.label, 'tomorrow')
  assert.equal(r.restText, 'meeting', 'date words removed from the title (shared contract)')
})

test('W10 date+time mid-text: "meeting tomorrow 3pm" no longer falls back to today 15:00', () => {
  const r = p('meeting tomorrow 3pm')
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-16', 'the date phrase wins over the time-only today fallback')
  assert.equal(r.date.format('HH:mm'), '15:00')
  assert.equal(r.label, 'tomorrow 15:00')
  assert.equal(r.restText, 'meeting', 'both date and time words removed')
})

test('W10 prefixed weekday mid-text: "call mom next monday"', () => {
  const r = p('call mom next monday')
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-21', 'next monday from Tuesday 2026-09-15 = 2026-09-21 (prefix read from the matched span)')
  assert.equal(r.restText, 'call mom')
})

test('W10 unanchored in N days / relative syntax still intact', () => {
  const r = p('submit report in 2 days')
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-09-17')
  assert.equal(r.restText, 'submit report')
  const bare = p('tomorrow')
  assert.equal(bare.date.format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(bare.restText, '', 'pure-date input keeps the empty-restText contract')
})

test('W10 unanchored mid-text: compact +Nd, numeric full date, month-day', () => {
  const r1 = p('standup +1d')
  assert.equal(r1.date.format('YYYY-MM-DD'), '2026-09-16')
  assert.equal(r1.restText, 'standup')
  const r2 = p('review doc 2026-01-15 please')
  assert.equal(r2.date.format('YYYY-MM-DD'), '2026-01-15', 'numeric full date matches datePart unanchored')
  assert.equal(r2.label, '2026-01-15')
  assert.equal(r2.restText, 'review doc please')
  const r3 = p('dentist jan 20')
  assert.equal(r3.date.format('YYYY-MM-DD'), '2027-01-20', 'bare Jan 20 past 2026 base rolls to 2027 (rule unchanged)')
  assert.equal(r3.restText, 'dentist')
})

test('W10 no-date control strings still parse to null (no accidental matches)', () => {
  for (const text of ['buy milk', 'random words only']) {
    const r = p(text)
    assert.equal(r.date, null, `"${text}" has no date`)
    assert.equal(r.label, '')
    assert.equal(r.restText, text, 'untouched restText for date-less input')
  }
})
