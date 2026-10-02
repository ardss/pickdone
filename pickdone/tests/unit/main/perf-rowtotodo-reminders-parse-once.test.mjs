/* perf-rowtotodo-double-reminders-parse regression: rowToTodo used to parse r.reminders
   twice per row (parseOffsets -> parseReminders, then parseReminders again for .x).
   Fix hoists one parseReminders call. 2 rows with non-null reminders must trigger
   exactly 2 JSON.parse calls (fails with 4 on pre-fix code).
   Run: node --test tests/unit/main/perf-rowtotodo-reminders-parse-once.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const { rowToTodo } = require_('../../../src/main/db-rows.js')

test('rowToTodo parses r.reminders once per row', () => {
  const realParse = JSON.parse
  let count = 0
  JSON.parse = function (s, ...rest) { count++; return realParse(s, ...rest) }
  try {
    const r1 = rowToTodo({ id: 'a', reminders: JSON.stringify([10]) })
    const r2 = rowToTodo({ id: 'b', reminders: JSON.stringify({ o: [5], x: [1700000000000] }) })
    assert.equal(count, 2, `expected 2 JSON.parse calls for 2 rows, got ${count}`)
    assert.deepEqual(r1.reminderOffsets, [10])
    assert.deepEqual(r1.reminderExtra, [])
    assert.deepEqual(r2.reminderOffsets, [5])
    assert.deepEqual(r2.reminderExtra, [1700000000000])
  } finally {
    JSON.parse = realParse
  }
})

test('rowToTodo output unchanged for reminder-less and legacy rows', () => {
  const nullRow = rowToTodo({ id: 'c', reminders: null })
  assert.deepEqual(nullRow.reminderOffsets, [])
  assert.deepEqual(nullRow.reminderExtra, [])
  const junkRow = rowToTodo({ id: 'd', reminders: 'not json' })
  assert.deepEqual(junkRow.reminderOffsets, [])
  assert.deepEqual(junkRow.reminderExtra, [])
  const arrRow = rowToTodo({ id: 'e', reminders: '[15,30,15]' })
  assert.deepEqual(arrRow.reminderOffsets, [15, 30])
  assert.deepEqual(arrRow.reminderExtra, [])
})
