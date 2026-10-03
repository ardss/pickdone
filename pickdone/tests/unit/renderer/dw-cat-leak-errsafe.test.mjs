/**
 * dw wave 2026-10-02 — store/category.js leak + error-safety regressions, all red on the pre-fix code:
 *   leak-pending-meta-backups-map — softDelete's pendingMetaBackups entry used to be deleted ONLY in
 *     recover(); a victim never recovered kept its settled promise (and closure) forever. Now the
 *     entry is evicted once the roundtrip settles; correctness stays with the durable marker via
 *     waitOutPendingMetaBak, which recover still awaits.
 *   leak-category-lastpersistedrows — the persist diff baseline kept entries for ids no longer in the
 *     list (purged tombstones), growing unboundedly. persist()/setListFromDb() now prune dead keys.
 *   error-safety (ES sites fixed directly from code) — writeProjectFlag's bare `.catch(() => {})`
 *     turned a failed durable flag write into silent wrong state: setProject now reverts the
 *     in-memory projectIds to match what is durable and surfaces the failure; markPendingMetaBak /
 *     clearPendingMetaBak failures are surfaced instead of swallowed.
 * Run: node --test tests/unit/renderer/dw-cat-leak-errsafe.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const cat = (id, name, extra = {}) => ({
  categoryId: id, userId: 840001, categoryName: name, categoryColor: '#0f9d8f',
  createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: false, ...extra
})

function makeHost () {
  const db = new Map()
  const metaMap = new Map()
  const puts = []
  let failSetMeta = false
  let failDeleteMeta = false
  const dbCall = (op, p) => {
    if (op === 'getAllCategories') return Promise.resolve([...db.values()])
    if (op === 'getMeta') return Promise.resolve(metaMap.has(p) ? metaMap.get(p) : null)
    if (op === 'upsertCategory') { puts.push(p); db.set(p.id, p); return Promise.resolve(true) }
    if (op === 'setMeta') {
      if (failSetMeta) return Promise.reject(new Error('disk full'))
      metaMap.set(p[0], p[1]); return Promise.resolve('ok')
    }
    if (op === 'deleteMeta') {
      if (failDeleteMeta) return Promise.reject(new Error('disk full'))
      metaMap.delete(p); return Promise.resolve(1)
    }
    return Promise.resolve(null)
  }
  return {
    db, metaMap, puts,
    setFailSetMeta: v => { failSetMeta = v },
    setFailDeleteMeta: v => { failDeleteMeta = v },
    api: { location: { hash: '' }, todoAPI: { dbCall } }
  }
}

if (!globalThis.window) globalThis.window = {}
const LS = globalThis.localStorage
LS.setItem('categoryState', JSON.stringify({ list: [] })) // keep loadList() from seeding at module init

const Vuex = (await import('vuex')).default
const categoryNs = await import('../../../renderer/js/store/category.js')
const categoryMod = categoryNs.default
const { pendingMetaBackups, lastPersistedRows } = categoryNs
const makeStore = () => new Vuex.createStore({ modules: { category: categoryMod } })
async function drain (rounds = 20) { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)) }

test('[leak-pending-meta-backups-map] softDelete evicts the pendingMetaBackups entry once the roundtrip settles', async () => {
  const host = makeHost()
  host.metaMap.set('projectCategoryFlag:4200', '1')
  host.db.set(4200, cat(4200, ' doomed project'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()

  store.commit('category/softDelete', 4200)
  assert.ok(pendingMetaBackups.has(4200), 'in-flight roundtrip is tracked')
  await drain()
  assert.ok(!pendingMetaBackups.has(4200), 'settled roundtrip of a NEVER-RECOVERED victim is evicted (pre-fix: leaked forever)')
})

test('[leak-pending-meta-backups-map] recover AFTER eviction still restores the backup (marker path intact)', async () => {
  const host = makeHost()
  host.metaMap.set('projectCategoryFlag:4201', '1')
  host.metaMap.set('projectStatus:4201', 'paused')
  host.db.set(4201, cat(4201, ' recover later'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  assert.ok(store.state.category.projectIds.includes(4201))

  store.commit('category/softDelete', 4201)
  await drain()
  assert.ok(!pendingMetaBackups.has(4201), 'roundtrip settled and evicted before recover runs')
  assert.ok(!host.metaMap.has('projectCategoryFlag:4201'), 'live flag cleared by the backup roundtrip')
  assert.ok(host.metaMap.has('catProjectMetaBak.4201'), 'backup blob is durable')

  store.commit('category/recover', 4201)
  await drain(40)
  assert.ok(store.state.category.projectIds.includes(4201), 'recover after eviction re-enters projectIds (flag restored via the durable-marker wait path)')
  assert.equal(host.metaMap.get('projectCategoryFlag:4201'), '1', 'flag key restored')
  assert.equal(host.metaMap.get('projectStatus:4201'), 'paused', 'status meta restored')
})

test('[leak-category-lastpersistedrows] the persist baseline prunes ids no longer in the list', async () => {
  const host = makeHost()
  host.db.set(4300, cat(4300, 'A'))
  host.db.set(4301, cat(4301, 'B'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  assert.ok(lastPersistedRows.has(4300) && lastPersistedRows.has(4301), 'both rows baselined')

  // 4301 leaves the list (purged tombstone / hard delete); setList is the full-list writer
  store.commit('category/setList', [cat(4300, 'A')])
  await drain()
  assert.ok(!lastPersistedRows.has(4301), 'baseline entry for the removed id is evicted (pre-fix: leaked forever)')
  assert.ok(lastPersistedRows.has(4300), 'live row baseline kept')

  // Diff semantics intact: a real change still commits exactly the changed row
  host.puts.length = 0
  store.commit('category/updateCategory', { categoryId: 4300, categoryName: 'A2' })
  await drain()
  assert.equal(host.puts.length, 1, 'unchanged row is still not re-committed')
  assert.equal(host.puts[0].name, 'A2')
})

test('[ES: writeProjectFlag] failed durable flag PUT reverts the in-memory projectIds and surfaces the failure', async () => {
  const host = makeHost()
  host.db.set(4400, cat(4400, ' plain'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()

  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  host.setFailSetMeta(true)
  try {
    store.commit('category/setProject', { id: 4400, flag: true })
    await drain()
  } finally {
    console.error = origErr
    host.setFailSetMeta(false)
  }
  assert.ok(!store.state.category.projectIds.includes(4400), 'in-memory flag reverted to match the failed durable write (pre-fix: silently present until next init dropped it)')
  assert.ok(errs.some(e => e.includes('project flag write failed')), 'failure is surfaced, not swallowed')
})

test('[ES: writeProjectFlag] failed durable flag DELETE keeps the project in memory and surfaces the failure', async () => {
  const host = makeHost()
  host.metaMap.set('projectCategoryFlag:4401', '1')
  host.db.set(4401, cat(4401, ' flagged'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  assert.ok(store.state.category.projectIds.includes(4401))

  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  host.setFailDeleteMeta(true)
  try {
    store.commit('category/setProject', { id: 4401, flag: false })
    await drain()
  } finally {
    console.error = origErr
    host.setFailDeleteMeta(false)
  }
  assert.ok(store.state.category.projectIds.includes(4401), 'unmark reverted: the durable flag still says project (pre-fix: silently vanished until next init resurrected it)')
  assert.ok(errs.some(e => e.includes('project flag write failed')), 'failure is surfaced')
})

test('[ES: markPendingMetaBak] a failed durable marker write during softDelete is surfaced, not swallowed', async () => {
  const host = makeHost()
  host.metaMap.set('projectCategoryFlag:4402', '1')
  host.db.set(4402, cat(4402, ' victim'))
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()

  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  host.setFailSetMeta(true)
  try {
    store.commit('category/softDelete', 4402)
    await drain()
  } finally {
    console.error = origErr
    host.setFailSetMeta(false)
  }
  assert.ok(errs.some(e => e.includes('MARKER write failed')), 'marker failure surfaced (it gates cross-window recover; pre-fix: silent)')
})
