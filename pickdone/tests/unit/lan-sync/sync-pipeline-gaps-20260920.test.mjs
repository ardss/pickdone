/* F1/F2/F3 regression tests (sync pipeline gaps round, 2026-09-20) — apply/flush/broadcast layer
 * driven through the lan-sync-bootstrap __test hook with a mock db.call surface.
 * Run: node --test tests/unit/lan-sync/sync-pipeline-gaps-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  // M1 (2026-09-20): the sync hydration reads RAW category rows (categoriesAllRows), not the
  // hydrated getAllCategories app shape.
  categoriesAllRows: () => [],
  planAll: () => [],
  planTombstones: () => [],
  filterList: () => [],
  filterTombstones: () => [],
}

function mockState (tables = {}, writeImpl = {}, senders = []) {
  const calls = []
  const sent = []
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const db = {
    calls,
    call (op, params) {
      calls.push({ op, params })
      if (tables[op]) return tables[op](params)
      if (writeImpl[op]) return writeImpl[op](params)
      return null
    },
  }
  const state = {
    db,
    pendingWrites,
    applyCache: null,
    engine: null,
    node: null,
    timers: [],
    peerWatermarks: new Map(),
    pendingToSeq: 0,
    deviceId: 'dev-local',
    getWindowSenders: () => senders.map(s => ({ send: (ch, msg) => sent.push({ ch, msg }), isDestroyed: () => false })),
  }
  return { state, calls, pendingWrites, sent }
}

function fresh (tables, writeImpl, senders) {
  const m = mockState(tables, writeImpl, senders)
  __test.setState(m.state)
  return m
}

/* ---------- F1: blob-aware fold + external-habits-changed ---------- */

test('F1: applied habits rows fold into db.habitsState (not db.settingsState) and emit external-habits-changed', () => {
  const blobs = {
    'db.settingsState': JSON.stringify({ theme: 'dark' }),
    'db.habitsState': JSON.stringify({ schemaV: 2, habits: [{ id: 'h1', name: 'old', days: [] }], moments: [], savedAt: 1 }),
  }
  const m = fresh({
    ...EMPTY_TABLES,
    getMeta: k => (k in blobs ? blobs[k] : null),
    settingsRowsAll: () => [],
  }, {
    settingsRowPutMany: list => list.map(l => l.key),
    setMeta: ([k, v]) => { blobs[k] = v },
  }, ['win1'])
  const ok = __test.applyRow({
    entity: 'setting', id: 'habits', seq: 5, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0,
    data: { key: 'habits', value: JSON.stringify([{ id: 'h1', name: 'fresh', days: [1] }]) },
  })
  assert.equal(ok, true)
  assert.equal(__test.flushPendingWrites().ok, true)
  __test.emitAppliedRound()
  const habitsBlob = JSON.parse(blobs['db.habitsState'])
  assert.equal(habitsBlob.habits[0].name, 'fresh', 'habits field must land in the HABITS blob')
  assert.equal(JSON.parse(blobs['db.settingsState']).habits, undefined, 'habits field must NOT land in the settings blob')
  const evt = m.sent.find(s => s.ch === 'external-habits-changed')
  assert.ok(evt, 'renderer must be notified via external-habits-changed')
  assert.ok(Array.isArray(evt.msg.habits) && evt.msg.habits[0].name === 'fresh', 'payload: { habits: <parsed value> }')
  assert.equal(m.sent.find(s => s.ch === 'external-settings-changed'), undefined, 'no settings-channel broadcast for a habits-only patch')
})

test('F1: applied plain settings rows still fold into db.settingsState + external-settings-changed', () => {
  const blobs = {
    'db.settingsState': JSON.stringify({ theme: 'dark' }),
    'db.habitsState': JSON.stringify({ habits: [], moments: [], savedAt: 1 }),
  }
  const m = fresh({
    ...EMPTY_TABLES,
    getMeta: k => (k in blobs ? blobs[k] : null),
    settingsRowsAll: () => [],
  }, {
    settingsRowPutMany: list => list.map(l => l.key),
    setMeta: ([k, v]) => { blobs[k] = v },
  }, ['win1'])
  const ok = __test.applyRow({
    entity: 'setting', id: 'theme', seq: 6, ts: 300, updatedAt: 300, deleted: false, deletedAt: 0,
    data: { key: 'theme', value: JSON.stringify('light') },
  })
  assert.equal(ok, true)
  __test.flushPendingWrites()
  __test.emitAppliedRound()
  assert.equal(JSON.parse(blobs['db.settingsState']).theme, 'light', 'settings field lands in the settings blob')
  const evt = m.sent.find(s => s.ch === 'external-settings-changed')
  assert.ok(evt && evt.msg.theme === 'light')
  assert.equal(m.sent.find(s => s.ch === 'external-habits-changed'), undefined)
})

test('F1: the blob fold does not write settings rows itself (re-stamp guard lives in the setMeta bridge)', () => {
  // The fold must only ever write the BLOB (setMeta); the identical-content no-op in
  // db-sync-schema's putRow is what prevents the bridge from re-stamping newer rows backwards
  // (covered by the real-db bridge test in tests/unit/main/sync-pipeline-gaps-20260920.test.mjs).
  // Here: the local row is stale, the newer peer value applies (row write #1), and the fold that
  // follows must NOT add a second row write while still landing the value in the blob.
  const rowWrites = []
  const blobs = { 'db.habitsState': JSON.stringify({ habits: [], moments: [], savedAt: 1 }) }
  fresh({
    ...EMPTY_TABLES,
    getMeta: k => (k in blobs ? blobs[k] : null),
    settingsRowsAll: () => [{ key: 'savedAt', value: '5', updatedAt: 100, deleted: false, deletedAt: 0 }],
  }, {
    settingsRowPutMany: list => list.map(l => { rowWrites.push(l); return l.key }),
    setMeta: ([k, v]) => { blobs[k] = v },
  }, ['win1'])
  const ok = __test.applyRow({
    entity: 'setting', id: 'savedAt', seq: 9, ts: 600, updatedAt: 600, deleted: false, deletedAt: 0,
    data: { key: 'savedAt', value: '600' },
  })
  assert.equal(ok, true)
  __test.flushPendingWrites()
  assert.equal(rowWrites.length, 1, 'one row write: the original apply')
  __test.emitAppliedRound()
  assert.equal(rowWrites.length, 1, 'the fold must not write settings rows directly')
  assert.equal(JSON.parse(blobs['db.habitsState']).savedAt, 600, 'the new value must still land in the habits blob')
})

/* ---------- F2: category tombstones ---------- */

test('F2: inbound category tombstone lands via the bulk buffer with ordering metadata preserved', () => {
  const m = fresh({
    ...EMPTY_TABLES,
    // M1: raw row table shape (categoriesAllRows), live row.
    categoriesAllRows: () => [{ id: 'c1', name: 'Work', color: '#fff', createdAt: 1, sort: 0, isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 50 }],
  })
  const ok = __test.applyRow({ entity: 'category', id: 'c1', seq: 11, ts: 100, updatedAt: 100, deleted: true, deletedAt: 100, data: null })
  assert.equal(ok, true, 'tombstone winner must report applied')
  assert.equal(m.pendingWrites.categories.length, 1)
  const t = m.pendingWrites.categories[0]
  assert.equal(t.id, 'c1')
  assert.equal(t.deleted, 1)
  assert.equal(t.deletedAt, 100, 'peer deletedAt must survive (ordering metadata)')
  assert.equal(t.updatedAt, 100)
})

test('F2: ghost category tombstone (category never seen locally) is applied without materializing a row', () => {
  const m = fresh({ ...EMPTY_TABLES })
  const ok = __test.applyRow({ entity: 'category', id: 'ghost', seq: 12, ts: 100, updatedAt: 100, deleted: true, deletedAt: 100, data: null })
  assert.equal(ok, true, 'watermark advances')
  assert.equal(m.pendingWrites.categories.length, 0, 'no junk row for an unknown category')
})

test('F2: a newer live category re-add still wins over the tombstone round-trip', () => {
  // Device state: category already deleted locally (categoriesAllRows carries the tombstone row) —
  // the peer's newer live row (updatedAt > deletedAt) must land via upsertCategoryMany, in ROW
  // shape (M1: upsertCategory binds the row columns; updatedAt preserved so no re-stamp churn).
  const m = fresh({
    ...EMPTY_TABLES,
    categoriesAllRows: () => [{ id: 'c2', name: 'Old', color: '#000', createdAt: 1, sort: 0, isFolder: 0, parentId: 0, deleted: 1, deletedAt: 300, updatedAt: 300 }],
  })
  const ok = __test.applyRow({
    entity: 'category', id: 'c2', seq: 13, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0,
    data: { id: 'c2', name: 'Reborn', color: '#fff', createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 900 },
  })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.categories.length, 1)
  assert.equal(m.pendingWrites.categories[0].deleted, 0)
  assert.equal(m.pendingWrites.categories[0].name, 'Reborn')
  assert.equal(m.pendingWrites.categories[0].updatedAt, 900, 'inbound updatedAt must be preserved (M1 no-re-stamp)')
})

/* ---------- F3: plan/filter LWW ages ---------- */

test('F3a: a peer re-timed chip applies on a device that already has it (no more ageUnknown refusal)', () => {
  const m = fresh({
    ...EMPTY_TABLES,
    planAll: () => [{ id: 'pl_1', taskId: 't1', day: '2026-09-19', mm: '09:00', sort: 0, updatedAt: 100 }],
  })
  const ok = __test.applyRow({
    entity: 'plan', id: 'pl_1', seq: 14, ts: 500, updatedAt: 500, deleted: false, deletedAt: 0,
    data: { id: 'pl_1', taskId: 't1', day: '2026-09-20', mm: '10:30', sort: 0, updatedAt: 500 },
  })
  assert.equal(ok, true, 'newer peer edit must be applied (updatedAt 500 > local 100)')
  assert.equal(m.pendingWrites.plans.length, 1)
  assert.equal(m.pendingWrites.plans[0].day, '2026-09-20')
})

test('F3a: an older peer chip edit still loses to the local newer edit', () => {
  const m = fresh({
    ...EMPTY_TABLES,
    planAll: () => [{ id: 'pl_1', taskId: 't1', day: '2026-09-20', mm: '10:30', sort: 0, updatedAt: 800 }],
  })
  const ok = __test.applyRow({
    entity: 'plan', id: 'pl_1', seq: 15, ts: 500, updatedAt: 500, deleted: false, deletedAt: 0,
    data: { id: 'pl_1', taskId: 't1', day: '2026-09-19', mm: '09:00', sort: 0, updatedAt: 500 },
  })
  assert.equal(ok, false, 'local newer edit must stand')
  assert.equal(m.pendingWrites.plans.length, 0)
})

test('F3a: a peer chip move (delete old + add is a single day change) lands; task-level deletes land per chip', () => {
  // planDeleteTask now logs per-chip pointers; on the receiving side a chip pointer whose row was
  // locally re-added newer must NOT resurrect-delete it (deletedAt vs updatedAt ordering).
  fresh({
    ...EMPTY_TABLES,
    planAll: () => [{ id: 'pl_9', taskId: 't9', day: '2026-09-19', mm: '08:00', sort: 0, updatedAt: 900 }],
  })
  const ok = __test.applyRow({ entity: 'plan', id: 'pl_9', seq: 16, ts: 100, updatedAt: 100, deleted: true, deletedAt: 100, data: null })
  assert.equal(ok, false, 'older tombstone (100) must lose to the local newer chip (updatedAt 900)')
})

test('F3b: a peer-renamed filter applies on a device that already has it', () => {
  const m = fresh({
    ...EMPTY_TABLES,
    filterList: () => [{ id: 7, name: 'Old name', conds: { dateMode: 'all' }, sort: 0, updatedAt: 100 }],
  })
  const ok = __test.applyRow({
    entity: 'filter', id: '7', seq: 17, ts: 700, updatedAt: 700, deleted: false, deletedAt: 0,
    data: { id: 7, name: 'New name', conds: { dateMode: 'all' }, sort: 0, updatedAt: 700 },
  })
  assert.equal(ok, true, 'known local age must allow the newer peer rename')
  assert.equal(m.pendingWrites.filters.length, 1)
  assert.equal(m.pendingWrites.filters[0].name, 'New name')
})
