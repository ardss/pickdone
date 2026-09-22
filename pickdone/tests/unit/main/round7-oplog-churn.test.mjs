/* R7 churn fix (2026-09-21): machine-local bookkeeping keys must never enter the sync oplog.
 * The settings blob mirror rewrites db.settingsState + _savedAt + _lsAt every few seconds;
 * those pointers used to land in the ring (~3/tick), outran the push watermark, and Device
 * Center permanently showed a few hundred "pending" rows of pure self-echo.
 *
 * Run: node --test tests/unit/main/round7-oplog-churn.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

function freshDb () {
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-churn-')))
}

const oplogAll = () => db.call('syncOplogSince', { sinceSeq: 0, limit: 100000 }) || []
const oplogFor = id => oplogAll().filter(r => r.entityId === String(id))

test('machine-local setting stamps (_savedAt/_lsAt/sync.*) emit no oplog pointers', () => {
  freshDb()
  db.call('settingsRowPutMany', [
    { key: '_savedAt', value: Date.now() },
    { key: '_lsAt', value: Date.now() },
    { key: 'sync.peerWatermarks.v2', value: '{}' },
  ])
  assert.equal(oplogFor('_savedAt').length, 0, 'bookkeeping stamps must not enter the ring')
  assert.equal(oplogFor('_lsAt').length, 0, 'bookkeeping stamps must not enter the ring')
  assert.equal(oplogFor('sync.peerWatermarks.v2').length, 0, 'sync.* state must not enter the ring')
  // a real user setting still emits exactly one pointer
  db.call('settingsRowPutMany', [{ key: 'dailyTomatoTarget', value: 9 }])
  assert.equal(oplogFor('dailyTomatoTarget').length, 1, 'user setting emits one delta')
})

test('blob-mirror meta (db.settingsState/db.habitsState) emits no oplog pointers', () => {
  freshDb()
  db.call('setMeta', ['db.settingsState', JSON.stringify({ dailyTomatoTarget: 9 })])
  db.call('setMeta', ['db.habitsState', '{}'])
  assert.equal(oplogFor('db.settingsState').length, 0, 'blob mirrors must not enter the ring')
  assert.equal(oplogFor('db.habitsState').length, 0, 'blob mirrors must not enter the ring')
  // user-data meta still emits
  db.call('setMeta', ['projectMilestones:cat1', '{"milestones":[]}'])
  assert.equal(oplogFor('projectMilestones:cat1').length, 1, 'user meta emits one delta')
})
