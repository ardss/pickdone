/**
 * [maint/d26] Three data-layer fixes in one suite:
 *  - P2 edge: reminderExtra entries equal to the MAIN reminderTime double-fired (normAbs deduped
 *    only within extras; scheduler schedules main + extras under separate job keys). rowToTodo
 *    now drops extras equal to the main reminderTime at read time.
 *  - P3: `tomato status` printed a raw "undefined today" for legacy state blobs without
 *    todayTomatoCount / attach.content.
 *  - P3: a Todoist INDENT 2 row before any parent imported as a silent top-level task; it still
 *    imports top-level (no invented parenting) but the report now says so (orphanSub reason).
 * Run: node --test tests/unit/main/maint-d26-reminder-dedupe-cli-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const dbRows = require_('../../../src/main/db-rows.js')
const runTomato = require_('../../../cli/lib-tomato.cjs')
const importer = require_('../../../src/main/import/index.js')

/* ---------- rowToTodo: extras equal to the main reminder are dropped ---------- */

const T = new Date(2026, 9, 5, 9, 0).getTime()
const HOUR = 3600000

test('rowToTodo drops reminderExtra entries equal to the main reminderTime (no double fire)', () => {
  const row = {
    id: 't1', remindAt: T,
    reminders: JSON.stringify({ o: [-10], x: [T, T + HOUR] })
  }
  const todo = dbRows.rowToTodo(row)
  assert.equal(todo.reminderTime, T)
  assert.deepEqual(todo.reminderExtra, [T + HOUR], 'the duplicate main reminder is stripped, real extras stay')
  assert.deepEqual(todo.reminderOffsets, [-10])
})

test('rowToTodo keeps all extras when there is no main reminder', () => {
  const todo = dbRows.rowToTodo({
    id: 't2', remindAt: 0,
    reminders: JSON.stringify({ o: [], x: [T, T + HOUR] })
  })
  assert.deepEqual(todo.reminderExtra, [T, T + HOUR])
})

test('roundtrip stays echo-stable: pack(reminders) of the fixed todo re-parses identically', () => {
  const todo = dbRows.rowToTodo({ id: 't3', remindAt: T, reminders: JSON.stringify({ o: [], x: [T] }) })
  assert.deepEqual(todo.reminderExtra, [], 'nothing left after the dedupe')
  const again = dbRows.rowToTodo(dbRows.todoToRow({ taskId: 't3', remindAt: T, reminderTime: T, reminderExtra: [], reminderOffsets: [] }))
  assert.equal(again.reminderTime, T)
})

/* ---------- tomato status: legacy blobs must not print "undefined" ---------- */

async function captureLogs (fn) {
  const logs = []
  const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  try { await fn() } finally { console.log = orig }
  return logs.join('\n')
}

const makeLib = state => ({
  readTomatoState: () => state,
  tomatoLiveRemainSec: st => (st.remainSec != null ? st.remainSec : 0),
  CliError: class CliError extends Error { constructor (m, c) { super(m); this.code = c } }
})

test('tomato status renders 0 (not undefined) when the state blob lacks todayTomatoCount/attach', async () => {
  const out = await captureLogs(() => runTomato({ opts: { _: ['status'] }, lib: makeLib({ status: 'default', at: Date.now() }) }))
  assert.ok(!/undefined/.test(out), 'no raw undefined in output: ' + out)
  assert.ok(/0 today/.test(out), 'count defaults to 0: ' + out)
  assert.ok(!/attached/.test(out), 'no attached section without attach.content')
})

test('tomato status still renders a real count and attach content', async () => {
  const out = await captureLogs(() => runTomato({ opts: { _: ['status'] }, lib: makeLib({ status: 'default', at: Date.now(), todayTomatoCount: 3, attach: { content: 'task one' } }) }))
  assert.ok(/3 today/.test(out) && /attached: task one/.test(out), out)
})

test('tomato status guards attach without content', async () => {
  const out = await captureLogs(() => runTomato({ opts: { _: ['status'] }, lib: makeLib({ status: 'default', at: Date.now(), todayTomatoCount: 1, attach: {} }) }))
  assert.ok(!/undefined/.test(out), out)
})

/* ---------- Todoist import: orphan INDENT 2 row is flagged in the report ---------- */

test('orphan indent-2 row (no parent yet) imports top-level and is flagged in the items', () => {
  const csv = [
    'TYPE,CONTENT,PRIORITY,INDENT,checked',
    'task,orphan sub,p4,2,', // indent-2 BEFORE any parent task
    'task,real task,p1,1,'
  ].join('\n')
  const items = importer.rowsToItems(csv, 'todoist')
  assert.equal(items.length, 2, 'the parentless indent-2 row still imports (honest flatten)')
  assert.equal(items[0].title, 'orphan sub')
  assert.equal(items[0].orphanSub, true, 'the parentless indent-2 row is flagged, not silently flattened')
  assert.equal(items[1].orphanSub, undefined, 'a normal top-level row is unflagged')
})

test('a properly parented indent-2 row still becomes a subtask', () => {
  const csv = [
    'TYPE,CONTENT,PRIORITY,INDENT,checked',
    'task,real task,p1,1,',
    'task,real sub,p4,2,'
  ].join('\n')
  const items = importer.rowsToItems(csv, 'todoist')
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].subs, [{ text: 'real sub', checked: false }])
})
