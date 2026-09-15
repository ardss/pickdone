/* H2 fix #5 regression: deleteMeta must be change-captured — it was absent from WRITE_OPS and had no
   oplog case, so meta deletions could never propagate to other devices.
   Run: node --test tests/unit/main/h2-deletemeta-oplog.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'h2-deletemeta-')))

test('deleteMeta is a write op and logs one meta delta row (string and array arg forms)', () => {
  assert.equal(db.isWriteOp('deleteMeta'), true, 'deleteMeta must be in WRITE_OPS')
  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0

  db.call('setMeta', ['h2_dm_key', 'v1'])
  db.call('deleteMeta', 'h2_dm_key')
  assert.equal(db.call('getMeta', 'h2_dm_key'), null)

  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.deepEqual(rows.map(r => r.entity), ['meta', 'meta'])
  assert.equal(rows[1].entityId, 'h2_dm_key')

  // array arg form (renderer's dbCall('deleteMeta', [k]) passes one array)
  db.call('setMeta', ['h2_dm_key2', 'v'])
  db.call('deleteMeta', ['h2_dm_key2'])
  const tail = db.call('syncOplogSince', { sinceSeq: rows[1].seq })
  assert.equal(tail[1].entityId, 'h2_dm_key2', 'array arg form must log the key, not the array')
})
