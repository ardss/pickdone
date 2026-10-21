/* F4 fix #3 (2026-10-17) — the renderer store's addCategory/updateCategory patch channel now
 * validates folderId/folderIs changes through the SAME shared core as the DB write bottleneck
 * and the CLI (shared/category-structure.mjs): CATEGORY_NOT_FOLDER / CATEGORY_NESTED_FOLDER /
 * CATEGORY_CYCLE / CATEGORY_NOT_FOUND throw a coded error and leave the list untouched (same
 * coded-error pattern as the existing CATEGORY_EXISTS guard). Isolation mirrors
 * tests/unit/renderer/d19-dom2-category-dup.test.mjs.
 * Run: node --test tests/unit/renderer/f4-category-structure-store.test.mjs */
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

const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const makeStore = () => new Vuex.createStore({ modules: { category } })

test('addCategory under a live folder lands; under a non-folder/deleted parent throws and adds nothing', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'F4Folder', folderIs: true })
  const folder = store.state.category.list.find(c => c.categoryName === 'F4Folder')
  store.commit('category/addCategory', { categoryName: 'F4Child', folderId: folder.categoryId })
  assert.ok(store.state.category.list.some(c => c.categoryName === 'F4Child' && c.folderId === folder.categoryId),
    'a legal add under a live folder is unchanged')

  store.commit('category/addCategory', { categoryName: 'F4Flat' })
  const flat = store.state.category.list.find(c => c.categoryName === 'F4Flat')
  const before = store.state.category.list.length
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'F4Bad', folderId: flat.categoryId }),
    e => e.code === 'CATEGORY_NOT_FOLDER',
    'red before the fix: the UI could add a child under a non-folder')
  assert.equal(store.state.category.list.length, before, 'the failed add pushes no row')

  store.commit('category/softDelete', folder.categoryId)
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'F4Bad2', folderId: folder.categoryId }),
    e => e.code === 'CATEGORY_NOT_FOUND', 'a parent tombstoned by the cascade is refused')
})

test('addCategory refuses nested folders (CATEGORY_NESTED_FOLDER, CLI parity)', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'F4Outer', folderIs: true })
  const folder = store.state.category.list.find(c => c.categoryName === 'F4Outer')
  assert.throws(() => store.commit('category/addCategory', { categoryName: 'F4Nested', folderIs: true, folderId: folder.categoryId }),
    e => e.code === 'CATEGORY_NESTED_FOLDER')
  assert.ok(!store.state.category.list.some(c => c.categoryName === 'F4Nested'))
})

test('updateCategory folderId/folderIs patch: non-folder, nested folder and cycle are refused, list + disk untouched', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'F4UFolder', folderIs: true })
  store.commit('category/addCategory', { categoryName: 'F4UFlat' })
  store.commit('category/addCategory', { categoryName: 'F4UChild' })
  const folder = store.state.category.list.find(c => c.categoryName === 'F4UFolder')
  const flat = store.state.category.list.find(c => c.categoryName === 'F4UFlat')
  const child = store.state.category.list.find(c => c.categoryName === 'F4UChild')
  store.commit('category/updateCategory', { categoryId: child.categoryId, folderId: folder.categoryId })
  const persistedChild = JSON.stringify(store.state.category.list.find(c => c.categoryId === child.categoryId))

  assert.throws(() => store.commit('category/updateCategory', { categoryId: child.categoryId, folderId: flat.categoryId }),
    e => e.code === 'CATEGORY_NOT_FOLDER', 'red before the fix: dnd into a non-folder was accepted verbatim')
  assert.equal(JSON.stringify(store.state.category.list.find(c => c.categoryId === child.categoryId)), persistedChild,
    'the refused patch leaves the row byte-identical')

  assert.throws(() => store.commit('category/updateCategory', { categoryId: child.categoryId, folderIs: true }),
    e => e.code === 'CATEGORY_NESTED_FOLDER', 'turning a nested child into a folder is refused')

  // cycle: A is under folder F; patching F under A closes a loop
  assert.throws(() => store.commit('category/updateCategory', { categoryId: folder.categoryId, folderId: child.categoryId }),
    e => e.code === 'CATEGORY_CYCLE')
  // self-parent
  assert.throws(() => store.commit('category/updateCategory', { categoryId: child.categoryId, folderId: child.categoryId }),
    e => e.code === 'CATEGORY_CYCLE')
  assert.equal(JSON.stringify(store.state.category.list.find(c => c.categoryId === folder.categoryId)).includes('"folderId":0'),
    true, 'the folder row keeps folderId 0 after the refused cycle patch')
})

test('orphan pin (design item, unchanged): a live row whose folderId points at a deleted folder renders nowhere', () => {
  const store = makeStore()
  store.commit('category/addCategory', { categoryName: 'F4OrphanF', folderIs: true })
  const frow = store.state.category.list.find(c => c.categoryName === 'F4OrphanF')
  store.commit('category/addCategory', { categoryName: 'F4OrphanC', folderId: frow.categoryId })
  store.commit('category/softDelete', frow.categoryId) // cascade deletes the child too…
  // …so simulate the sync-only case: the child survives with a dangling parent (peer only tombstoned the folder)
  const orphan = store.state.category.list.find(c => c.categoryName === 'F4OrphanC')
  orphan.delete = false
  orphan.deletedAt = 0
  assert.ok(!store.getters['category/roots'].some(c => c.categoryId === orphan.categoryId),
    'orphan is not a root (folderId non-zero)')
  const hier = store.getters['category/hierarchical']
  assert.ok(!hier.some(h => h.categoryId === orphan.categoryId), 'orphan is not a folder root either')
  assert.ok(!hier.some(h => (h.children || []).some(x => x.categoryId === orphan.categoryId)),
    'orphan has no live folder to hang under')
})
