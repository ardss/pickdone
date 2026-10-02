/**
 * D15 domain-4 renderer regressions — B4 (projectDocs in the catProjectMetaBak roundtrip),
 * B6 (stamped catFiltersBak keys written at delete time, restored on recover), B7 (softDelete
 * prunes the durable legacy projectCategoryIds blob like the CLI twin), B15 (init() re-merges
 * in-retention LS tombstones even when ZERO live categories come back from the DB — the
 * recover entry must survive the delete-all-then-restart case).
 *
 * Run: node --test tests/unit/renderer/d15-category-backup-chain.test.mjs
 * Isolation: tests/setup.mjs shims; window.todoAPI.dbCall stubbed; localStorage is in-memory.
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CAT_ID = 777001
const DAY = 86400000
const docsKey = 'projectDocs:' + CAT_ID
const bakKey = 'catProjectMetaBak.' + CAT_ID
const pendingKey = 'catProjectMetaBak.pending.' + CAT_ID
const idsKey = 'projectCategoryIds'

const meta = {}
const puts = []
let liveCategories = []
let legacyIdsBlob = '[]'

const dbCall = (op, p) => {
  if (op === 'getMeta') return Promise.resolve(meta[p] != null ? meta[p] : null)
  if (op === 'setMeta') { const [k, v] = p; meta[k] = v; puts.push(['setMeta', k, v]); return Promise.resolve(true) }
  if (op === 'deleteMeta') { delete meta[p]; puts.push(['deleteMeta', p]); return Promise.resolve(true) }
  if (op === 'getAllCategories') return Promise.resolve(liveCategories)
  if (op === 'getMetaMany') return Promise.resolve((p || []).map(k => ({ key: k, value: meta[k] ?? null })))
  puts.push([op, p])
  return Promise.resolve(null)
}
if (!globalThis.window) globalThis.window = {}
globalThis.window = Object.assign(globalThis.window, { location: { hash: '' }, todoAPI: { dbCall } })

const LS = globalThis.localStorage
const mkLive = id => ({ categoryId: id, userId: 840001, categoryName: 'P' + id, categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false })

const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const tick = () => new Promise(r => setImmediate(r))
const makeStore = filters => new Vuex.createStore({
  modules: Object.assign({ category }, filters ? { filters } : {})
})

async function seedAndInit () {
  LS.setItem('categoryState', JSON.stringify({ list: [mkLive(CAT_ID)] }))
  liveCategories = [mkLive(CAT_ID)]
  const store = makeStore()
  await store.dispatch('category/init')
  return store
}

test('B4: softDelete backs up projectDocs into catProjectMetaBak and clears the live key; recover restores it', async () => {
  for (const k of Object.keys(meta)) delete meta[k]
  meta[docsKey] = '[{"id":"d1","title":"PRD"}]'
  const store = await seedAndInit()
  store.commit('category/softDelete', CAT_ID)
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(meta[docsKey], undefined, 'live docs key cleared after the backup landed')
  assert.equal(meta[pendingKey], undefined, 'roundtrip completed')
  const blob = JSON.parse(meta[bakKey])
  assert.equal(blob.docs, '[{"id":"d1","title":"PRD"}]', 'docs ride the backup blob')
  store.commit('category/recover', CAT_ID)
  for (let i = 0; i < 30; i++) await tick()
  assert.equal(meta[docsKey], '[{"id":"d1","title":"PRD"}]', 'recover restores the documents to the live key')
})

test('B7: softDelete prunes the durable legacy projectCategoryIds blob (CLI-twin parity)', async () => {
  for (const k of Object.keys(meta)) delete meta[k]
  legacyIdsBlob = JSON.stringify([CAT_ID, 999009])
  meta[idsKey] = legacyIdsBlob
  const store = await seedAndInit()
  store.commit('category/softDelete', CAT_ID)
  for (let i = 0; i < 30; i++) await tick()
  const rewrite = puts.find(x => x[0] === 'setMeta' && x[1] === idsKey)
  assert.ok(rewrite, 'a legacy-blob rewrite was issued at delete time')
  assert.deepEqual(JSON.parse(rewrite[2]), [999009], 'only the victim id is pruned, the survivor stays')
})

test('B6: softDelete stamps the doomed-filters backup key with the tombstone deletedAt; recover reads the stamped key', async () => {
  for (const k of Object.keys(meta)) delete meta[k]
  const store = makeStore({
    namespaced: true,
    state: () => ({ list: [{ id: 'f1', name: 'On P', conds: { catId: CAT_ID }, sort: 1 }] }),
    mutations: { setList (s, l) { s.list = l } }
  })
  LS.setItem('categoryState', JSON.stringify({ list: [mkLive(CAT_ID)] }))
  liveCategories = [mkLive(CAT_ID)]
  await store.dispatch('category/init')
  store.commit('category/softDelete', CAT_ID)
  for (let i = 0; i < 20;) await tick(), i++
  // markCascade stamps its OWN deletedAt at delete time (overwriting any preset) — the backup key
  // must carry exactly that stamp so the startup GC can bound its age.
  const stamp = store.state.category.list[0].deletedAt
  const stampedKey = 'catFiltersBak.' + stamp + '.' + CAT_ID
  assert.ok(stamp > 0, 'tombstone carries a deletion stamp')
  assert.ok(meta[stampedKey], 'filters backup written under the stamped key (GC-able, bounded by the recover window)')
  assert.ok(!meta['catFiltersBak.' + CAT_ID], 'no unstamped fallback key when the stamp is known')
  // recover: filter restore must find + consume the stamped key
  store.commit('category/recover', CAT_ID)
  for (let i = 0; i < 30; i++) await tick()
  assert.equal(meta[stampedKey], undefined, 'stamped backup deleted after restore')
  assert.ok(puts.some(x => x[0] === 'filterUpsert' && x[1] && x[1].id === 'f1'), 'filter rows re-put through the bus (filterUpsert)')
})

test('B15: init() re-merges in-retention LS tombstones when ZERO live categories come back (delete-all + restart)', async () => {
  for (const k of Object.keys(meta)) delete meta[k]
  meta.categoryLsMigrated = '1' // post-migration boots: the old `if (rows.length)` gate hit setListFromDb([])
  liveCategories = [] // every category hard-state is gone from the live read
  const freshTomb = { categoryId: 555, userId: 840001, categoryName: 'Recent', categoryColor: '#c0c0c0', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: true, deletedAt: Date.now() - 2 * DAY }
  const staleTomb = { categoryId: 556, userId: 840001, categoryName: 'Old', categoryColor: '#c0c0c0', createTime: 1, listSort: 2, folderIs: false, folderId: 0, delete: true, deletedAt: Date.now() - 40 * DAY }
  LS.setItem('categoryState', JSON.stringify({ list: [freshTomb, staleTomb] }))
  const store = makeStore()
  const n = await store.dispatch('category/init')
  assert.equal(n, 0, 'zero LIVE categories is still a zero')
  const list = store.state.category.list
  assert.ok(list.some(c => c.categoryId === 555 && c.delete), 'in-retention tombstone survives the zero-live-categories boot — the recover entry stays visible')
  assert.ok(!list.some(c => c.categoryId === 556), 'expired tombstone is still NOT resurrected (G1 holds on the new path)')
})

test('B15: a FAILED DB read still skips the merge (no tombstone writes against an unreadable DB)', async () => {
  const prevCall = globalThis.window.todoAPI.dbCall
  globalThis.window.todoAPI.dbCall = op => op === 'getAllCategories' ? Promise.reject(new Error('db gone')) : prevCall(op)
  try {
    const before = LS.getItem('categoryState')
    const store = makeStore()
    const n = await store.dispatch('category/init')
    assert.equal(n, -1)
    assert.equal(LS.getItem('categoryState'), before, 'LS cache untouched on read failure')
  } finally {
    globalThis.window.todoAPI.dbCall = prevCall
  }
})
