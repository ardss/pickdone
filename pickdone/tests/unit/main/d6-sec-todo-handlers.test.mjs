/* D6 security round (2026-09-21) — handlers/todo.js route-level regressions:
 *   F1   commands:commit batch is per-item fault-isolating: an entry-k failure returns
 *        { results, failedIndex: k, error } with entries 0..k-1 COMMITTED (documented
 *        partial-commit semantics) instead of rejecting the whole invoke while the DB
 *        silently kept the earlier entries.
 *   F4b  the IPC commands:commit route strips caller opts.preserveStamp (main-process
 *        capability; observed via the bus fanout hook ctx).
 *   F5   ls-mirror classification end-to-end: row-list local keys and bare-string local
 *        payload keys kick NO sync round; user keys do.
 *   F3   db:purge-recycle-bin ABORTS when recycle-bin row collection fails (no rows deleted,
 *        no bus commit) instead of deleting rows with ids=[] and orphaning attachment files.
 * Real temp DB (gap-sync-kick pattern), electron/scheduler/audit stubbed.
 * Run: node --test tests/unit/main/d6-sec-todo-handlers.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd6-sec-todo-'))

const syncKicks = []
const busHookOpts = []
const realDb = require_('../../../src/main/db.js')
let failQueryTodos = false

// '../db' stub: the real module with an armed failure injector for the purge-abort test.
// (handlers/todo.js captures the module object at require time — same object identity here.)
const dbStub = Object.assign(Object.create(null), realDb)
dbStub.call = (op, params) => {
  if (op === 'queryTodos' && failQueryTodos) throw new Error('injected collect failure')
  return realDb.call(op, params)
}
const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../db': dbStub,
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

realDb.init(process.env.TODO_DB_DIR)
const bus = require_('../../../src/main/command-bus.js')
const todoHandlers = require_('../../../src/main/handlers/todo.js')

const MAIN = { webContents: { id: 'main' } }
const eMain = { sender: MAIN.webContents }
const api = todoHandlers({
  isLocked: () => false,
  isLockWindow: () => false,
  getMainWindow: () => MAIN,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: () => {},
  broadcastTodosChanged: () => {},
  dbApi: () => realDb,
  attachDir: () => process.env.TODO_DB_DIR,
  notifySyncChange: op => { syncKicks.push(op) }
})
// Observe what the 'commands:commit' route actually hands to bus.commit (hook ctx carries opts)
bus.onCommit('d6-opts-spy', ctx => { busHookOpts.push(ctx.opts) })

const rowOf = k => (realDb.call('settingsRowsAll', {}) || []).find(r => r.key === k) || null
const metaGet = k => realDb.call('getMeta', k)

test('F1: a fully successful batch returns { results, failedIndex: -1, error: null }', () => {
  const r = api['commands:commit'](eMain, [
    { entity: 'meta', verb: 'put', payload: ['d6batchKey', 'v1'] },
    { entity: 'setting', verb: 'put', payload: { key: 'd6batchRow', value: 'a' } }
  ])
  assert.equal(r.failedIndex, -1)
  assert.equal(r.error, null)
  assert.equal(r.results.length, 2)
  assert.equal(metaGet('d6batchKey'), 'v1')
  assert.equal(rowOf('d6batchRow').value, 'a')
})

test('F1: entry-k failure keeps entries 0..k-1 committed and reports failedIndex', () => {
  const r = api['commands:commit'](eMain, [
    { entity: 'meta', verb: 'put', payload: ['d6partialKey', 'kept'] }, // commits
    { entity: 'setting', verb: 'put', payload: { value: 'no-key' } }, // settingsRowPut throws: key required
    { entity: 'meta', verb: 'put', payload: ['d6neverKey', 'never'] } // never attempted
  ])
  assert.equal(r.failedIndex, 1, 'failure reported at index 1')
  assert.ok(/key/.test(r.error), 'error mentions the cause, got: ' + r.error)
  assert.equal(r.results.length, 1, 'only the committed prefix is in results')
  assert.equal(metaGet('d6partialKey'), 'kept', 'entry 0 IS committed (partial-commit semantics)')
  assert.equal(metaGet('d6neverKey'), null, 'entries after failedIndex were never attempted')
})

test('F1: unknown command still throws USAGE upfront (validation before ANY execution)', () => {
  assert.throws(() => api['commands:commit'](eMain, [
    { entity: 'meta', verb: 'put', payload: ['d6usageKey', 'v'] },
    { entity: 'nope', verb: 'wrong', payload: {} }
  ]), /unknown command/)
  assert.equal(metaGet('d6usageKey'), null, 'nothing executed when validation fails')
})

test('F4b: the IPC route strips caller opts.preserveStamp before bus.commit', () => {
  busHookOpts.length = 0
  api['commands:commit'](eMain, [
    { entity: 'setting', verb: 'put', payload: { key: 'd6stampRow', value: 1 }, opts: { preserveStamp: true, legitFlag: 'keep' } }
  ])
  assert.equal(busHookOpts.length, 1)
  const opts = busHookOpts[0]
  assert.ok(opts && 'preserveStamp' in opts === false, 'preserveStamp must be stripped, got: ' + JSON.stringify(opts))
  assert.equal(opts.legitFlag, 'keep', 'unrelated opts keys pass through')
})

test('F5: setting.putMany with a LOCAL row key kicks NO sync round (row-list per-element key)', () => {
  syncKicks.length = 0
  api['commands:commit'](eMain, [{ entity: 'setting', verb: 'putMany', payload: [{ key: 'sync.d6local', value: 1 }] }])
  assert.deepEqual(syncKicks, [], 'machine-local row-list write must not kick a sync round')
})

test('F5: setting.putMany with a user key DOES kick a sync round', () => {
  syncKicks.length = 0
  api['commands:commit'](eMain, [{ entity: 'setting', verb: 'putMany', payload: [{ key: 'd6userRow', value: 1 }] }])
  assert.deepEqual(syncKicks, ['settingsRowPutMany'])
})

test('F5: meta.delete with a bare-string LOCAL payload key kicks NO sync round', () => {
  realDb.call('setMeta', ['_d6localStamp', 'x'])
  syncKicks.length = 0
  api['commands:commit'](eMain, [{ entity: 'meta', verb: 'delete', payload: '_d6localStamp' }])
  assert.deepEqual(syncKicks, [], 'string local key must be classified local (old code saw undefined)')
})

test('F5: meta.delete with a bare-string USER payload key kicks a sync round', () => {
  realDb.call('setMeta', ['d6userMeta', 'x'])
  syncKicks.length = 0
  api['commands:commit'](eMain, [{ entity: 'meta', verb: 'delete', payload: 'd6userMeta' }])
  assert.deepEqual(syncKicks, ['deleteMeta'])
})

test('F3: purge ABORTS when recycle-bin collection fails — no rows deleted, no bus commit', () => {
  // A recycle-bin row that MUST survive the aborted purge
  realDb.call('upsert', {
    taskId: 'd6purgeVictim', userId: 1, taskContent: 'victim', taskDescribe: '', complete: false,
    completedAt: 0, deletedAt: Date.now(), delete: true, createTime: Date.now(), updateTime: Date.now(),
    syncTime: 0, scheduledAt: 0, scheduledDay: 0, remindAt: 0, sort: 0, focusMinutes: 0, difficulty: 0,
    recurGroupId: null, subtasks: null, imageUrls: null, fileAttach: null, categoryId: 0, priority: 0,
    deadlineTs: 0, important: 0, urgent: 0, status: 'add', version: 0, taskSort: 0, todoTime: 0,
    dayStart: 0, reminderTime: 0
  })
  failQueryTodos = true
  try {
    assert.throws(() => api['db:purge-recycle-bin'](eMain), /purge aborted/)
  } finally {
    failQueryTodos = false
  }
  const survivor = realDb.call('getById', 'd6purgeVictim')
  assert.ok(survivor, 'recycle-bin row must survive the aborted purge (no rows-without-files outcome)')
})
