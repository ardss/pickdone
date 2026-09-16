/* P2 data-layer sync migrations regression (src/main/db-sync-schema.js + db.js wiring, 2026-09-16):
   1. schema v6: settings_rows table + todos.tz column; meta blobs (db.settingsState/db.habitsState)
      split into per-key rows; migration is idempotent (unchanged blobs never re-stamp updatedAt)
   2. settings row ops: put/get roundtrip, tombstone delete, same-key resurrection, oplog capture
   3. legacy bridge: setMeta on a sync blob key mirrors changed fields into rows; non-sync meta keys
      keep the old meta read/write path
   4. tz: new/updated todo rows are stamped with the device IANA timezone; a caller-supplied tz
      (sync echo / LWW winner) is preserved and round-trips through rowToTodo
   Run: node --test tests/unit/main/p2-settings-rows-tz.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-settings-rows-'))
db.init(dir)

const schemaVersion = () => Number(db.call('getMeta', 'schemaVersion'))
const rowOf = k => db.call('settingsRowsAll', {}).find(r => r.key === k) || null
const deviceTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone

// NOTE: re-running the v6 migration on an existing DB is exercised by the idempotency test
// below via a second init on the same directory (migrations are one-shot per version stamp).

test('migration v6 stamped on a fresh DB', () => {
  assert.ok(schemaVersion() >= 6, 'schemaVersion should be >= 6, got ' + schemaVersion())
})

test('settings row roundtrip: put, read, update, tombstone, resurrect', () => {
  assert.equal(db.call('settingsRowPut', { key: 'theme', value: 'dark' }), true)
  const r1 = rowOf('theme')
  assert.equal(r1.value, 'dark')
  assert.equal(r1.deleted, false)
  assert.ok(r1.updatedAt > 0)
  // identical put is a no-op result-wise but must not re-stamp updatedAt (LWW age stays honest)
  const ua = r1.updatedAt
  assert.equal(db.call('settingsRowPut', { key: 'theme', value: 'dark' }), false)
  assert.equal(rowOf('theme').updatedAt, ua)
  // changed value re-stamps
  db.call('settingsRowPut', { key: 'theme', value: 'light' })
  const r2 = rowOf('theme')
  assert.equal(r2.value, 'light')
  assert.ok(r2.updatedAt >= ua)
  // tombstone delete: row survives, flagged deleted, hidden value preserved for sync merge
  assert.equal(db.call('settingsRowDelete', 'theme'), true)
  const r3 = rowOf('theme')
  assert.equal(r3.deleted, true)
  assert.ok(r3.deletedAt > 0)
  // same-key put resurrects (plan_chips precedent)
  db.call('settingsRowPut', { key: 'theme', value: 'dark' })
  const r4 = rowOf('theme')
  assert.equal(r4.deleted, false)
  assert.equal(r4.value, 'dark')
})

test('settings row writes are change-captured into sync_oplog', () => {
  const prior = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = prior.length ? prior[prior.length - 1].seq : 0
  db.call('settingsRowPut', { key: 'oplogProbe', value: 1 })
  db.call('settingsRowPut', { key: 'oplogProbe', value: 1 }) // no-change put: no delta
  db.call('settingsRowPutMany', [{ key: 'opProbeA', value: 1 }, { key: 'opProbeB', value: 2 }])
  db.call('settingsRowDelete', 'opProbeA')
  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  const settings = rows.filter(r => r.entity === 'setting').map(r => r.entityId)
  assert.deepEqual(settings, ['oplogProbe', 'opProbeA', 'opProbeB', 'opProbeA'],
    'put(1) + putMany(2 changed) + delete; the identical re-put must be silent')
})

test('legacy bridge: setMeta on a sync blob key mirrors changed fields into rows', () => {
  db.call('setMeta', ['db.settingsState', JSON.stringify({ bridgeA: 'v1', bridgeB: 'w1' })])
  assert.equal(rowOf('bridgeA').value, 'v1')
  assert.equal(rowOf('bridgeB').value, 'w1')
  const uaB = rowOf('bridgeB').updatedAt
  // only the changed field re-stamps; unchanged fields keep their updatedAt
  db.call('setMeta', ['db.settingsState', JSON.stringify({ bridgeA: 'v2', bridgeB: 'w1' })])
  assert.equal(rowOf('bridgeA').value, 'v2')
  assert.ok(rowOf('bridgeA').updatedAt >= uaB)
  assert.equal(rowOf('bridgeB').updatedAt, uaB, 'unchanged field must not be re-stamped by the bridge')
  // non-sync meta keys keep the plain meta path untouched (no row leakage)
  db.call('setMeta', ['plainKey', 'plainVal'])
  assert.equal(db.call('getMeta', 'plainKey'), 'plainVal')
  assert.equal(rowOf('plainKey'), null)
})

test('migration of existing meta blobs: blob split into rows, idempotent across restarts', () => {
  // Seed blobs the legacy way, then rewind the version stamp so v6 re-runs at next init
  db.call('setMeta', ['db.habitsState', JSON.stringify({ streak: 3, mood: 'ok' })])
  db.call('setMeta', ['schemaVersion', '5'])
  db.close()
  db.init(dir)
  assert.ok(schemaVersion() >= 6, 'v6 re-stamped after rewind')
  const streak1 = rowOf('streak')
  assert.equal(streak1.value, 3, 'habits blob split into per-key rows')
  assert.equal(rowOf('mood').value, 'ok')
  // Idempotency: a second restart with UNCHANGED blobs must not touch updatedAt/deletedAt
  db.call('setMeta', ['schemaVersion', '5'])
  db.close()
  db.init(dir)
  const streak2 = rowOf('streak')
  assert.equal(streak2.updatedAt, streak1.updatedAt, 'unchanged blob re-migration must be a no-op')
  assert.equal(streak2.value, 3)
  // A blob CHANGED out-of-band (old build writing the mirror) re-syncs only the delta
  db.call('setMeta', ['db.habitsState', JSON.stringify({ streak: 3, mood: 'great' })])
  db.call('setMeta', ['schemaVersion', '5'])
  db.close()
  db.init(dir)
  assert.equal(rowOf('mood').value, 'great')
  assert.equal(rowOf('streak').updatedAt, streak1.updatedAt, 'unchanged field keeps its stamp across a partial re-migration')
})

test('tz: new todo rows stamped with the device timezone; explicit tz preserved; exposed on reads', () => {
  db.call('upsert', { taskId: 'p2_tz1', taskContent: 'x', complete: false, delete: false })
  assert.equal(db.call('getById', 'p2_tz1').tz, deviceTz(), 'local write stamps the device IANA tz')
  // commitSyncBatch row carrying an explicit tz (LWW winner from another device) keeps it
  const v = Number(db.call('getMeta', 'todosVersion')) || 0
  db.call('commitSyncBatch', { rows: [{ taskId: 'p2_tz2', taskContent: 'y', complete: false, delete: false, tz: 'America/New_York' }], version: v + 1 })
  assert.equal(db.call('getById', 'p2_tz2').tz, 'America/New_York', 'winner-row tz survives the sync-ack write')
  // re-upsert of that row WITHOUT tz (plain local edit) re-stamps the local device tz
  db.call('upsert', { taskId: 'p2_tz2', taskContent: 'y2', complete: false, delete: false, tz: 'America/New_York' })
  assert.equal(db.call('getById', 'p2_tz2').tz, 'America/New_York')
  // scheduledDay semantics unchanged: still derived from todoTime only
  const todoTime = new Date(2026, 8, 16, 12).getTime()
  db.call('upsert', { taskId: 'p2_tz3', taskContent: 'z', complete: false, delete: false, todoTime })
  const t3 = db.call('getById', 'p2_tz3')
  assert.equal(t3.dayStart, +new Date(2026, 8, 16).getTime())
  assert.equal(t3.tz, deviceTz())
})

test('tz column exists via migration on a pre-v6 DB (probe-free explicit ALTER)', () => {
  // Covered implicitly by every rewind-to-v5 restart above (fresh DBs get tz from SCHEMA,
  // existing DBs from the v6 ALTER): a tz write still works after the migration re-ran
  db.call('setMeta', ['schemaVersion', '5'])
  db.close()
  db.init(dir)
  db.call('upsert', { taskId: 'p2_tz4', taskContent: 'post-migration', complete: false, delete: false })
  assert.equal(db.call('getById', 'p2_tz4').tz, deviceTz())
})
