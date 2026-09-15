/* H2 fix #4 regression: todoToRow must sanitize taskDescribe (control chars/RTL overrides removed,
   truncated at 5000) like taskContent — the raw description reached CLI list/audit terminal output.
   Run: node --test tests/unit/main/h2-describe-sanitize.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const { todoToRow } = require_('../../../src/main/db-rows.js')

test('taskDescribe: control chars and RTL overrides are stripped', () => {
  const row = todoToRow({ taskId: 't', taskDescribe: 'a\u202Eevil\u001B[31m\u200Fb' })
  assert.equal(row.description, 'aevil[31mb')
})

test('taskDescribe: collapsed whitespace and 5000-char truncation', () => {
  const row = todoToRow({ taskId: 't', taskDescribe: 'a\n\n\t b' })
  assert.equal(row.description, 'a b')
  const long = todoToRow({ taskId: 't', taskDescribe: 'x'.repeat(6000) })
  assert.equal(long.description.length, 5000)
})

test('taskDescribe: null stays null; plain text round-trips unchanged', () => {
  assert.equal(todoToRow({ taskId: 't', taskDescribe: null }).description, null)
  assert.equal(todoToRow({ taskId: 't' }).description, null)
  assert.equal(todoToRow({ taskId: 't', taskDescribe: 'plain text' }).description, 'plain text')
})
