/**
 * Integration supplement - the main-process/CLI shared semantics core todo-core (CJS, single reference implementation) + db.js OPS gaps.
 * todo-core is the single reference for renderer+CLI write semantics, at the highest regression risk, so it needs full coverage.
 * Run: npm test
 */
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-core-'))
const require_ = createRequire(import.meta.url)
const core = require_('../src/main/core/todo-core.js')
const db = require_('../src/main/db.js')

const BASE = new Date(2026, 7, 28).getTime() // Friday

/* ---------- genTaskId / completePatch ---------- */

test('todo-core: genTaskId prefix and random segment', () => {
  const a = core.genTaskId('u1', 1000)
  assert.ok(a.startsWith('tid_u1') && a.endsWith('_1000'))
  assert.notEqual(core.genTaskId('u1', 1000), a)
})

test('todo-core: completePatch - completion time + subtask cascade', () => {
  const p1 = core.completePatch({ taskId: 't', subtasks: '[]' })
  assert.equal(p1.complete, true)
  assert.ok(p1.completedAt > 0)

  const subs = JSON.stringify([{ text: 'a', checked: false }, { text: 'b', checked: true }])
  const p2 = core.completePatch({ taskId: 't', subtasks: subs })
  const after = JSON.parse(p2.subtasks)
  assert.ok(after.every(s => s.checked), 'unchecked subtasks should be cascade-checked')

  // withSubtasks=false leaves subtasks untouched
  const p3 = core.completePatch({ taskId: 't', subtasks: subs }, { withSubtasks: false })
  assert.equal(p3.subtasks, undefined)

  // Already all-checked is not rewritten
  const allDone = JSON.stringify([{ text: 'a', checked: true }])
  assert.equal(core.completePatch({ taskId: 't', subtasks: allDone }).subtasks, undefined)

  // Bad JSON does not throw
  const p4 = core.completePatch({ taskId: 't', subtasks: '{bad' })
  assert.equal(p4.complete, true)
  assert.equal(p4.subtasks, undefined)
})

/* ---------- expandRepeatDates: skipping/ordering/month/year ---------- */

test('todo-core: day rule + skipWeekends outputs only weekdays in ascending order', () => {
  const out = core.expandRepeatDates(BASE, { repeatType: '天', repeatInterval: 1, repeatDayCount: 7, skipWeekends: true })
  assert.ok(out.length >= 5)
  for (let i = 1; i < out.length; i++) assert.ok(+out[i] > +out[i - 1], 'output must be ascending')
  assert.ok(out.every(d => d.isoWeekday() <= 5), 'weekends must not appear')
})

test('todo-core: week rule generates per repeatWeekDays, ascending', () => {
  const out = core.expandRepeatDates(BASE, { repeatType: '周', repeatInterval: 1, repeatWeekCount: 2, repeatWeekDays: [1, 3] })
  assert.ok(out.length >= 2)
  for (let i = 1; i < out.length; i++) assert.ok(+out[i] > +out[i - 1], '输出必须升序')
  const days = new Set(out.map(d => d.isoWeekday()))
  for (const d of days) assert.ok([1, 3].includes(d), `instance weekday ${d} is not within repeatWeekDays`)
})

test('todo-core: month rule lands on the repeatMonthDays day', () => {
  const out = core.expandRepeatDates(BASE, { repeatType: '月', repeatInterval: 1, repeatMonthDays: [15], repeatMonthCount: 3 })
  assert.ok(out.length >= 2)
  for (const d of out) assert.equal(new Date(+d).getDate(), 15)
})

test('todo-core: year rule advances year by year', () => {
  const out = core.expandRepeatDates(BASE, { repeatType: '年', repeatInterval: 1 })
  assert.ok(out.length >= 3)
  const years = out.map(d => new Date(+d).getFullYear())
  for (let i = 1; i < years.length; i++) assert.ok(years[i] > years[i - 1], 'years must increase')
})

/* ---------- nextRepeatInstance: repeat-group renewal ---------- */

test('todo-core: nextRepeatInstance - generates the next instance when the last one in the group completes', () => {
  const completed = { taskId: 'r1', todoTime: BASE, dayStart: BASE, repeatId: 'rid1' }
  // A later instance remains in the group -> no renewal
  const withFuture = [
    { taskId: 'r2', todoTime: BASE + 3 * 86400000, dayStart: BASE + 3 * 86400000, repeatId: 'rid1' }
  ]
  const rule = { repeatType: '天', repeatInterval: 1, repeatDayCount: 5 }
  const none = core.nextRepeatInstance(completed, withFuture, rule)
  assert.equal(none, null)

  // No later instance in the group -> renews to the next day
  const exhausted = [
    { taskId: 'r2', todoTime: BASE, dayStart: BASE, repeatId: 'rid1', complete: true }
  ]
  const next = core.nextRepeatInstance(completed, exhausted, rule)
  assert.ok(next, 'the next instance should be generated')
  const nd = new Date(+next.todoTime)
  assert.equal(nd.getFullYear(), 2026)
  assert.equal(nd.getMonth(), 7) // 0-based: August
  assert.equal(nd.getDate(), 29)
  assert.equal(next.reminderTime, 0, 'reminderTime is 0 when there is no reminder')

  // Multiple reminder offsets are inherited automatically across renewal (todo-core nextRepeatInstance returns reminderOffsets)
  const withOffsets = {
    taskId: 'r3', todoTime: BASE, dayStart: BASE, repeatId: 'rid1',
    reminderTime: BASE + 9 * 3600000, reminderOffsets: [-30, -1440]
  }
  const next2 = core.nextRepeatInstance(withOffsets, [{ taskId: 'r4', todoTime: BASE, dayStart: BASE, repeatId: 'rid1', complete: true }], rule)
  assert.ok(next2, 'a completion with reminders should also renew')
  assert.deepEqual(next2.reminderOffsets, [-30, -1440], 'offsets are inherited as-is to the next instance')
  assert.equal(next2.reminderTime, +new Date(2026, 7, 29, 9, 0, 0, 0), 'the reminder time is anchored to the same clock time on the new date')
})

/* ---------- db.js OPS gaps ---------- */

test('db: setMeta/getMeta round trip', () => {
  fs.mkdirSync(process.env.TODO_DB_DIR, { recursive: true })
  db.init(process.env.TODO_DB_DIR)
  db.call('setMeta', ['k-test', 'v1'])
  assert.equal(db.call('getMeta', 'k-test'), 'v1')
  db.call('setMeta', ['k-test', 'v2']) // setMeta has no delete semantics; String(null) overwrites
  assert.equal(db.call('getMeta', 'k-test'), 'v2')
})
