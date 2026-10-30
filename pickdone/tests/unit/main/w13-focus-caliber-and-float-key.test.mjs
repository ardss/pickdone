/* W13 regressions (2026-10-26, P2 pair of fixes).
   Fix 1 — focusMinutes upsert calibers: the B1 MAX guard must stay on the renderer-origin
   single-row `upsert` (stale-snapshot protection), while the sync-origin writers
   (commitSyncBatch cloud ack, upsertMany LAN landing via todo.putMany) must APPLY a
   legitimate decrease (W7-R renderer `undo:` compensation) — otherwise peer ledgers
   diverge permanently and every snapshot re-fights the row.
   Fix 2 — tomatoFloatClosedByUser is machine-local meta: it must classify LOCAL (neither
   egress nor ingress), so closing the float on device A cannot suppress device B's float
   auto-show or LWW-fight the key forever. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const { isMachineLocalMetaKey } = require_('../../../shared/machine-local-keys.mjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w13-focus-caliber-'))
db.init(dir)

const seed = over => Object.assign({
  taskId: 'w13fm_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

test('Fix1: upsert keeps B1 MAX guard — a LOWER focusMinutes never lands', () => {
  const t = seed({ estimate: 30 })
  db.call('upsert', t)
  // stale whole-row writer still carrying a lower (pre-bump) estimate
  db.call('upsert', seed({ taskId: t.taskId, estimate: 5, taskContent: 'stale' }))
  const row = db.call('getById', t.taskId)
  assert.equal(row.estimate, 30, 'B1 MAX guard must reject the decrease on the local upsert path')
  assert.equal(row.taskContent, 'stale', 'ordinary columns still take the new value')
})

test('Fix1: commitSyncBatch APPLIES a LOWER focusMinutes (cloud ack = post-adjudication winner)', () => {
  const t = seed({ estimate: 30 })
  db.call('upsert', t)
  // W7-R undo compensation synced back by the peer: the decrease is authoritative
  db.call('commitSyncBatch', { rows: [seed({ taskId: t.taskId, estimate: 12, updateTime: Date.now() })], version: 1 })
  const row = db.call('getById', t.taskId)
  assert.equal(row.estimate, 12, 'peer undo decrease must land through commitSyncBatch')
})

test('Fix1: upsertMany APPLIES a LOWER focusMinutes (LAN snapshot/flush landing = adjudicated rows)', () => {
  const t = seed({ estimate: 30 })
  db.call('upsert', t)
  db.call('upsertMany', [seed({ taskId: t.taskId, estimate: 7, updateTime: Date.now() })])
  assert.equal(db.call('getById', t.taskId).estimate, 7, 'peer adjudicated decrease must land through upsertMany')
})

test('Fix2: tomatoFloatClosedByUser classifies machine-local; neighbors unchanged', () => {
  assert.equal(isMachineLocalMetaKey('tomatoFloatClosedByUser'), true, 'float dismissal is per-device UI state')
  // neighbors must stay as they were: exact key, not a prefix family
  assert.equal(isMachineLocalMetaKey('tomatoFloatClosedByUserX'), false, 'suffixed key must stay syncable (exact match)')
  assert.equal(isMachineLocalMetaKey('tomatoRunAnnounce.dev1'), false, 'user-data tomato announce key stays syncable')
  assert.equal(isMachineLocalMetaKey('themeColor'), false)
  assert.equal(isMachineLocalMetaKey('dailyTomatoTarget'), false)
  // pre-existing machine-local families untouched by this change
  assert.equal(isMachineLocalMetaKey('sync.deviceId'), true)
  assert.equal(isMachineLocalMetaKey('_cliStamp'), true)
  assert.equal(isMachineLocalMetaKey('cliTomatoSeq'), true)
  assert.equal(isMachineLocalMetaKey('todosVersion'), true)
  assert.equal(isMachineLocalMetaKey('snowDedup:t:1'), true)
})
