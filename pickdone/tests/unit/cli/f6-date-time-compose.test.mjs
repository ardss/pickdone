/** Round-6 fix F6-1 (P1): a Chinese absolute date followed by a time phrase used to silently drop the date.
 *  The `M月D日` branch in shared/nl-date-core.mjs anchored `$` on the day numeral, so "8月30日15:00" failed
 *  to match, parseDateCore returned date:null, and the time-only fallback landed the task on TODAY at 15:00.
 *  The date branch now also accepts a trailing time phrase (TIME_RE source folded into the match) and hands
 *  it back as restText so parseChineseNaturalDate composes date + time like "周五下午3点" already did.
 *  Also: bare `晚`/`今晚` period words now count as evening (晚10点 = 22:00, not 10:00).
 *  Guard cases pin the untouched behavior (52 pre-existing tests in tests/unit/dates stay green).
 *  Run: node --test tests/unit/cli/f6-date-time-compose.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { parseChineseNaturalDate } from '../../../shared/nl-date-core.mjs'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
try { dayjs.extend(require_('../../assets/vendor-lib/dayjs-plugin-isoWeek.js')) } catch { /* same degrade as the CLI shell */ }

// Fixed base so expectations are stable: Saturday 2026-09-12, 10:00 local
const base = dayjs('2026-09-12T10:00:00')
const fmt = r => (r.date ? r.date.format('YYYY-MM-DD HH:mm') : null)

test('f6-date: M月D日 + clock time keeps the date (8月30日15:00)', () => {
  const r = parseChineseNaturalDate('8月30日15:00', base)
  assert.equal(fmt(r), '2027-08-30 15:00', 'date parsed and rolled to next year, time applied — used to be today 15:00')
})

test('f6-date: M月D日 + 早上 period composes (9月20日早上8点)', () => {
  const r = parseChineseNaturalDate('9月20日早上8点', base)
  assert.equal(fmt(r), '2026-09-20 08:00', 'morning hour stays 08:00 on the parsed date')
})

test('f6-date: M月D日 + bare 晚 period counts as evening (12月1日晚10点)', () => {
  const r = parseChineseNaturalDate('12月1日晚10点', base)
  assert.equal(fmt(r), '2026-12-01 22:00', '晚10点 = 22:00 (was 10:00 — bare 晚 was not a period word)')
})

test('f6-date: date-only M月D日 unchanged by the fix', () => {
  const r = parseChineseNaturalDate('8月30日', base)
  assert.equal(fmt(r), '2027-08-30 00:00')
  assert.equal(r.restText, '')
})

test('f6-date: relative date + time composes as before (guard)', () => {
  const r = parseChineseNaturalDate('明天下午3点', base)
  assert.equal(fmt(r), '2026-09-13 15:00')
})

test('f6-date: calendar-invalid M月D日 still rejected (no carry-over March date)', () => {
  const r = parseChineseNaturalDate('2月30日', base)
  assert.equal(r.date, null, 'Feb 30 must not parse into a carry-over March date')
  assert.equal(r.label, '')
})

// ===== [J2 journey-audit 2026-10-22] M月D日 + content: the date must survive trailing content =====
// Was: the $-anchored branch missed "10月30日 交房租" entirely — date silently dropped, task
// created today with the date text left inside the title (quick-add audit evidence j2-0*.png).
test('j2-date: M月D日 + content keeps the date and strips it from the content', () => {
  const r = parseChineseNaturalDate('10月30日 交房租', base)
  assert.equal(fmt(r), '2026-10-30 00:00', 'date parsed (rolls past Sep 12 base into October, same year)')
  assert.equal(r.restText, '交房租', 'content is what remains after the date phrase')
})

test('j2-date: M月D日 + content without a space (no-space CJK writing)', () => {
  const r = parseChineseNaturalDate('10月30日交房租', base)
  assert.equal(fmt(r), '2026-10-30 00:00')
  assert.equal(r.restText, '交房租')
})

test('j2-date: M月D日 + time + content composes all three', () => {
  const r = parseChineseNaturalDate('10月30日15:00 交房租', base)
  assert.equal(fmt(r), '2026-10-30 15:00')
  assert.equal(r.restText, '交房租')
})

test('j2-date: mid-token digit continuation stays unmatched (guard)', () => {
  const r = parseChineseNaturalDate('10月30日100元', base)
  assert.equal(r.date, null, 'digit continuation must not silently split into a date')
  assert.equal(r.restText, '10月30日100元')
})

test('j2-date: date-only input still yields empty restText (guard)', () => {
  const r = parseChineseNaturalDate('10月30日', base)
  assert.equal(fmt(r), '2026-10-30 00:00')
  assert.equal(r.restText, '')
})
