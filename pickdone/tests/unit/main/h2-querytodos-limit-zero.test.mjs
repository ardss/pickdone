/* H2 fix #2 regression: queryTodos limit=0 must fail closed (LIMIT 0), not fail-open to unlimited.
   Previous `if (limit)` treated 0 as "no limit" while negatives threw — inconsistent validation.
   Run: node --test tests/unit/main/h2-querytodos-limit-zero.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-limit-zero-'))
db.init(dir)

for (let i = 0; i < 5; i++) {
  db.call('upsert', { taskId: 'lim_' + i, taskContent: 't' + i, complete: false, delete: false })
}

test('limit=0 returns zero rows (fail closed), not unlimited', () => {
  assert.equal(db.call('queryTodos', { limit: 0 }).length, 0)
})

test('limit=null/undefined stay unlimited; positive limit still truncates', () => {
  assert.equal(db.call('queryTodos', {}).length, 5)
  assert.equal(db.call('queryTodos', { limit: null }).length, 5)
  assert.equal(db.call('queryTodos', { limit: 3 }).length, 3)
})

test('negative and non-finite limit still throw', () => {
  assert.throws(() => db.call('queryTodos', { limit: -1 }), /非法 limit/)
  assert.throws(() => db.call('queryTodos', { limit: 'abc' }), /非法 limit/)
})
