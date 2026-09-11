/* W3 2026-09-12: syncTodos now routes through the atomic commitSyncBatch op.
 * Contract under test:
 *  1. The renderer emits exactly ONE dbCall: op 'commitSyncBatch' with { rows, version } —
 *     no separate upsertMany/setMeta pair (the two-step version had a crash window).
 *  2. Local in-memory semantics are unchanged: rows re-edited during the await are not
 *     wrongly marked synced; unedited snapshot rows are (status='sync', version=bumped).
 *  3. Empty snapshot: no dbCall at all; critical backup still dispatched via finally.
 * No electron required: fake commit/dispatch context, mockable window.todoAPI.dbCall.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const calls = []
let dbHandler = null
globalThis.window = {
  location: { hash: '' },
  todoAPI: {
    dbCall: (op, params) => {
      calls.push([op, params])
      return dbHandler ? dbHandler(op, params) : Promise.resolve(true)
    },
    writeCriticalStateBackup: () => Promise.resolve()
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const actions = todoMod.default.actions

const ROOT = { settings: { backupDir: '' }, auth: { user: { userId: 1 } }, category: { list: [] }, habits: { habits: [], moments: [], savedAt: 0 } }
const makeCtx = state => ({
  state,
  rootState: ROOT,
  rootGetters: {},
  commit: () => {},
  dispatch: async () => null
})
const row = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 't-' + taskId, delete: false, complete: false,
  updateTime: 1, status: 'add', version: 0
}, over)

beforeEach(() => {
  calls.length = 0
  dbHandler = null
})

test('syncTodos: single atomic op commitSyncBatch with rows + version; local status updates unchanged', async () => {
  // Note: like the pre-change code, only snapshot rows NOT at status 'update'/'delete' are marked synced
  // in memory (an 'update' row is assumed re-edited; its DB copy reaches the UI via the post-write reload)
  const rows = [row('a'), row('b', { status: 'add' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  dbHandler = async op => {
    if (op === 'commitSyncBatch') {
      // Simulate the user editing 'a' during the await: status flips back to update
      rows[0].status = 'update'
      return true
    }
    return null
  }
  await actions.syncTodos.call(todoMod.default, makeCtx(state))
  assert.equal(calls.length, 1, 'exactly one dbCall — no upsertMany/setMeta pair anymore')
  const [op, params] = calls[0]
  assert.equal(op, 'commitSyncBatch')
  assert.equal(params.version, state.version, 'post-bumpVersion value travels with the batch')
  assert.equal(params.rows.length, 2)
  // rows carry the full store shape (db layer forces status='sync'); the renderer itself need not pre-set it
  assert.deepEqual(params.rows.map(r => r.taskId).sort(), ['a', 'b'])
  assert.equal(rows[0].status, 'update', 're-edited during the await -> not marked synced (unchanged guard)')
  assert.equal(rows[1].status, 'sync', 'unedited snapshot row marked synced in memory')
  assert.equal(rows[1].version, state.version)
  assert.equal(state.isSyncing, false)
})

test('syncTodos: empty snapshot emits no dbCall (no wholesale write)', async () => {
  const state = { todoList: [row('a', { status: 'sync' })], recycleList: [], version: 5, isSyncing: false }
  await actions.syncTodos.call(todoMod.default, makeCtx(state))
  assert.equal(calls.length, 0)
})

test('syncTodos: rows already dirty at recycleList are included in the batch', async () => {
  const active = [row('a')]
  const recycled = [row('b', { delete: true, status: 'delete' })]
  const state = { todoList: active, recycleList: recycled, version: 0, isSyncing: false }
  await actions.syncTodos.call(todoMod.default, makeCtx(state))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1].rows.map(r => r.taskId).sort(), ['a', 'b'])
})
