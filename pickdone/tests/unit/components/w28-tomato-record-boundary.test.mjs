/**
 * W28 maintenance wave (2026-11-01) — TomatoFocusRecordModal dayRecords boundary fix (P3).
 *
 * The filter `e > start && e < end` was left-exclusive: a record whose endTime is exactly the
 * next-day midnight (a session running across 00:00 and ending at 00:00 sharp) matched NEITHER
 * day — the previous day dropped it via `e < end`, the selected day excluded it via `e > start`.
 * Fixed to the same [start, end) half-open caliber statistics/metrics.js already uses
 * (metrics.js:75 `endTs < start || endTs >= end` — inclusive left endpoint), so only the modal
 * needed changing.
 *
 * The computed is extracted from the .vue source and evaluated against a fake `vm` with the real
 * todayBounds.dayShift — behavioral, not string-matching.
 *
 * Run: node --test tests/unit/components/w28-tomato-record-boundary.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import '../../setup.mjs' // window.dayjs shims for renderer-module imports

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { dayShift } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/todayBounds.js')).href)

const src = readFileSync(path.join(ROOT, 'renderer/js/components/TomatoFocusRecordModal.vue'), 'utf8')
const m = src.match(/    dayRecords \(\) \{[\s\S]*?\n    \},/)
assert.ok(m, 'dayRecords computed found')
const dayRecords = new Function('dayShift', 'return {\n' + m[0] + '\n}')(dayShift).dayRecords

// 2020-07-15 selected day; nextMid = 2020-07-16 00:00 local
const day0 = +new Date(2020, 6, 15)
const nextMid = dayShift(day0, 1)

test('[w28.6] a record ending exactly at next-day 00:00 is visible on the day containing its end midnight (old code excluded it from BOTH days)', () => {
  const recs = [
    { tomatoId: 'spans-midnight', startTime: day0 + 3600000, endTime: nextMid }, // runs across 00:00, ends 00:00 sharp
    { tomatoId: 'fully-inside', startTime: day0 + 3600000, endTime: day0 + 7200000 },
    { tomatoId: 'later', startTime: nextMid + 3600000, endTime: nextMid + 7200000 }
  ]
  // Next day's window is [nextMid, +1d): the midnight-ending record is its left endpoint —
  // old `e > start` dropped it here, and the previous day's window dropped it via `e < end`.
  const vmNext = { records: recs, selDayStart: nextMid }
  const ids = dayRecords.call(vmNext).map(r => r.tomatoId)
  assert.ok(ids.includes('spans-midnight'), 'endTime == window start must appear (old `e > start` excluded it from BOTH days)')
  assert.ok(ids.includes('later'))
  assert.ok(!ids.includes('fully-inside'), 'the prior day\'s fully-inside record stays out of the next day')
})

test('[w28.6] the midnight-ending record does NOT double-report on the PREVIOUS day ([start, end) right-exclusive)', () => {
  const rec = { tomatoId: 'spans-midnight', startTime: day0 + 3600000, endTime: nextMid }
  const prevDay = { records: [rec], selDayStart: day0 }
  assert.equal(dayRecords.call(prevDay).length, 0, 'endTime == window end of the prior day must not re-appear there')
})

test('[w28.6] sort order (end time descending) is preserved by the fixed filter', () => {
  const recs = [
    { tomatoId: 'a', startTime: day0, endTime: day0 + 3600000 },
    { tomatoId: 'b', startTime: day0, endTime: day0 + 7200000 }
  ]
  assert.deepEqual(dayRecords.call({ records: recs, selDayStart: day0 }).map(r => r.tomatoId), ['b', 'a'])
})
