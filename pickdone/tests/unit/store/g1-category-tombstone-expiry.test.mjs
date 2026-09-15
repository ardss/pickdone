/**
 * G1 regression [7] for store/category.js: LS tombstones of categories that were already PURGED
 * (hard-deleted past the recycle-bin window) must not be resurrected into state on every restart.
 * Fresh tombstones still re-attach (recoverable in App); pre-deletedAt legacy tombstones are
 * conservatively kept.
 * Run: node --test tests/unit/store/g1-category-tombstone-expiry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
const dbRows = { getAllCategories: async () => [{ categoryId: 99, userId: 840001, categoryName: 'Live', categoryColor: '#0f9d8f', createTime: 1, listSort: 50, folderIs: false, folderId: 0, delete: false }], getMeta: async () => null }
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: (op, p) => dbRows[op]?.(p) } }

const DAY = 86400000
const mk = (id, name, deletedAt) => ({ categoryId: id, userId: 840001, categoryName: name, categoryColor: '#f76e6e', createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: true, ...(deletedAt ? { deletedAt } : {}) })
LS.categoryState = JSON.stringify({ list: [
  mk(1, 'Fresh', Date.now() - 2 * DAY),
  mk(2, 'StalePurged', Date.now() - 40 * DAY),
  mk(3, 'LegacyNoStamp', 0)
] })

const mod = await import('../../../renderer/js/store/category.js')
const store = mod.default

function makeCtx (rootState) {
  const state = { list: [], projectIds: [], projectMeta: {} }
  const ctx = {
    state,
    rootState,
    commit (type, payload) { if (type === 'setList') state.list = payload; if (type === 'setProjectIds') state.projectIds = payload }
  }
  const thisStore = { dispatch: () => Promise.resolve() }
  return { state, call: () => store.actions.init.call(thisStore, ctx) }
}

test('G1 [7]: fresh tombstone re-attaches, purged-expired tombstone does not, legacy no-stamp is kept', async () => {
  const { state, call } = makeCtx({ settings: { recycleBinAutoDeleteDays: 30 } })
  await call()
  const ids = state.list.map(c => c.categoryId)
  assert.ok(ids.includes(1), 'fresh (2-day-old) tombstone is still recoverable in App')
  assert.ok(!ids.includes(2), '40-day-old tombstone beyond the 30-day window is NOT resurrected (was: ghost on every restart)')
  assert.ok(ids.includes(3), 'legacy tombstone without deletedAt is conservatively kept')
})

test('G1 [7]: a larger configured retention window keeps the tombstone; default is 30 days', async () => {
  const { state, call } = makeCtx({ settings: { recycleBinAutoDeleteDays: 60 } })
  await call()
  assert.ok(state.list.some(c => c.categoryId === 2), 'within a 60-day window the same tombstone still recovers')
  const { state: s2, call: c2 } = makeCtx({}) // no settings module at all
  await c2()
  assert.ok(!s2.list.some(c => c.categoryId === 2), 'missing settings falls back to the 30-day default')
})

test('G1 [7]: markCascade stamps deletedAt on newly created tombstones (expiry actually engages)', () => {
  const state = { list: [
    { categoryId: 10, folderIs: false, folderId: 0, delete: false },
    { categoryId: 11, folderIs: true, folderId: 10, delete: false },
    { categoryId: 12, folderIs: false, folderId: 11, delete: false }
  ] }
  const before = Date.now()
  store.mutations.markCascade(state, 10)
  for (const c of state.list) {
    assert.equal(c.delete, true, 'cascade marks the whole subtree')
    assert.ok(c.deletedAt >= before, 'every new tombstone carries a deletedAt stamp')
  }
})
