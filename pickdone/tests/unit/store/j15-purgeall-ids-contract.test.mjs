/**
 * [J15 2026-10-22] purgeAllRecycle must accept the main side's IDS-ARRAY success contract — RED-first pin.
 *
 * Live finding (journey-audit round 2, j14b/j14c): db.purgeRecycleBin returns the PHYSICALLY
 * purged task ids (row-granular contract — the oplog expands them into per-id tombstone pointers,
 * src/main/db.js "Returns purged ids"), but store/todo.js checked `=== true`. Every successful
 * purge-all was therefore classified as a FAILURE: the 清空失败 toast fired while the rows WERE
 * hard-deleted — an in-session ghost bin that "revived" until reboot.
 *
 * Run: node --test tests/unit/store/j15-purgeall-ids-contract.test.mjs
 */
import '../../setup.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let cleanupGlobals = () => {}
before(async () => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const core = await import('../../../renderer/js/utils/core.js')
  w.dayjs = core.dayjs
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({ window: w, document: w.document, navigator: w.navigator })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})
after(() => { cleanupGlobals() })

const todo = (await import('../../../renderer/js/store/todo.js')).default
const settings = (await import('../../../renderer/js/store/settings.js')).default

function makeEnv (purgeImpl) {
  const row = (id, content) => ({
    taskId: id, taskContent: content, dayStart: 0, todoTime: 0, createTime: 1, updateTime: 2,
    deletedAt: Date.now(), delete: true, complete: false, categoryId: 0, status: 'delete', version: 0
  })
  const todoState = {
    todoList: [],
    recycleList: [row('id1', '甲'), row('id2', '乙')],
    undoStack: [], redoStack: [], viewsDirty: true
  }
  const commits = []
  const ctx = {
    state: { todo: todoState, todoList: todoState.todoList, recycleList: todoState.recycleList },
    rootState: { settings: { ...settings.state }, tomato: null, category: { list: [] } },
    commit (type, payload) {
      commits.push([type, payload])
      if (type === 'hardRemove' && todo.mutations.hardRemove) todo.mutations.hardRemove(todoState, payload)
    },
    dispatch (type) {
      if (type === 'writeEventBackup') return Promise.resolve(true)
      return Promise.resolve(null)
    }
  }
  globalThis.window.todoAPI = {
    purgeRecycleBin: purgeImpl,
    deleteTodoFilesMany: async () => {},
    dbCall: async () => []
  }
  const fakeThis = { state: { todo: todoState } }
  return { ctx, commits, todoState, fakeThis }
}

test('j15: purgeAllRecycle succeeds when the preload returns the purged-ids ARRAY (main contract)', async () => {
  const { ctx, todoState, fakeThis } = makeEnv(async () => ['id1', 'id2'])
  const ok = await todo.actions.purgeAllRecycle.call(fakeThis, ctx)
  assert.equal(ok, true, 'an ids-array ACK is a SUCCESS — the old === true check called it a failure while the DB was purged')
  assert.deepEqual(todoState.recycleList.map(t => t.taskId), [], 'the in-session ghost rows must leave the bin')
})

test('j15: an empty ids array (nothing was deletable) is still an ACK, not a failure', async () => {
  const { ctx, fakeThis } = makeEnv(async () => [])
  const ok = await todo.actions.purgeAllRecycle.call(fakeThis, ctx)
  assert.equal(ok, true, 'the op ACKed; the return shape must not be read as failure')
})

test('j15: a real purgeRecycleBin rejection stays a failure (honest-failure rule intact)', async () => {
  const { ctx, todoState, fakeThis } = makeEnv(async () => { throw new Error('ipc down') })
  const ok = await todo.actions.purgeAllRecycle.call(fakeThis, ctx)
  assert.equal(ok, false, 'a genuine IPC failure must keep the honest-failure path')
  assert.equal(todoState.recycleList.length, 2, 'rows stay in the bin when the purge did not happen')
})
