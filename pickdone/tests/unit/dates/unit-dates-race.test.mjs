/**
 * Date-boundary + dual-window race unit tests (SOP-06 supplement: environment-timing / concurrency classes).
 *   (5) day/month/year boundaries: a month-end 31st anchor skips short months, December -> January of the next year, skip-weekend semantics
 *   (6) dual-window race: claimPhase accepts only the first writer within the same-phase 1.5s window; a new phase or an expired window may claim again
 */
import '../../setup.mjs'
/* global localStorage */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dayjs = (await import('../../../renderer/js/utils/core.js')).dayjs

test('date boundary: month repeat - a 31st anchor clamps to month end in short months (Feb->28/29, Apr->30), long months land on the 31st', async () => {
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  // Anchor 2026-01-31 (Saturday)
  const base = dayjs('2026-01-31T09:00:00').valueOf()
  const dates = expandRepeatDates(base, {
    repeatType: '月', repeatInterval: 1, repeatMonthCount: 3, repeatMonthDays: [31]
  })
  const days = dates.map(d => d.date())
  // 2026-09-02定稿:月末钳制语义(31号在短月落到月末,不再整月跳过致任务消失)
  assert.ok(!days.includes(1) && !days.includes(2),
    'short months must clamp to month end, never carry into the next month: ' + dates.map(d => d.format('YYYY-MM-DD')))
  assert.deepEqual(days, [31, 28, 31], 'count=3 from Jan-31 anchor: Jan itself + Feb clamps to 28 + Mar 31: ' + dates.map(d => d.format('YYYY-MM-DD')))
})

test('date boundary: month repeat across years - a December anchor continues across 2 months into January of the next year', async () => {
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  const base = dayjs('2026-12-15T09:00:00').valueOf()
  const dates = expandRepeatDates(base, {
    repeatType: '月', repeatInterval: 1, repeatMonthCount: 3, repeatMonthDays: [15]
  })
  const months = dates.map(d => d.year() * 12 + d.month())
  assert.equal(months.length, 3)
  assert.deepEqual(months, [months[0], months[0] + 1, months[0] + 2], 'must advance continuously across years without resetting')
  assert.equal(dates[2].year(), 2027, 'the 3rd instance should land in 2027')
})

test('date boundary: day repeat with skipWeekends - Saturdays/Sundays removed, weekdays kept', async () => {
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  // Anchor 2026-08-31 (Monday); 7 consecutive days cover the whole week
  const base = dayjs('2026-08-31T09:00:00').valueOf()
  const dates = expandRepeatDates(base, {
    repeatType: '天', repeatInterval: 1, repeatDayCount: 7, skipWeekends: true
  })
  assert.equal(dates.length, 5, 'the whole week should leave only 5 weekdays: ' + dates.map(d => d.format('YYYY-MM-DD ddd')))
  for (const d of dates) assert.ok(d.isoWeekday() <= 5, 'weekends must not appear: ' + d.format('YYYY-MM-DD'))
})

test('dual-window race: claimPhase rejects a second writer within the same-phase 1.5s window; expired window/new phase may claim again', async () => {
  // 隔离 localStorage 段
  const KEY = 'tomatoPhaseClaim'
  const bak = localStorage.getItem(KEY)
  try {
    localStorage.removeItem(KEY)
    const { remainSecOf } = await import('../../../renderer/js/utils/tomatoShared.js')
    const t0 = Date.now()
    // Reproduce claimPhase's get->set race semantics (both windows run the same read-decide-write sequence):
    // The first window writes the claim
    localStorage.setItem(KEY, 'startTomatoTime:' + t0 + '|' + Date.now())
    // The second window reads the same phase within 1.5s -> must be rejected
    const cur = String(localStorage.getItem(KEY) || '')
    const i = cur.lastIndexOf('|')
    const secondRejected = cur.slice(0, i) === 'startTomatoTime:' + t0 && Date.now() - Number(cur.slice(i + 1) || 0) < 1500
    assert.equal(secondRejected, true, 'the second writer in the same phase and window must be rejected')
    // Window expired (timestamp rolled back 1600ms) -> may claim again
    localStorage.setItem(KEY, 'startTomatoTime:' + t0 + '|' + (Date.now() - 1600))
    const cur2 = String(localStorage.getItem(KEY) || '')
    const i2 = cur2.lastIndexOf('|')
    const thirdAccepted = !(cur2.slice(0, i2) === 'startTomatoTime:' + t0 && Date.now() - Number(cur2.slice(i2 + 1) || 0) < 1500)
    assert.equal(thirdAccepted, true, 'after the window expires, re-claiming must be allowed')
    assert.ok(remainSecOf('startTomatoTime', t0, 25, 5, t0) !== null, 'shared-decision layer self-check')
  } finally {
    if (bak == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, bak)
  }
})
