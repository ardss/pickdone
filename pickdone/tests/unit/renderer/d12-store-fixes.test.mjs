/**
 * D12 store/renderer fixes — behavior regression tests (node:test, no Vue, no Electron).
 * These drive the REAL modules (imported ESM) with stubbed window/IPC and assert the fix, not the source.
 *
 * Covered: Fault-1 isStaleBatchError shared predicate + stale-batch queue splice,
 *          Fault-2 supersedePendingBatch on retry enqueue,
 *          Sync-13 todoBackup degraded-segment flag,
 *          Fault-12 i18n setLocale survives a throwing localStorage.
 *
 * Run: node --test tests/unit/renderer/d12-store-fixes.test.mjs
 * Isolation: pure node --test; window.todoAPI stubbed; no real %APPDATA% touched.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-d12-store-'))
process.env.TODO_DB_DIR = path.join(process.env.TODO_USER_DATA_DIR, 'db')

// i18n/index.js (reached via utils/core.js) touches window at module scope — stub it before ANY import
globalThis.window = {}
const pendingMod = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js')
const todoSyncMod = await import('../../../renderer/js/store/helpers/todoSync.js')
const todoBackup = await import('../../../renderer/js/store/helpers/todoBackup.js')

function resetQueue () {
  const q = pendingMod.pendingUpserts()
  q.splice(0, q.length)
}

/* ---------------- Fault-1: isStaleBatchError shared predicate ---------------- */

test('Fault-1: isStaleBatchError matches the db-layer rejection shape and nothing else', () => {
  const { isStaleBatchError } = pendingMod
  assert.equal(isStaleBatchError(new Error('[TodoDB] commitSyncBatch: version 1 < current todosVersion 5 — stale batch rejected')), true)
  assert.equal(isStaleBatchError({ message: 'commitSyncBatch: version 1 < 2 — stale batch rejected' }), true)
  assert.equal(isStaleBatchError(new Error('network down')), false)
  assert.equal(isStaleBatchError(null), false)
  assert.equal(isStaleBatchError(undefined), false)
  // message-less throwables fall back to their string form
  assert.equal(isStaleBatchError('stale batch rejected'), true)
})

/* ---------------- Fault-2: supersedePendingBatch ---------------- */

test('Fault-2: supersedePendingBatch drops queued commitSyncBatch entries at or below the version', () => {
  resetQueue()
  pendingMod.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [{ taskId: 'a' }], version: 3 } })
  pendingMod.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [{ taskId: 'b' }], version: 5 } })
  pendingMod.queuePendingUpsert({ op: 'upsert', params: { taskId: 'c' } })
  pendingMod.supersedePendingBatch(5)
  const q = pendingMod.pendingUpserts()
  assert.equal(q.length, 1, 'both stale batches (v3, v5) are spliced, the row upsert stays')
  assert.equal(q[0].op, 'upsert')
  assert.equal(pendingMod.supersedePendingBatch(null), undefined, 'null version is a no-op')
  resetQueue()
})

test('Fault-2: a NEWER queued batch survives supersedePendingBatch', () => {
  resetQueue()
  pendingMod.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [], version: 9 } })
  pendingMod.supersedePendingBatch(5)
  assert.equal(pendingMod.pendingUpserts().length, 1, 'v9 > v5 is not superseded')
  resetQueue()
})

/* -------- Fault-1 wiring: syncTodosCore splices a doomed batch on stale rejection -------- */

const row = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 't-' + taskId, delete: false, complete: false,
  updateTime: 1, status: 'add', version: 0
}, over)

function makeSyncCtx (state, dbImpl) {
  globalThis.window = globalThis.window || {}
  globalThis.window.todoAPI = { dbCall: dbImpl }
  return {
    state,
    rootState: { settings: { backupDir: '' }, auth: { user: { userId: 1 } }, category: { list: [] }, habits: { habits: [], moments: [], savedAt: 0 } },
    rootGetters: {},
    commit: (type) => { if (type === 'bumpVersion') state.version++ },
    dispatch: async () => null
  }
}

beforeEach(() => { resetQueue(); globalThis.window = {} })
afterEach(() => { delete globalThis.window })

const STALE_ERR = () => new Error('[TodoDB] commitSyncBatch: version 1 < current todosVersion 5 — stale batch rejected')

test('Fault-1: a stale rejection splices the previously queued doomed batch out of the retry queue', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  // seed the queue with the doomed batch (a previous failure of the same version queued it)
  pendingMod.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [{ taskId: 'a' }], version: 1 } })
  await todoSyncMod.syncTodosCore(makeSyncCtx(state, async () => { throw STALE_ERR() }))
  assert.equal(pendingMod.pendingUpserts().length, 0, 'the doomed batch is spliced, not left for every quit flush')
})

test('Fault-1: a transient failure still enqueues the batch for retry (unchanged contract)', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  await todoSyncMod.syncTodosCore(makeSyncCtx(state, async () => { throw new Error('network down') }))
  const q = pendingMod.pendingUpserts()
  assert.equal(q.length, 1)
  assert.equal(q[0].op, 'commitSyncBatch')
  assert.equal(q[0].params.version, state.version)
})

test('Fault-2 wiring: a retried batch supersedes the older queued copy of the same batch', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  // an older failed attempt already queued this batch; the retry must not stack a duplicate
  pendingMod.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [{ taskId: 'a', stale: true }], version: 1 } })
  await todoSyncMod.syncTodosCore(makeSyncCtx(state, async () => { throw new Error('network down') }))
  const q = pendingMod.pendingUpserts()
  assert.equal(q.length, 1, 'older queued batch copy is superseded, not stacked')
  assert.equal(q[0].params.version, 1)
  assert.equal(q[0].params.rows[0].stale, undefined, 'the surviving entry is the NEW copy')
})

/* ---------------- Sync-13: degraded-segment flag ---------------- */

const STATE = {
  todoList: [{ taskId: 't1', repeatId: 'r1' }],
  recycleList: [],
  category: { list: [{ categoryId: 'c1' }] },
  habits: { habits: [], moments: [], savedAt: 0 }
}

test('Sync-13: a failed collector marks the segment; the dump carries a degradedSegments marker', async () => {
  globalThis.window = { todoAPI: {
    dbCall: async () => { throw new Error('ipc down') },
    getMetaMany: async () => { throw new Error('ipc down') },
    runAutoBackup: async () => ({ ok: true })
  } }
  try {
    const planState = await todoBackup.collectPlanState()
    const metaState = await todoBackup.collectMetaState(STATE, STATE)
    assert.equal(planState, null)
    assert.equal(metaState, null)
    const degraded = todoBackup.consumeDegradedSegments()
    assert.deepEqual(degraded.sort(), ['metaState', 'planState'], 'both failed collections are flagged')
  } finally { delete globalThis.window }
})

test('Sync-13: buildBackupDump emits the marker only when non-empty (clean dumps stay byte-stable)', () => {
  const clean = todoBackup.buildBackupDump(STATE, STATE, { metaState: null })
  assert.equal(clean.backup.degradedSegments, undefined, 'no marker on a clean dump (JSON.stringify drops undefined)')
  const dirty = todoBackup.buildBackupDump(STATE, STATE, { metaState: null, degradedSegments: ['planState'] })
  // the dump is JSON.stringify'd as a whole downstream — the marker rides as a plain array
  assert.deepEqual(JSON.parse(JSON.stringify(dirty)).backup.degradedSegments, ['planState'])
})

test('Sync-13: empty (non-degraded) data does NOT flag the segment', async () => {
  globalThis.window = { todoAPI: {
    dbCall: async () => [], // no chips: a normal state, not a failure
    getMetaMany: async () => [{ key: 'repeatRule:r1', value: 'x' }],
    runAutoBackup: async () => ({ ok: true })
  } }
  try {
    await todoBackup.collectPlanState()
    await todoBackup.collectMetaState(STATE, STATE)
    assert.deepEqual(todoBackup.consumeDegradedSegments(), [], 'empty result set is not a degradation')
  } finally { delete globalThis.window }
})

/* ---------------- Fault-12: setLocale survives a throwing localStorage ---------------- */

test('Fault-12: setLocale with a throwing localStorage still switches the active locale', async () => {
  globalThis.window = {} // beforeEach removed it; i18n/index.js touches window at module scope
  const i18nMod = await import('../../../renderer/js/i18n/index.js')
  const i18n = i18nMod.default
  const origLS = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => { throw new Error('SecurityError') },
    setItem: () => { throw new Error('SecurityError') }
  } })
  try {
    globalThis.window = {}
    assert.doesNotThrow(() => i18nMod.setLocale('en-US'), 'a storage-blocked host must not break the language switch')
    assert.equal(i18n.global.locale, 'en-US', 'the in-memory locale still switched')
  } finally {
    delete globalThis.window
    if (origLS) Object.defineProperty(globalThis, 'localStorage', origLS)
    else delete globalThis.localStorage
  }
})
