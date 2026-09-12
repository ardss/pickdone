/* H6 regression (2026-09-12): syncTodos' catch-path retry-enqueue must carry the snapshot-time
 * version (serverV), not the live state.version. Bug: `const serverV` lived inside the try, so
 * the catch unreachable-ly fell back to `state.version` — if the user edited during the await
 * (bumpVersion elsewhere) the queued commitSyncBatch would push the quit-flush replay cursor past
 * rows that were never sent, and the db layer would force status:'sync' onto that newer content.
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
  commit: (type) => { if (type === 'bumpVersion') state.version++ },
  dispatch: async () => null
})
const row = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 't-' + taskId, delete: false, complete: false,
  updateTime: 1, status: 'add', version: 0
}, over)

beforeEach(() => {
  calls.length = 0
  dbHandler = null
  todoMod._testInternals.pendingUpserts.splice(0, todoMod._testInternals.pendingUpserts.length)
})

test('syncTodos failure: retry-enqueue keeps the snapshot-time version even if version was bumped during the await', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  dbHandler = async () => {
    // Simulate concurrent local activity while the batch is in flight: the version cursor advances
    state.version = 7
    throw new Error('network down')
  }
  await actions.syncTodos.call(todoMod.default, makeCtx(state))
  const queued = todoMod._testInternals.pendingUpserts
  assert.equal(queued.length, 1, 'failed batch enqueued for retry')
  assert.equal(queued[0].op, 'commitSyncBatch')
  assert.equal(queued[0].params.version, 1,
    'enqueue carries the snapshot version (post-bump at snapshot time = 1), NOT the live version (7) — replay must not skip unsent edits')
  assert.deepEqual(queued[0].params.rows.map(r => r.taskId), ['a'])
})

test('syncTodos success path unchanged: rows carry the bumped version', async () => {
  const rows = [row('a')]
  const state = { todoList: rows, recycleList: [], version: 3, isSyncing: false }
  await actions.syncTodos.call(todoMod.default, makeCtx(state))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].version, 4, 'batch carries post-bumpVersion value')
  assert.equal(rows[0].status, 'sync')
  assert.equal(rows[0].version, 4)
  assert.equal(todoMod._testInternals.pendingUpserts.length, 0, 'nothing enqueued on success')
})
