/* D12 sync-wave regression tests (main-db-sync-core domain):
 *   Sync-1  a tombstone landing through the sync bulk path carries its deletedAt as the row age
 *           (todoToRow fallback) — updatedAt 0 made the deletion epoch-oldest and it resurrected
 *   Sync-2  bumpSnow attributes the write to this device (syncAuthor), like every other write
 *   Sync-5  hardDelete/hardDeleteMany return the ids PHYSICALLY deleted and the oplog emits no
 *           phantom tombstone pointer for an absent id
 *   Sync-6  settingsRowDelete/tomatoRemoveByIds are oplog result-aware (no pointer on no-op)
 *   Sync-7  tomatoRemoveByIds guards `AND deleted=0` — a re-delete must not re-stamp deletedAt
 *   Sync-8  a deduped bumpSnow replay emits no oplog delta
 *   Sync-10 the setMeta blob bridge tombstones settings rows absent from the whole-doc mirror
 *           (machine-local rows and rows newer than the blob snapshot are spared)
 *   Sync-11 putRow compares values canonically — key-order-only differences are not "changed"
 *   Sync-14 dbRecovery todo restore re-stamps doctrine (live rows win LWW, tombstones stay honest)
 * Real better-sqlite3 via db.init on fresh temp dirs (d11-tombstone-stamps pattern — never the
 * real %APPDATA% profile). Run: node --test tests/unit/main/d12-sync-wave.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')
const dbRows = require_('../../../src/main/db-rows.js')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-sync-' + label + '-'))
  db.init(dir)
  return {
    dir,
    deviceId: 'devD12',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
}

function rawGet (dir, sql, params = []) {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
  const row = d.prepare(sql).get(...params)
  d.close()
  return row
}

function flush (state) { const r = syncApply.flushPendingWrites(state); assert.equal(r.ok, true) }

// ---------- Sync-1: tombstone stamp fallback ----------

test('Sync-1: an inbound todo tombstone lands with its deletedAt as updatedAt (not 0)', () => {
  const state = freshDevice('tombstamp')
  const T = Date.now() - 60000
  db.call('upsert', { taskId: 'd12s1', taskContent: 'live', updateTime: T - 120000 })
  const ok = syncApply.applyRowSafe(state, {
    entity: 'todo', id: 'd12s1', seq: 1, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null,
  })
  assert.equal(ok, true, 'the newer deletion must win LWW')
  flush(state)
  const row = rawGet(state.dir, 'SELECT deleted, deletedAt, updatedAt FROM todos WHERE id = ?', ['d12s1'])
  assert.equal(row.deleted, 1, 'the tombstone landed')
  assert.equal(row.updatedAt, T, 'tombstone row age must fall back to deletedAt (was 0 = epoch-oldest)')
  db.close()
})

test('Sync-1: a live todo without updateTime keeps the 0 semantics (fallback is tombstone-only)', () => {
  const r = dbRows.todoToRow({ taskId: 'x' })
  assert.equal(r.updatedAt, 0)
  assert.equal(r.deleted, 0)
  const t = dbRows.todoToRow({ taskId: 'y', delete: 1, deletedAt: 12345 })
  assert.equal(t.updatedAt, 12345, 'deleted row falls back to deletedAt')
})

// ---------- Sync-2: bumpSnow syncAuthor attribution ----------

test('Sync-2: bumpSnow stamps the row with this device identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-snowauthor-'))
  db.init(dir)
  dbRows.setSyncAuthor('devD12snow')
  db.call('upsert', { taskId: 'd12s2', taskContent: 'focus me' })
  const r = db.call('bumpSnow', { taskId: 'd12s2', minutes: 25 })
  assert.deepEqual(r, { ok: true, minutes: 25 })
  const t = db.call('getById', 'd12s2')
  assert.equal(t.estimate, 25, 'focus credit landed')
  assert.equal(t.syncAuthor, 'devD12snow', 'the bump must be attributed (was null/unchanged)')
  dbRows.setSyncAuthor(null)
  db.close()
})

// ---------- Sync-5: hardDelete result-awareness ----------

test('Sync-5: hardDelete of an absent id returns [] and emits NO oplog tombstone pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-harddel-'))
  db.init(dir)
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  const r = db.call('hardDelete', 'never_existed_d12')
  assert.deepEqual(r, [], 'nothing was physically deleted')
  const ops = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 })
  assert.equal(ops.length, before, 'no phantom (todo, absent-id) pointer')
  db.close()
})

test('Sync-5: hardDelete of a live id returns [id] and still emits its tombstone pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-harddel2-'))
  db.init(dir)
  db.call('upsert', { taskId: 'd12s5', taskContent: 'bye' })
  const r = db.call('hardDelete', 'd12s5')
  assert.deepEqual(r, ['d12s5'])
  const ops = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 })
  assert.ok(ops.some(o => o.entity === 'todo' && o.entityId === 'd12s5'), 'real deletion still captured')
  db.close()
})

test('Sync-5: hardDeleteMany returns only the ids that actually existed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-harddel3-'))
  db.init(dir)
  db.call('upsert', { taskId: 'd12s5a', taskContent: 'a' })
  const r = db.call('hardDeleteMany', ['d12s5a', 'ghost_d12'])
  assert.deepEqual(r, ['d12s5a'])
  db.close()
})

// ---------- Sync-6 + Sync-7: tomatoRemoveByIds guard + result-aware oplog ----------

test('Sync-6/7: tomatoRemoveByIds returns only tombstoned ids; a re-delete is a no-op that re-stamps nothing and logs no pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-tomdel-'))
  db.init(dir)
  const T = Date.now() - 60000
  db.call('tomatoAppendMany', [{ tomatoId: 'd12t7', endTime: Date.now(), focusDuration: 5 }])
  const first = db.call('tomatoRemoveByIds', [{ tomatoId: 'd12t7', deletedAt: T, updatedAt: T }])
  assert.deepEqual(first, ['d12t7'])
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  const second = db.call('tomatoRemoveByIds', ['d12t7'])
  assert.deepEqual(second, [], 'an already-dead id is not tombstoned again')
  const row = rawGet(dir, 'SELECT deleted, deletedAt, updatedAt FROM tomato_records WHERE tomatoId = ?', ['d12t7'])
  assert.equal(row.deletedAt, T, 'the true deletion time must survive a re-delete (was re-stamped to now)')
  assert.equal(row.updatedAt, T, 'the true LWW age must survive a re-delete')
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length, before, 'no phantom pointer for the re-delete')
  db.close()
})

test('Sync-6/7: tomatoRemoveByIds of an absent id emits no oplog pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-tomdel2-'))
  db.init(dir)
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  const r = db.call('tomatoRemoveByIds', ['no_such_tomato'])
  assert.deepEqual(r, [])
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length, before)
  db.close()
})

test('Sync-6: settingsRowDelete of an absent key emits no oplog pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-setdel-'))
  db.init(dir)
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  const r = db.call('settingsRowDelete', { key: 'never_a_setting_d12' })
  assert.equal(r, false)
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length, before, 'no phantom (setting, key) pointer')
  db.close()
})

// ---------- Sync-8: bumpSnow dedup oplog suppression ----------

test('Sync-8: a deduped bumpSnow replay emits no oplog delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-dedup-'))
  db.init(dir)
  db.call('upsert', { taskId: 'd12s8', taskContent: 'x' })
  const r1 = db.call('bumpSnow', { taskId: 'd12s8', minutes: 10, dedupKey: 'sess-d12' })
  assert.deepEqual(r1, { ok: true, minutes: 10 })
  const after1 = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  const r2 = db.call('bumpSnow', { taskId: 'd12s8', minutes: 10, dedupKey: 'sess-d12' })
  assert.equal(r2.deduped, true, 'replay is deduped')
  assert.equal(db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length, after1, 'the replay must not mint a phantom delta')
  db.close()
})

// ---------- Sync-10: blob bridge tombstones absent rows ----------

test('Sync-10: a field removed from the settings blob mirror gets its row tombstoned + an oplog delta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-bridge-'))
  db.init(dir)
  // First mirror carries both fields
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now(), themeMode: 'dark', someOldField: 'v' })])
  let rows = db.call('settingsRowsAll').filter(r => !r.deleted)
  assert.ok(rows.some(r => r.key === 'someOldField'), 'precondition: field mirrored into a row')
  const before = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }).length
  // Second mirror drops the field: the row must tombstone, not linger live forever
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now() + 5000, themeMode: 'dark' })])
  rows = db.call('settingsRowsAll')
  assert.equal(rows.find(r => r.key === 'someOldField').deleted, true, 'absent field tombstoned')
  assert.equal(rows.find(r => r.key === 'themeMode').deleted, false, 'present field untouched')
  const ops = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 })
  assert.ok(ops.slice(before).some(o => o.entity === 'setting' && o.entityId === 'someOldField'), 'tombstoned field got an oplog delta')
  db.close()
})

test('Sync-10: machine-local rows and rows newer than the blob snapshot survive the bridge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-bridge2-'))
  db.init(dir)
  // Machine-local row (sync.*): never a blob field, must never be tombstoned off a mirror
  db.call('settingsRowPut', { key: 'sync.deviceId', value: 'devD12' })
  // A row applied AFTER the blob snapshot was taken (gate): stale echo must not destroy it
  db.call('settingsRowPut', { key: 'newerField', value: 'applied-by-sync' })
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now() - 60000, themeMode: 'dark' })])
  const rows = db.call('settingsRowsAll')
  assert.equal(rows.find(r => r.key === 'sync.deviceId').deleted, false, 'machine-local row spared')
  assert.equal(rows.find(r => r.key === 'newerField').deleted, false, 'row newer than the snapshot spared (gate)')
  db.close()
})

// ---------- Sync-11: canonical JSON compare in putRow ----------

test('Sync-11: a key-order-only rewrite of a blob field does NOT re-stamp the row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-canon-'))
  db.init(dir)
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now(), nested: { a: 1, b: 2 } })])
  const first = db.call('settingsRowsAll').find(r => r.key === 'nested')
  assert.ok(first, 'precondition: row exists')
  // Same document, different key insertion order — must read as identical (no fresh LWW age)
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now() + 5000, nested: { b: 2, a: 1 } })])
  const second = db.call('settingsRowsAll').find(r => r.key === 'nested')
  assert.equal(second.updatedAt, first.updatedAt, 'identical value must keep its LWW age (was re-stamped)')
  assert.equal(second.deleted, false)
  db.close()
})

test('Sync-11: a genuinely different value still updates the row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-canon2-'))
  db.init(dir)
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now(), nested: { a: 1 } })])
  const first = db.call('settingsRowsAll').find(r => r.key === 'nested')
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now() + 5000, nested: { a: 2 } })])
  const second = db.call('settingsRowsAll').find(r => r.key === 'nested')
  assert.ok(second.updatedAt > first.updatedAt || second.updatedAt >= first.updatedAt && second.updatedAt !== 0, 'changed value re-stamps')
  assert.equal(JSON.stringify(second.value), '{"a":2}')
  db.close()
})

// ---------- Sync-14: dbRecovery todo re-stamp doctrine ----------

test('Sync-14: restored live todos re-stamp fresh; restored tombstones keep a stale-oldest age', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-restore-'))
  fs.mkdirSync(dir, { recursive: true })
  const backup = JSON.stringify({
    backup: {
      todoState: JSON.stringify({
        todoList: [{ taskId: 'd12live', taskContent: 'live row', updateTime: 1000, delete: 0 }],
        recycleList: [{ taskId: 'd12dead', taskContent: 'tombstone', updateTime: 1000, delete: 1, deletedAt: 5555 }],
      }),
    },
  })
  dbRecovery.writeCriticalStateBackupAtomic(dir, backup)
  const got = []
  const n = dbRecovery.restoreTasksFromCriticalBackup(dir, rows => { got.push(...rows) })
  assert.equal(n, 2)
  const live = got.find(t => t.taskId === 'd12live')
  const dead = got.find(t => t.taskId === 'd12dead')
  assert.ok(live.updateTime > Date.now() - 60000, 'live restore re-stamps fresh (backup stamps lose LWW instantly)')
  assert.equal(dead.delete, 1)
  assert.equal(dead.deletedAt, 5555, 'backup deletedAt preserved')
  assert.equal(dead.updateTime, 1, 'tombstone stays epoch-oldest so a peer re-creation wins LWW')
})

test('Sync-14: restore count is honest when no rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-restore2-'))
  dbRecovery.writeCriticalStateBackupAtomic(dir, JSON.stringify({ backup: { todoState: '{}' } }))
  const n = dbRecovery.restoreTasksFromCriticalBackup(dir, () => {})
  assert.equal(n, 0)
})
