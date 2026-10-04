/** D17 DOM2 renderer fix: purgeIds / purgeAllRecycle scrub milestones across ALL live categories —
 *  a milestone of ANOTHER project category may link the purged id; the old purged-rows'-own-category
 *  filter left phantom taskIds there (CLI parity: cli/lib.js scans every projectMilestones: key — the
 *  renderer bridge has no listMetaKeys, so rootState.category.list is the equivalent enumeration).
 *  Harness mirrors tests/unit/renderer/d5-store-fixes.test.mjs [11].
 *  Run: node --test tests/unit/renderer/d17-domain2-milestone-scrub.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dbCalls = []
const metaStore = new Map()
let dbImpl = async () => 'ok'
if (!globalThis.globalThis.window.location) globalThis.globalThis.window.location = { hash: '' }
globalThis.globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    return dbImpl(op, params)
  },
  notification: () => {},
  purgeRecycleBin: async () => true,
  deleteTodoFilesMany: async () => {}
}
const callsOf = op => dbCalls.filter(([o]) => o === op).map(([, p]) => p)

const todo = (await import('../../../renderer/js/store/todo.js')).default

test('purgeIds scrubs the purged id from a milestone of ANOTHER category (cross-category link)', async () => {
  dbCalls.length = 0
  metaStore.clear()
  dbImpl = async op => (op === 'hardDelete' ? true : 'ok')
  // cat 7 = the purged row's own category; cat 9 = a DIFFERENT project whose milestone links the id
  metaStore.set('projectMilestones:7', JSON.stringify([
    { id: 'm7', title: 'own cat', date: 1, taskIds: ['purgeme', 'keep7'] }
  ]))
  metaStore.set('projectMilestones:9', JSON.stringify([
    { id: 'm9', title: 'other cat', date: 1, taskIds: ['purgeme', 'keep9'] }
  ]))
  const st = {
    todoList: [], recycleList: [
      { taskId: 'purgeme', categoryId: 7, delete: true },
      { taskId: 'keep7', categoryId: 7, delete: false }
    ], undoStack: [], redoStack: []
  }
  const ctx = {
    commit: (n, p) => { if (todo.mutations[n]) todo.mutations[n](st, p) },
    dispatch: () => {},
    state: st,
    rootState: { tomato: {}, settings: { recycleBinAutoDeleteDays: 30 }, category: { list: [{ categoryId: 7, delete: false }, { categoryId: 9, delete: false }] } }
  }
  await todo.actions.purgeIds.call({ state: { todo: st } }, ctx, ['purgeme'])
  const saved9 = callsOf('setMeta').find(([k]) => k === 'projectMilestones:9')
  assert.ok(saved9, 'the OTHER category\'s milestone blob was rewritten')
  const list9 = JSON.parse(saved9[1])
  assert.deepEqual(list9[0].taskIds, ['keep9'], 'phantom cross-category taskId scrubbed, live link kept')
  const saved7 = callsOf('setMeta').find(([k]) => k === 'projectMilestones:7')
  assert.ok(saved7, 'own-category blob still scrubbed')
  assert.deepEqual(JSON.parse(saved7[1])[0].taskIds, ['keep7'])
})

test('purgeAllRecycle uses the same all-categories enumeration', async () => {
  dbCalls.length = 0
  metaStore.clear()
  metaStore.set('projectMilestones:9', JSON.stringify([{ id: 'm9', title: 'x', date: 1, taskIds: ['gone1', 'live'] }]))
  const st = {
    todoList: [], recycleList: [{ taskId: 'gone1', categoryId: 7, delete: true }], undoStack: [], redoStack: []
  }
  const ctx = {
    commit: (n, p) => { if (todo.mutations[n]) todo.mutations[n](st, p) },
    dispatch: () => {},
    state: st,
    rootState: { tomato: {}, settings: { recycleBinAutoDeleteDays: 30 }, category: { list: [{ categoryId: 7, delete: false }, { categoryId: 9, delete: false }] } }
  }
  const ok = await todo.actions.purgeAllRecycle.call({ state: { todo: st } }, ctx)
  assert.equal(ok, true)
  const saved9 = callsOf('setMeta').find(([k]) => k === 'projectMilestones:9')
  assert.ok(saved9, 'cross-category milestone scrubbed on the bulk path')
  assert.deepEqual(JSON.parse(saved9[1])[0].taskIds, ['live'])
})
