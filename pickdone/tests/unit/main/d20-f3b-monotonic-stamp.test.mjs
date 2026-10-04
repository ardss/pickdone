import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f3b-mono-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f3b-mono-ud-'))
const require2 = createRequire(import.meta.url)
const db = require2('../../../src/main/db.js')
test('F3b regression: two same-millisecond filter edits still advance updatedAt (monotonic stamp)', () => {
  db.init(process.env.TODO_DB_DIR)
  const realNow = Date.now
  const frozen = 1_700_000_000_000
  Date.now = () => frozen
  try {
    const id = db.call('filterUpsert', { name: 'mono', conds: { dateMode: 'all' }, sort: 0 })
    const before = db.call('filterList', {}).find(x => x.id === id).updatedAt
    db.call('filterUpsert', { id, name: 'mono-2', conds: { dateMode: 'all' }, sort: 0 })
    const mid = db.call('filterList', {}).find(x => x.id === id).updatedAt
    db.call('filterUpsert', { id, name: 'mono-3', conds: { dateMode: 'all' }, sort: 0 })
    const after = db.call('filterList', {}).find(x => x.id === id).updatedAt
    assert.ok(mid > before, 'same-ms edit #1 advances the stamp')
    assert.ok(after > mid, 'same-ms edit #2 advances the stamp again')
  } finally { Date.now = realNow }
})
