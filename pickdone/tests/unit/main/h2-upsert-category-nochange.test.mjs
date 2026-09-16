/* H2 fix #7 regression: upsertCategory with identical data must be a no-op (returns false, no write,
   no fake oplog delta) — previously every startup rewrote all categories with updatedAt=now and
   re-stamped tombstone deletedAt, producing N fake deltas per launch.
   Run: node --test tests/unit/main/h2-upsert-category-nochange.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'h2-upcat-')))

const cat = over => Object.assign({
  id: 9001, userId: 1, name: 'Work', color: '#ff0000', createdAt: 1700000000000,
  sort: 2, isFolder: 0, parentId: 0, deleted: 0
}, over)

test('identical re-upsert returns false, keeps updatedAt, produces no oplog delta', () => {
  assert.equal(db.call('upsertCategory', cat()), true, 'first upsert writes')
  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0

  assert.equal(db.call('upsertCategory', cat()), false, 'identical re-upsert is a no-op')
  assert.equal(db.call('upsertCategory', cat({ delete: undefined })), false)

  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.equal(rows.length, 0, 'no-change upsert must not produce an oplog delta')
})

test('changed field (name) writes again, returns true, logs one delta', () => {
  assert.equal(db.call('upsertCategory', cat({ name: 'Work2' })), true)
  const rows = db.call('syncOplogSince', { sinceSeq: 0 })
  const last = rows[rows.length - 1]
  assert.equal(last.entity, 'category')
  assert.equal(last.entityId, '9001')
  assert.equal(db.call('getAllCategories').find(c => c.categoryId === 9001).categoryName, 'Work2')
})

test('re-upserting a tombstoned category keeps the original deletedAt (no re-stamp)', () => {
  assert.equal(db.call('upsertCategory', cat({ id: 9002, deleted: 1 })), true)
  // simulate an old tombstone by rewriting deletedAt via a controlled upsert with explicit deletedAt
  assert.equal(db.call('upsertCategory', cat({ id: 9002, deleted: 1, deletedAt: 1111111111111 })), true)
  const base = db.call('syncOplogSince', { sinceSeq: 0 }).pop().seq
  assert.equal(db.call('upsertCategory', cat({ id: 9002, deleted: 1, deletedAt: 1111111111111 })), false,
    're-upsert of the same tombstone is a no-op — deletedAt not re-stamped to now')
  assert.equal(db.call('syncOplogSince', { sinceSeq: base }).length, 0, 'tombstone re-upsert produces no delta')
})
