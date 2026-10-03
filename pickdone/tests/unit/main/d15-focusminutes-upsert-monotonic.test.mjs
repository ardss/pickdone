/* D15 B1 regression — safeUpsert must preserve accumulated focusMinutes.
   Contract (renderer store todo.js, "U-1 write-once at the DB layer"): focus minutes are
   monotonic — the only mutation path is bumpSnow's DB-side `+=`. A stale whole-row upsert
   (stale cross-window snapshot still carrying the pre-bump estimate) used to overwrite the
   accumulated column back to the old value and sync the erasure. The upsert now uses
   `focusMinutes = MAX(todos.focusMinutes, excluded.focusMinutes)` so a decrease is never
   applied. Fails without the db.js guard. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd15-focusminutes-'))
db.init(dir)

const seed = over => Object.assign({
  taskId: 'd15fm_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

test('upsert: stale row cannot erase accumulated focusMinutes', () => {
  const t = seed({})
  db.call('upsert', t)
  assert.equal(db.call('getById', t.taskId).estimate, 0)

  // bumpSnow accumulates minutes DB-side (monotonic, per contract)
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: 25 })
  assert.deepEqual(r, { ok: true, minutes: 25 })
  assert.equal(db.call('getById', t.taskId).estimate, 25)

  // Stale writer: whole-row upsert still carrying the PRE-bump estimate
  const stale = seed({ taskId: t.taskId, taskContent: 'edited title', estimate: 0 })
  db.call('upsert', stale)

  const after = db.call('getById', t.taskId)
  assert.equal(after.estimate, 25, 'accumulated focus minutes must survive a stale whole-row upsert')
  assert.equal(after.taskContent, 'edited title', 'ordinary columns still take the new value')
})

test('upsert: higher fresh value still lands (MAX only rejects decreases)', () => {
  const t = seed({ estimate: 10 })
  db.call('upsert', t)
  // a legitimate writer that has seen 40 minutes writes the higher number through
  db.call('upsert', seed({ taskId: t.taskId, estimate: 40 }))
  assert.equal(db.call('getById', t.taskId).estimate, 40)
})

test('upsert: insert path unaffected (fresh row keeps its own minutes)', () => {
  const t = seed({ estimate: 15 })
  db.call('upsert', t)
  assert.equal(db.call('getById', t.taskId).estimate, 15)
})
