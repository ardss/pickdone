/* Wave-M leftovers (R4/R5 tail, 2026-09-21):
   1. snowDedup meta keys are stamped with their creation time and pruned past the cap
      (they used to accumulate one row per focus session forever).
   2. csv-import re-baselines the db watcher AFTER scheduler.reloadAll, whose own
      reminderLastSeenAt write used to land post-baseline and self-trigger an external-write
      reload (undo wipe). Source-anchored: the handler needs the live electron app. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-m-leftovers-'))
db.init(dir)

const snowKeyCount = () =>
  db.call('listMetaKeys', []).filter(k => k.startsWith('snowDedup:')).length

test('snowDedup: key is stamped with its creation epoch, replay stays deduped', () => {
  const t = { taskId: 'wm_stamp_1', taskContent: 'x', categoryId: null, complete: false, deleted: false }
  db.call('upsert', t)
  const key = `snowDedup:${t.taskId}:sess1`
  const r1 = db.call('bumpSnow', { taskId: t.taskId, minutes: 25, dedupKey: 'sess1' })
  assert.equal(r1.ok, true)
  const stamp = Number(db.call('getMeta', key))
  assert.ok(stamp > 0, 'dedup key value must carry the creation timestamp')
  const r2 = db.call('bumpSnow', { taskId: t.taskId, minutes: 25, dedupKey: 'sess1' })
  assert.deepEqual(r2, { ok: true, minutes: 0, deduped: true })
})

test('snowDedup: keys older than the age floor are pruned once the cap is exceeded', () => {
  // Simulate an aged backlog: keys stamped '1' (epoch 0) must age out on the next dedup'd bump.
  // One transaction via setMetaMany — 2001 standalone setMeta calls each pay a commit fsync and
  // blew the 2min test ceiling on CI's slow disk (windows job red 2026-09-23, fail 0 + exit 1).
  db.call('setMetaMany', Array.from({ length: 2001 }, (_, i) => [`snowDedup:legacy_${i}:s`, '1']))
  assert.ok(snowKeyCount() > 2000, 'backlog must exceed the cap before the bump')
  const t = { taskId: 'wm_prune_1', taskContent: 'x', categoryId: null, complete: false, deleted: false }
  db.call('upsert', t)
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: 10, dedupKey: 'fresh' })
  assert.equal(r.ok, true)
  assert.ok(snowKeyCount() <= 2000, `aged keys must be pruned, got ${snowKeyCount()}`)
  assert.ok(db.call('getMeta', `snowDedup:${t.taskId}:fresh`) !== null, 'the fresh key must survive pruning')
})

test('snowDedup: bump below the cap never deletes keys', () => {
  const t = { taskId: 'wm_keep_1', taskContent: 'x', categoryId: null, complete: false, deleted: false }
  db.call('upsert', t)
  const before = snowKeyCount()
  db.call('bumpSnow', { taskId: t.taskId, minutes: 5, dedupKey: 'keep' })
  assert.equal(snowKeyCount(), before + 1)
})

test('csv-import: re-baseline runs again AFTER scheduler.reloadAll (self-write guard)', () => {
  const file = fileURLToPath(new URL('../../../src/main/handlers/csv-import.js', import.meta.url))
  const src = fs.readFileSync(file, 'utf8')
  const reloadAt = src.indexOf('scheduler.reloadAll(dbApi())')
  const resyncs = []
  let idx = 0
  while ((idx = src.indexOf('resyncDbWatch && resyncDbWatch()', idx)) !== -1) {
    resyncs.push(idx)
    idx += 1
  }
  assert.ok(reloadAt > -1, 'reloadAll call must exist')
  assert.ok(resyncs.length >= 2, 'import must re-baseline both before AND after reloadAll')
  assert.ok(resyncs.some(off => off > reloadAt), 'a re-baseline must land after reloadAll (reminderLastSeenAt self-write guard)')
})
