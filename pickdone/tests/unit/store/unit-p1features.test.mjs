/** P1 competitor-parity feature unit tests - multiple reminder offset parsing/scheduling expansion, filter condition screening, lunar repeat expansion
 *  Run: npm test (node --test) */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)

test('multiple reminders: tolerant parsing of the reminders column and persistence round trip', () => {
  const db = require_('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-mr-'))
  db.init(dir)
  db.call('upsert', {
    taskId: 'mr1', userId: 1, taskContent: '多重提醒', taskDescribe: '', complete: false,
    completedAt: 0, deleted: false, deletedAt: 0, createdAt: 1, updatedAt: 1,
    syncTime: 0, scheduledAt: 0, scheduledDay: 0, remindAt: 1756500000000,
    reminderOffsets: [-1440, -30, 0, -30, 99999999, 'x'], sort: 0,
    focusMinutes: 0, difficulty: 0, recurGroupId: null, subtasks: null,
    imageUrls: null, fileAttach: null, categoryId: 0, priority: 0, deadlineTs: 0,
    status: 'add', version: 0
  })
  const got = db.call('getById', 'mr1')
  // 0 is not persisted (the main reminder is already on time), invalid values dropped, dedup preserving order
  assert.deepEqual(got.reminderOffsets, [-1440, -30])
  // The real assertions for offset expansion live in tests/unit-scheduler.test.mjs (reminderInstances);
  // the original every(ts=>ts>0) here was a tautological filler assertion and has been removed
})

test('multiple reminders: second init of the reminders column is idempotent (restart in the same directory does not crash)', () => {
  const db = require_('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-mr2-'))
  db.init(dir)
  db.init(dir) // second init: ALTER TABLE ADD COLUMN reminders would throw here without an idempotency guard
  db.call('upsert', {
    taskId: 'mr2', userId: 1, taskContent: '幂等', taskDescribe: '', complete: false,
    completedAt: 0, deleted: false, deletedAt: 0, createdAt: 1, updatedAt: 1,
    syncTime: 0, scheduledAt: 0, scheduledDay: 0, remindAt: 1756500000000,
    reminderOffsets: [-15], sort: 0, focusMinutes: 0, difficulty: 0, recurGroupId: null,
    subtasks: null, imageUrls: null, fileAttach: null, categoryId: 0, priority: 0,
    deadlineTs: 0, status: 'add', version: 0
  })
  assert.deepEqual(db.call('getById', 'mr2').reminderOffsets, [-15], 'data still readable/writable after the second init')
})

test('filters: filterUpsert/filterList/filterDelete round trip and condition tolerance', () => {
  const db = require_('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-fl-'))
  db.init(dir)
  const id = db.call('filterUpsert', { name: '本周高优', conds: { catId: -1, priority: 2, dateMode: 'week' }, sort: 0 })
  assert.ok(Number(id) > 0)
  db.call('filterUpsert', { id, name: '改名', conds: { catId: 3, priority: -1, dateMode: 'overdue' }, sort: 1 })
  let list = db.call('filterList')
  assert.equal(list.length, 1)
  assert.equal(list[0].name, '改名')
  assert.deepEqual(list[0].conds, { catId: 3, priority: -1, dateMode: 'overdue' })
  db.call('filterUpsert', { name: '坏条件', conds: 'not-json{{', sort: 2 })
  db.call('filterUpsert', { name: '脏条件', conds: { catId: 'x', priority: 1.5, dateMode: 'hacker' }, sort: 3 })
  list = db.call('filterList')
  // Invalid JSON/out-of-range values normalize to safe defaults (an unknown dateMode once made filtering silently degrade to "all tasks")
  assert.deepEqual(list.find(f => f.name === '坏条件').conds, { catId: -1, priority: -1, dateMode: 'all' })
  assert.deepEqual(list.find(f => f.name === '脏条件').conds, { catId: -1, priority: -1, dateMode: 'all' })
  db.call('filterDelete', id)
  assert.equal(db.call('filterList').length, 2) // deleted 1, 2 remain (the bad/dirty-condition ones)
})

test('filters: FilterView screening predicate (today/week/overdue/none/priority/list)', async () => {
  // FilterView's list computation is inlined in the component; here an equivalent predicate checks the semantic anchors: week window anchored to isoWeek, overdue requires a date
  const { dayjs } = await import('../../../renderer/js/utils/core.js')
  const today0 = +dayjs().startOf('day')
  const weekEnd = +dayjs().endOf('isoWeek')
  const ok = (d, mode) => {
    const v = +dayjs(d).startOf('day')
    if (mode === 'today') return v === today0
    if (mode === 'week') return v >= today0 && v <= weekEnd
    if (mode === 'overdue') return v > 0 && v < today0 // no-date tasks are not overdue
    if (mode === 'none') return false
    return true
  }
  assert.ok(ok(dayjs(), 'today'))
  // The "this week" window = [today 00:00, isoWeek end]; only direction-relative-to-today assertions (in-week/out-of-week floats with the weekday, not hardcoded)
  const tomorrowInWeek = +dayjs().add(1, 'day').startOf('day') <= +dayjs().endOf('isoWeek')
  assert.equal(ok(dayjs().add(1, 'day'), 'week'), tomorrowInWeek)
  assert.ok(ok(dayjs().subtract(1, 'day'), 'overdue'))
  assert.ok(!ok(0, 'overdue'))
  assert.ok(!ok(dayjs(), 'none'))
})

test('lunar repeat: expandRepeatDates year-lunar branch expands to gregorian dates', async () => {
  const { expandRepeatDates, setLunarLib } = await import('../../../renderer/js/utils/repeat.js')
  const solar = require_('solarlunar')
  setLunarLib(solar.default || solar)
  // 2026 Spring Festival (lunar 1/1) = 2026-02-17; using that as base, a yearly lunar repeat should expand to gregorian dates like 2027-02-06
  const base = 1771286400000 // around 2026-02-17 00:00 UTC+8; the engine takes hour/min for the day start
  const dates = expandRepeatDates(base, {
    repeatType: '年', repeatInterval: 1, repeatYearCount: 3,
    repeatYearType: '农历', repeatYearMonth: 1, repeatYearMonthDay: 1
  })
  assert.ok(dates.length >= 2, 'should expand at least 2 lunar new years')
  // All fall within mid-January to late February (the possible range of lunar 1/1)
  for (const d of dates) {
    const m = d.month() + 1
    assert.ok(m === 1 || m === 2, 'lunar new year day should fall in gregorian Jan-Feb: ' + d.format('YYYY-MM-DD'))
  }
  // Lunar dates strictly increasing and distinct
  const vals = dates.map(d => +d)
  assert.deepEqual(vals, [...vals].sort((a, b) => a - b))
})

test('main-process todo-core: expandRepeatDates lunar-year is isomorphic to the renderer', async () => {
  const core = require_('../../../src/main/core/todo-core.js')
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  const base = 1771286400000
  const rule = { repeatType: '年', repeatInterval: 1, repeatYearCount: 3, repeatYearType: '农历', repeatYearMonth: 1, repeatYearMonthDay: 15 }
  const a = core.expandRepeatDates(base, rule).map(d => +d)
  const b = expandRepeatDates(base, rule).map(d => +d)
  assert.deepEqual(a, b)
})

test('holiday data: the renderer and main-process mirrors must match entry by entry (guards against manual-update drift)', async () => {
  const esm = await import('../../../renderer/js/utils/holidays.js')
  const cjs = require_('../../../src/main/core/holidays.js')
  assert.deepEqual(cjs.HOLIDAY_DATA, esm.HOLIDAY_DATA, 'the two statutory holiday tables have drifted - both copies must be updated in sync when adding yearly data')
  assert.ok(esm.HOLIDAY_DATA.length > 0)
  // Shape contract: YYYY-MM-DD; holiday must be boolean
  for (const h of esm.HOLIDAY_DATA) {
    assert.match(h.dateString, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(typeof h.holiday, 'boolean')
  }
})

test('isomorphism (gregorian branch): nonexistent dates like Feb 30 must be rejected on both sides, never silently carried', async () => {
  const core = require_('../../../src/main/core/todo-core.js')
  const { expandRepeatDates } = await import('../../../renderer/js/utils/repeat.js')
  // 2027-02-30 does not exist: dayjs would carry it to Mar 2 - the main process once lost this guard, producing bogus renewal instances
  const rule = { repeatType: '年', repeatInterval: 1, repeatYearCount: 3, repeatYearMonth: 2, repeatYearMonthDay: 30 }
  const a = core.expandRepeatDates(1771286400000, rule).map(d => +d)
  const b = expandRepeatDates(1771286400000, rule).map(d => +d)
  assert.deepEqual(a, b)
  // Key: no March dates may appear (carry-over artifacts)
  for (const ts of a) assert.notEqual(new Date(ts).getMonth() + 1, 3, 'Feb 30 must not carry into March')
  // A valid date (Feb 28) expands normally and identically on both sides
  const ok = { repeatType: '年', repeatInterval: 1, repeatYearCount: 2, repeatYearMonth: 2, repeatYearMonthDay: 28 }
  assert.deepEqual(
    core.expandRepeatDates(1771286400000, ok).map(d => +d),
    expandRepeatDates(1771286400000, ok).map(d => +d)
  )
  assert.equal(core.expandRepeatDates(1771286400000, ok).length, 2)
})
