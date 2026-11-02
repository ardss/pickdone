/* w29 P1 regression: Vuex store.commit() DISCARDS a mutation's return value, so the awaited
 * `commit('category/updateCategory')` calls in ProjectView (rename/color) and
 * SnManageCategoriesModal always read `undefined` for the persist boolean — a FAILED SQLite
 * write was indistinguishable from success and the views toasted success / closed the editor.
 *
 * Fix: a namespaced ACTION `category/updateCategory` forwards the patch to the mutation and
 * returns its Promise<boolean> verbatim; the three user-facing call sites dispatch instead of
 * commit. This test drives the REAL category store module and asserts the boolean contract the
 * toast branches depend on (true = SQLite write confirmed, false = persist failed, throw =
 * CATEGORY_EXISTS), plus source wiring that the user-facing call sites no longer commit.
 *
 * Run: node --test tests/unit/store/w29-category-commit-boolean.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
// window must exist BEFORE the module import: utils/core.js pulls the i18n index, which reads window at top level
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: async () => ({ ok: true }) }, VueI18n: undefined }

const mod = await import('../../../renderer/js/store/category.js')
const categoryModule = mod.default

// Vuex via CJS require (same pattern as the component tests)
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const VuexLib = require('vuex')

function makeStore (dbCallImpl) {
  globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: dbCallImpl } }
  const store = VuexLib.createStore({
    modules: { category: { ...categoryModule } }
  })
  return store
}

test('w29 P1: dispatch(category/updateCategory) resolves TRUE when the SQLite write lands', async () => {
  const store = makeStore(async () => ({ ok: true }))
  store.commit('category/addCategory', { categoryName: 'Alpha' })
  const cat = store.state.category.list[0]
  const ok = await store.dispatch('category/updateCategory', { categoryId: cat.categoryId, categoryName: 'Beta' })
  assert.equal(ok, true, 'confirmed write must resolve true (success toast branch)')
  assert.equal(store.state.category.list[0].categoryName, 'Beta')
})

test('w29 P1: dispatch(category/updateCategory) resolves FALSE when persist fails (the old commit path returned undefined)', async () => {
  const store = makeStore(async () => { throw new Error('sqlite locked') })
  store.commit('category/addCategory', { categoryName: 'Alpha' })
  const cat = store.state.category.list[0]
  const ok = await store.dispatch('category/updateCategory', { categoryId: cat.categoryId, categoryName: 'Beta' })
  assert.equal(ok, false, 'failed persist must resolve false — caller shows the failure toast instead of success')
  // in-memory rename still happened (LS-cache-first contract) but the boolean is what the view branches on
  assert.equal(store.state.category.list[0].categoryName, 'Beta')
})

test('w29 P1: duplicate-name rename rejects with CATEGORY_EXISTS (warning-toast branch)', async () => {
  const store = makeStore(async () => ({ ok: true }))
  store.commit('category/addCategory', { categoryName: 'Alpha' })
  store.commit('category/addCategory', { categoryName: 'Gamma' })
  const gamma = store.state.category.list[1]
  await assert.rejects(
    () => store.dispatch('category/updateCategory', { categoryId: gamma.categoryId, categoryName: 'alpha' }),
    e => e.code === 'CATEGORY_EXISTS'
  )
})

test('w29 P1: store.commit still swallows the return (documenting WHY the dispatch fix exists)', async () => {
  const store = makeStore(async () => ({ ok: true }))
  store.commit('category/addCategory', { categoryName: 'Alpha' })
  const cat = store.state.category.list[0]
  const viaCommit = await store.commit('category/updateCategory', { categoryId: cat.categoryId, categoryName: 'Beta2' })
  assert.equal(viaCommit, undefined, 'commit() must return undefined — the boolean only survives through dispatch')
})

test('w29 P1: user-facing call sites dispatch (not commit) category/updateCategory', () => {
  const pv = fs.readFileSync(path.join(ROOT, 'renderer/js/views/ProjectView.vue'), 'utf8')
  const sn = fs.readFileSync(path.join(ROOT, 'renderer/js/components/side-nav/SnManageCategoriesModal.vue'), 'utf8')
  for (const [name, src] of [['ProjectView.vue', pv], ['SnManageCategoriesModal.vue', sn]]) {
    assert.ok(!src.includes("$store.commit('category/updateCategory'"), `${name}: no commit() on updateCategory (return value would be swallowed)`)
    assert.ok(src.includes("$store.dispatch('category/updateCategory'"), `${name}: renames/colors go through the awaited action`)
  }
})
