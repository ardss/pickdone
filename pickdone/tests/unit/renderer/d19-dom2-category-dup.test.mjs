/* D19-DOM2 (#9) — App addCategory rejects duplicate live names with the CLI's CATEGORY_EXISTS
 * contract (duplicates locked the CLI out with AMBIGUOUS_MATCH; both ends need unique names).
 * Run: node --test tests/unit/renderer/d19-dom2-category-dup.test.mjs
 * Isolation: tests/setup.mjs shims; window.todoAPI.dbCall stubbed; localStorage is in-memory. */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const meta = {}
const dbCall = (op, p) => {
  if (op === 'getMeta') return Promise.resolve(meta[p] != null ? meta[p] : null)
  if (op === 'setMeta') { const [k, v] = p; meta[k] = v; return Promise.resolve(true) }
  if (op === 'deleteMeta') { delete meta[p]; return Promise.resolve(true) }
  if (op === 'getAllCategories') return Promise.resolve([])
  if (op === 'getMetaMany') return Promise.resolve((p || []).map(k => ({ key: k, value: meta[k] ?? null })))
  return Promise.resolve(null)
}
if (!globalThis.window) globalThis.window = {}
globalThis.window = Object.assign(globalThis.window, { location: { hash: '' }, todoAPI: { dbCall } })

const LS = globalThis.localStorage
const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const makeStore = () => new Vuex.createStore({ modules: { category } })

test('addCategory rejects a duplicate live name with code CATEGORY_EXISTS (CLI parity)', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'D19Dup' })
  assert.ok(store.state.category.list.some(c => c.categoryName === 'D19Dup'))
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'D19Dup' }),
    e => e.code === 'CATEGORY_EXISTS' && /already exists/.test(e.message),
    'duplicate live name must throw CATEGORY_EXISTS, same contract as cli/lib-categories addCategory')
  // the failed add must not have pushed a second row
  assert.equal(store.state.category.list.filter(c => c.categoryName === 'D19Dup').length, 1)
})

test('a soft-deleted (tombstoned) name does NOT block re-creation', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'D19Recycled' })
  const row = store.state.category.list.find(c => c.categoryName === 'D19Recycled')
  store.commit('category/softDelete', row.categoryId)
  // live list no longer carries it — re-creating the name must succeed (CLI resolveCategory only
  // searches live rows via getAllCategories deleted=0)
  assert.ok(!store.state.category.list.some(c => !c.delete && c.categoryName === 'D19Recycled'))
  store.commit('category/addCategory', { categoryName: 'D19Recycled' })
  assert.ok(store.state.category.list.filter(c => c.categoryName === 'D19Recycled' && !c.delete).length === 1)
})

test('seed sanity: init from an LS blob with the duplicate already present still loads', () => {
  // the guard is add-time only — a pre-existing duplicated list (from old versions) must not
  // wedge init, it just cannot be duplicated further
  LS.setItem('categoryState', JSON.stringify({ list: [
    { categoryId: 1, userId: 840001, categoryName: 'Same', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false },
    { categoryId: 2, userId: 840001, categoryName: 'Same', categoryColor: '#0f9d8f', createTime: 2, listSort: 2, folderIs: false, folderId: 0, delete: false }
  ] }))
  const store = makeStore()
  return store.dispatch('category/init').then(() => {
    assert.equal(store.state.category.list.filter(c => c.categoryName === 'Same').length, 2)
    assert.throws(() => store.commit('category/addCategory', { categoryName: 'Same' }), e => e.code === 'CATEGORY_EXISTS')
  })
})

/* ---- normKey parity: the guard must judge duplicates the way the CLI addresses them ----
 * Root cause vs symptom: the original raw-string compare treated the SYMPTOM (exact dupes) but not
 * the cause (the CLI resolves categories through normKey = NFKC → lowercase → strip whitespace
 * variants). 'Work' next to 'work'/'Ｗｏｒｋ' passed the raw compare and then AMBIGUOUS_MATCH-locked
 * every CLI category addressing — the exact lockout CATEGORY_EXISTS exists to prevent. */

test('addCategory rejects a case/width/whitespace-variant duplicate (normKey parity with the CLI)', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'Work' })
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'work' }),
    e => e.code === 'CATEGORY_EXISTS', 'lowercase variant must collide')
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'Ｗｏｒｋ' }),
    e => e.code === 'CATEGORY_EXISTS', 'full-width variant (NFKC) must collide')
  assert.throws(() => store.commit('category/addCategory', { categoryName: ' W o r k ' }),
    e => e.code === 'CATEGORY_EXISTS', 'interleaved-space variant must collide')
  // a genuinely distinct name still passes
  store.commit('category/addCategory', { categoryName: 'Works' })
  assert.ok(store.state.category.list.some(c => c.categoryName === 'Works'))
})

test('updateCategory rejects a rename onto a normalized duplicate; a distinct rename passes; self-rename passes', async () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'Alpha' })
  store.commit('category/addCategory', { categoryName: 'Beta' })
  const alpha = store.state.category.list.find(c => c.categoryName === 'Alpha')
  // rename Alpha → 'ｂｅｔａ' (NFKC-collides with Beta): must throw, list unchanged
  assert.throws(() => store.commit('category/updateCategory', { categoryId: alpha.categoryId, categoryName: 'ｂｅｔａ' }),
    e => e.code === 'CATEGORY_EXISTS', 'rename onto a normalized duplicate must throw CATEGORY_EXISTS')
  assert.equal(store.state.category.list.find(c => c.categoryId === alpha.categoryId).categoryName, 'Alpha',
    'failed rename must not mutate the row')
  // distinct rename passes
  store.commit('category/updateCategory', { categoryId: alpha.categoryId, categoryName: 'Gamma' })
  assert.equal(store.state.category.list.find(c => c.categoryId === alpha.categoryId).categoryName, 'Gamma')
  // renaming a row to its own (case-variant) name must not false-positive on itself
  store.commit('category/updateCategory', { categoryId: alpha.categoryId, categoryName: 'gamma' })
  assert.equal(store.state.category.list.find(c => c.categoryId === alpha.categoryId).categoryName, 'gamma')
})
