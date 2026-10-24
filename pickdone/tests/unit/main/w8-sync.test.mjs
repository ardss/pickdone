/* W8 sync/main-DB fix-wave regression tests (2026-10-25), fixes 1-6:
 *   fix 1  db-sync-schema putRow: the stale whole-blob echo gate now applies to DELETED rows —
 *          a stale mirror (blob _savedAt far behind the row's updatedAt) must not resurrect a
 *          tombstone; a fresh mirror (same-tick) still may.
 *   fix 2  db-recovery-restore habitsPut: the restore serializes `deleted`/`deletedMoments`
 *          tombstone arrays so disaster recovery does not resurrect deleted habits/moments.
 *   fix 3  sync-apply plan/filter delete-vs-edit guard is `>=`: an EXACT-STAMP tie keeps the
 *          tombstone and mints the metaConflictBackup instead of falling to generic LWW.
 *   fix 4  sync-apply-flush QUARANTINE_ROW_SAMPLE 20 → 500: a >20-row poison batch is fully
 *          parked (recoverable), not truncated to 20.
 *   fix 5  db-oplog appendOplogPointers ts-less fallback discriminates by entity: meta → 1
 *          (epoch-oldest, D13 doctrine), row-table entities → now.
 *   fix 6  sync-apply todo landing learns the peer's userId when nothing was discovered yet,
 *          instead of blindly stamping the 840001 offline default.
 * Real better-sqlite3 via db.init on fresh temp dirs (d13-sync-db-fixes pattern). Run:
 *   node --test tests/unit/main/w8-sync.test.mjs
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
const syncSchemaFactory = require_('../../../src/main/db-sync-schema.js')
const restoreFactory = require_('../../../src/main/db-recovery-restore.cjs')
const flushMod = require_('../../../src/main/sync-apply-flush.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w8-sync-' + label + '-'))
  db.init(dir)
  return {
    dir,
    deviceId: 'devW8',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
}

/* ---------------- fix 1: stale blob mirror must not resurrect a settings tombstone ---------------- */

test('fix 1: a stale blob echo cannot resurrect a deleted settings row; a fresh echo can', () => {
  freshDevice('tomb-gate')
  const T = Date.now() - 60000
  db.call('settingsRowPut', { key: 'w8field', value: 'v1', updatedAt: T })
  // local deletion stamped AFTER the stale snapshot was taken (well past the 1s gate epsilon)
  db.call('settingsRowDelete', { key: 'w8field', deletedAt: Date.now(), updatedAt: Date.now() })
  // STALE mirror: snapshot authored at T (long before the deletion), still carrying the field.
  // Red before the fix: no gate for deleted rows → resurrect with deleted=0 / updatedAt=now.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: T, w8field: 'stale' })])
  let row = (db.call('settingsRowsAll', {}) || []).find(r => r.key === 'w8field')
  assert.ok(row && row.deleted, 'stale echo must NOT resurrect the tombstone')
  // FRESH mirror: same-tick snapshot legitimately re-adds the field → resurrection is the real path.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: Date.now(), w8field: 'fresh' })])
  row = (db.call('settingsRowsAll', {}) || []).find(r => r.key === 'w8field')
  assert.ok(row && !row.deleted, 'a fresh (same-tick) echo may still resurrect the row')
  assert.equal(row.value, 'fresh')
  db.close()
})

/* ---------------- fix 2: disaster recovery carries habits tombstone arrays ---------------- */

test('fix 2: restoreHabitsBlobFromCriticalBackup serializes deleted/deletedMoments', () => {
  const restore = restoreFactory({
    parseSegment: (seg) => (typeof seg === 'string' ? JSON.parse(seg) : (seg || {})),
    criticalBackupPath: () => '/unused',
    logWarn: () => {},
    SUPPORTED_SCHEMA_V: 1,
    attLoss: {},
  })
  const sent = []
  const n = restore.restoreHabitsBlobFromCriticalBackup(
    { backup: { habitsState: JSON.stringify({ schemaV: 1, habits: [{ id: 'h1' }], moments: [{ id: 'm1' }], deleted: ['h2'], deletedMoments: ['m9'], savedAt: 123 }) } },
    payload => sent.push(payload)
  )
  assert.equal(n, 1)
  const blob = JSON.parse(sent[0][1])
  assert.deepEqual(blob.deleted, ['h2'], 'red before the fix: tombstone array dropped by the restore')
  assert.deepEqual(blob.deletedMoments, ['m9'])
  assert.deepEqual(blob.habits, [{ id: 'h1' }])
  assert.deepEqual(blob.moments, [{ id: 'm1' }])
  // legacy backup without the arrays: empty arrays, not undefined (renderer persist shape intact)
  sent.length = 0
  restore.restoreHabitsBlobFromCriticalBackup(
    { backup: { habitsState: JSON.stringify({ schemaV: 1, habits: [{ id: 'h3' }] }) } },
    payload => sent.push(payload)
  )
  const legacyBlob = JSON.parse(sent[0][1])
  assert.deepEqual(legacyBlob.deleted, [])
  assert.deepEqual(legacyBlob.deletedMoments, [])
})

/* ---------------- fix 3: exact-stamp plan delete-vs-edit keeps the tombstone + backups ---------------- */

function adjudState (label, cache) {
  const meta = {}
  const state = {
    label,
    deviceId: 'devW8-' + label,
    localUserId: null,
    applyCache: cache,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: {
      call: (op, p) => {
        if (op === 'getMeta') return meta[p] != null ? meta[p] : null
        if (op === 'setMeta') { meta[p[0]] = p[1]; return true }
        if (op === 'listMetaKeys') return Object.keys(meta)
        return true
      },
    },
  }
  return { state, meta }
}

test('fix 3: plan tombstone holds an exact-stamp tie and mints the conflict backup', () => {
  const T = 1700000000000
  const { state, meta } = adjudState('plan-tie', {
    plan: () => null,
    planTomb: id => ({ id, updatedAt: T, deletedAt: T }),
    filter: () => null,
    filterTomb: () => null,
  })
  const incoming = { entity: 'plan', id: 'p_w8_tie', updatedAt: T, deleted: false, data: { id: 'p_w8_tie', taskId: 't1', day: '2026-10-01', mm: '09:00' } }
  const ok = syncApply.applyRowSafe(state, incoming)
  assert.equal(ok, false, 'delete holds the tie — the live edit does not land')
  assert.equal(state.pendingWrites.plans.length, 0, 'nothing buffered — the tombstone stands')
  const bkKeys = Object.keys(meta).filter(k => k.startsWith('metaConflictBackup.plan:p_w8_tie.'))
  assert.equal(bkKeys.length, 1, 'red before the fix (strict >): tie fell to generic LWW with no backup')
  assert.equal(JSON.parse(meta[bkKeys[0]]).value.taskId, 't1', 'the losing edit is recoverable')
})

test('fix 3: a strictly fresher inbound live edit still loses to the tombstone (guard unchanged)', () => {
  const T = 1700000000000
  const { state, meta } = adjudState('plan-fresh', {
    plan: () => null,
    planTomb: id => ({ id, updatedAt: T + 10, deletedAt: T + 10 }),
    filter: () => null,
    filterTomb: () => null,
  })
  const ok = syncApply.applyRowSafe(state, { entity: 'plan', id: 'p_w8_fresh', updatedAt: T, deleted: false, data: { id: 'p_w8_fresh', taskId: 't2', day: '2026-10-02', mm: '10:00' } })
  assert.equal(ok, false)
  assert.equal(state.pendingWrites.plans.length, 0)
  assert.equal(Object.keys(meta).filter(k => k.startsWith('metaConflictBackup.plan:p_w8_fresh.')).length, 1)
})

/* ---------------- fix 4: quarantine parks the whole poison batch, not a 20-row sample ---------------- */

function flushState (settingsSegment) {
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w8-flush-')), 'todos.db'))
  d.exec(`CREATE TABLE IF NOT EXISTS settings_rows (
    key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0);`)
  const schema = syncSchemaFactory({ getDb: () => d, log: { warn: () => {}, info: () => {}, error: () => {} } })
  const meta = {}
  const state = {
    deviceId: 'devW8Flush',
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], tomatoes: [], categories: [], plans: [], filters: [], settings: settingsSegment },
    db: {
      call: (op, p) => {
        if (op === 'settingsRowPutMany') return schema.rowPutMany(p)
        if (op === 'getMeta') return meta[p] != null ? meta[p] : null
        if (op === 'setMeta') { meta[p[0]] = p[1]; return true }
        return true
      },
    },
  }
  return { state, meta, schema, close: () => d.close() }
}

test('fix 4: a 25-row poison batch is fully quarantined (sample cap is no longer 20)', () => {
  assert.ok(flushMod.QUARANTINE_ROW_SAMPLE >= 500, 'sample cap matches the PENDING_WRITES_CAP magnitude')
  const poison = Array.from({ length: 25 }, (_, i) => ({ key: i === 0 ? 'w8good' : '', value: 'p' + i }))
  const { state, meta, schema, close } = flushState(poison)
  const r = syncApply.flushPendingWrites(state)
  assert.equal(r.ok, true, 'ack semantics unchanged: valid siblings committed, quarantine surfaced')
  assert.equal(r.quarantined.length, 1)
  const parked = JSON.parse(meta['sync.flushQuarantine.settingsRowPutMany'])
  assert.equal(parked.length, 1)
  const rows = parked[0].rows.filter(x => !x || !x.truncated)
  assert.equal(rows.length, 24, 'all 24 rejected rows parked (red before the fix: only 20 sampled)')
  assert.ok(parked[0].count >= 24, 'the entry count reports the whole rejected batch')
  assert.equal(schema.rowsAll().filter(x => x.key === 'w8good').length, 1, 'the valid sibling landed')
  close()
})

/* ---------------- fix 5: oplog pointer ts fallback discriminates by entity ---------------- */

test('fix 5: ts-less meta pointers seed at 1, ts-less todo pointers seed at now', () => {
  freshDevice('oplog-ts')
  const before = Date.now()
  db.call('appendOplogPointers', [
    { entity: 'meta', id: 'w8metaKey' },
    { entity: 'todo', id: 'w8todoKey' },
  ])
  const rows = db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []
  const metaRow = rows.find(r => r.entity === 'meta' && r.entityId === 'w8metaKey')
  const todoRow = rows.find(r => r.entity === 'todo' && r.entityId === 'w8todoKey')
  assert.ok(metaRow, 'meta pointer seeded')
  assert.equal(metaRow.ts, 1, 'meta (no stored age) seeds epoch-oldest per the D13 doctrine')
  assert.ok(todoRow, 'todo pointer seeded')
  assert.ok(todoRow.ts >= before, 'todo (row-table entity) falls back to now, not epoch')
  db.close()
})

/* ---------------- fix 6: todo landing learns the peer userId instead of 840001 ---------------- */

test('fix 6: first-sync with no local todos stamps landed rows with the peer userId', () => {
  const state = freshDevice('userlearn')
  assert.equal(state.localUserId, null, 'nothing discovered yet')
  const now = Date.now()
  const ok = syncApply.applyRowSafe(state, {
    entity: 'todo',
    id: 'w8peer1',
    updatedAt: now,
    deleted: false,
    author: 'peerA',
    data: { taskId: 'w8peer1', taskContent: 'peer task', userId: 555123, updateTime: now, deleted: 0 },
  })
  assert.equal(ok, true, 'the todo landed')
  assert.equal(state.localUserId, 555123, 'the peer userId was learned')
  assert.equal(state.pendingWrites.todos.length, 1)
  assert.equal(state.pendingWrites.todos[0].userId, 555123, 'red before the fix: the row carried 840001')
  const memo = db.call('getMeta', 'sync.localUserId')
  assert.equal(memo, '555123', 'the learned id rode the durable machine-local memo')
  // a second landing uses the memoized id (not re-derived)
  syncApply.applyRowSafe(state, {
    entity: 'todo', id: 'w8peer2', updatedAt: now + 1, deleted: false, author: 'peerA',
    data: { taskId: 'w8peer2', taskContent: 'peer task 2', userId: 555123, updateTime: now + 1, deleted: 0 },
  })
  assert.equal(state.pendingWrites.todos[1].userId, 555123)
  db.close()
})

test('fix 6: an already-discovered local id is not overwritten by peer rows', () => {
  const state = freshDevice('userkeep')
  state.localUserId = 840002 // discovered from a local todo earlier this session
  const now = Date.now()
  syncApply.applyRowSafe(state, {
    entity: 'todo', id: 'w8peer3', updatedAt: now, deleted: false, author: 'peerB',
    data: { taskId: 'w8peer3', taskContent: 'x', userId: 999999, updateTime: now, deleted: 0 },
  })
  assert.equal(state.localUserId, 840002, 'evidence already exists — the peer id is NOT adopted')
  assert.equal(state.pendingWrites.todos[0].userId, 840002, 'landing keeps the discovered local id')
  db.close()
})
