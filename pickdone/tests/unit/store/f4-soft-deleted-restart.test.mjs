/* F4 regression #2 (2026-09-15): soft-deleted categories must survive a restart inside the renderer
 * state so the in-app recovery entry stays reachable. category.init pulls getAllCategories, which is
 * live-only (WHERE deleted = 0), and used to setList(rows) — wiping every tombstone: visibleCount
 * dropped to 0 after restart and a CLI-deleted-then-restarted category could never be recovered from
 * the App, contradicting the CLI's "recoverable in App" promise. init now re-merges the LS-mirrored
 * deleted entries (kept alive by persist()) under the live DB rows. No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = {}
globalThis.localStorage = {
  getItem: k => LS[k] ?? null,
  setItem: (k, v) => { LS[k] = v },
  removeItem: k => { delete LS[k] }
}
const dbRows = {
  getAllCategories: async () => [
    { categoryId: 1, userId: 840001, categoryName: 'Work', categoryColor: '#0f9d8f', createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: false }
  ],
  getMeta: async () => null
}
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: (op, p) => dbRows[op]?.(p) } }

// Seed the LS mirror the way persist() writes it: one live + one soft-deleted category
LS.categoryState = JSON.stringify({ list: [
  { categoryId: 1, userId: 840001, categoryName: 'Work', categoryColor: '#0f9d8f', createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: false },
  { categoryId: 2, userId: 840001, categoryName: 'Old', categoryColor: '#f76e6e', createTime: 2, listSort: 200, folderIs: false, folderId: 0, delete: true }
] })

const mod = await import('../../../renderer/js/store/category.js')
const store = mod.default

function makeCtx () {
  const state = { list: [], projectIds: [], projectMeta: {} }
  const ctx = {
    state,
    commit (type, payload) { if (type === 'setList') state.list = payload; if (type === 'setProjectIds') state.projectIds = payload }
  }
  ctx.thisStore = { dispatch (type) { return store.actions[type.split('/')[1]].call(thisStore, ctx) } }
  const thisStore = { dispatch: (type) => { /* loadProjectMeta is a no-op with empty projectIds */ return Promise.resolve() } }
  return { state, call: () => store.actions.init.call(thisStore, ctx) }
}

test('F4: init re-merges LS-mirrored soft-deleted categories after restart', async () => {
  const { state, call } = makeCtx()
  const n = await call()
  assert.equal(n, 1, 'live row count unchanged')
  assert.equal(state.list.length, 2, 'deleted entry restored alongside the live rows')
  const gone = state.list.find(c => c.categoryId === 2)
  assert.ok(gone && gone.delete === true, 'restored entry keeps its tombstone flag')
  assert.equal(store.getters.visibleCount(state), 1, 'visibleCount sees the recoverable category again')
  assert.equal(store.getters.byId(state)(2), null, 'deleted entry still falls back to uncategorized in views')
  // LS mirror must keep the tombstone after the init-time persist() rewrite
  const mirrored = JSON.parse(LS.categoryState).list
  assert.ok(mirrored.some(c => c.categoryId === 2 && c.delete), 'persist() keeps the deleted mirror')
})

test('F4: a category re-added live in the DB wins over its stale LS tombstone', async () => {
  dbRows.getAllCategories = async () => [
    { categoryId: 2, userId: 840001, categoryName: 'Old', categoryColor: '#f76e6e', createTime: 2, listSort: 200, folderIs: false, folderId: 0, delete: false }
  ]
  const { state, call } = makeCtx()
  await call()
  const rows = state.list.filter(c => c.categoryId === 2)
  assert.equal(rows.length, 1, 'no duplicate entry')
  assert.equal(rows[0].delete, false, 'live DB row wins')
})
