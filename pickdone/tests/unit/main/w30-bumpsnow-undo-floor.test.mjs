/* W30 (P2) bumpSnow undo balance floor — src/main/db.js stmts.bumpSnow.
   The undo path ('undo:'-prefixed dedupKey) clamps each call to [-FOCUS_MAX, 0] but the SQL was a
   blind `focusMinutes + @minutes`: stacking undos of DIFFERENT dedup keys (each individually
   within the single-session cap, but together exceeding the current balance) drove focusMinutes
   NEGATIVE. Regression: the balance must never go below 0, credits are unaffected, and multiple
   distinct-key undo replays stay idempotent per key. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-bumpsnow-floor-'))
db.init(dir)

const seed = over => Object.assign({
  taskId: 'w30_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

const focusOf = id => db.call('getById', id).estimate

test('undo below balance floors at 0 (single undo exceeding balance)', () => {
  const t = seed({})
  db.call('upsert', t)
  db.call('bumpSnow', { taskId: t.taskId, minutes: 30 })
  assert.equal(focusOf(t.taskId), 30)
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: -45, dedupKey: 'undo:sess-a' })
  assert.deepEqual(r, { ok: true, minutes: -45 })
  assert.equal(focusOf(t.taskId), 0, 'balance must floor at 0, not go negative')
})

test('stacked undos with DIFFERENT dedup keys never drive the balance negative', () => {
  const t = seed({})
  db.call('upsert', t)
  db.call('bumpSnow', { taskId: t.taskId, minutes: 100 })
  db.call('bumpSnow', { taskId: t.taskId, minutes: 40 })
  assert.equal(focusOf(t.taskId), 140)
  // three sessions undone back-to-back (renderer retry storm / user mashing undo)
  db.call('bumpSnow', { taskId: t.taskId, minutes: -60, dedupKey: 'undo:s1' })
  assert.equal(focusOf(t.taskId), 80)
  db.call('bumpSnow', { taskId: t.taskId, minutes: -60, dedupKey: 'undo:s2' })
  assert.equal(focusOf(t.taskId), 20)
  db.call('bumpSnow', { taskId: t.taskId, minutes: -60, dedupKey: 'undo:s3' })
  const after = focusOf(t.taskId)
  assert.equal(after, 0, 'third undo exceeds the remaining 20 — must floor at 0')
  assert.ok(after >= 0, 'focusMinutes must never be negative')
})

test('positive credit path is unchanged (MAX(0, x) is a no-op for credits)', () => {
  const t = seed({})
  db.call('upsert', t)
  db.call('bumpSnow', { taskId: t.taskId, minutes: 25 })
  db.call('bumpSnow', { taskId: t.taskId, minutes: 25, dedupKey: 'sess-x' })
  assert.equal(focusOf(t.taskId), 50)
  // credit after a floored undo starts from 0, not from a negative hole
  db.call('bumpSnow', { taskId: t.taskId, minutes: 5 })
  assert.equal(focusOf(t.taskId), 55)
})

test('per-dedupKey idempotency survives the floor (same key replays dedupe, distinct keys do not)', () => {
  const t = seed({})
  db.call('upsert', t)
  db.call('bumpSnow', { taskId: t.taskId, minutes: 50 })
  db.call('bumpSnow', { taskId: t.taskId, minutes: -80, dedupKey: 'undo:k1' })
  const a2 = db.call('bumpSnow', { taskId: t.taskId, minutes: -80, dedupKey: 'undo:k1' })
  assert.deepEqual(a2, { ok: true, minutes: 0, deduped: true }, 'same undo key must dedupe')
  assert.equal(focusOf(t.taskId), 0)
  const b = db.call('bumpSnow', { taskId: t.taskId, minutes: -10, dedupKey: 'undo:k2' })
  assert.deepEqual(b, { ok: true, minutes: -10 }, 'distinct undo key must still apply (and floor)')
  assert.equal(focusOf(t.taskId), 0)
})
