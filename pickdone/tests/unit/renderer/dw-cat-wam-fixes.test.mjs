/**
 * Write-amplification fix (dw audit-wam domain, 2026-09-25) — renderer/js/store/category.js.
 *
 * Storm source located: renderer/js/utils/externalReload.js:34 re-dispatches category/init on EVERY
 * todos-changed round; init used to commit('category/setList', rows) and setList persisted the WHOLE
 * list (N × commitCommand('category','put') → N × upsertCategory writes → N audited category.upsert
 * lines per round; ~153 cat:id rows ≈ 80 lines/s on the real library, 5MB trail per 7-10 min). Each
 * round's writes re-broadcast todos-changed, so the loop re-armed itself: read-back → persist → reload.
 * Fix under test:
 *  1. setListFromDb — the DB-read channel assigns memory ONLY, zero persist (loop cut);
 *  2. persist diffs each row against the last successfully committed row and commits only real changes;
 *  3. a failed commit is forgotten so the next persist retries it (SQLite must converge with LS).
 * Run: node --test tests/unit/renderer/dw-cat-wam-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const cat = (id, name, extra = {}) => ({
  categoryId: id, userId: 840001, categoryName: name, categoryColor: '#0f9d8f',
  createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: false, ...extra
})

/** dbCall stub: serves rows from `db`, records every category put (the audited write unit). */
function makeHost (rows) {
  const db = new Map(rows.map(r => [r.categoryId, r]))
  const puts = []
  const attempts = []
  let failOnceFor = null
  const dbCall = (op, p) => {
    if (op === 'getAllCategories') return Promise.resolve([...db.values()])
    if (op === 'getMeta') return Promise.resolve(null)
    if (op === 'upsertCategory') {
      attempts.push(p)
      if (failOnceFor === p.id) { failOnceFor = null; return Promise.reject(new Error('simulated EPIPE')) }
      puts.push(p)
      db.set(p.id, p)
      return Promise.resolve(true)
    }
    return Promise.resolve(null)
  }
  return {
    puts, attempts, db,
    failNextPutFor: id => { failOnceFor = id },
    api: { location: { hash: '' }, todoAPI: { dbCall } }
  }
}

if (!globalThis.window) globalThis.window = {}
const LS = globalThis.localStorage
// Seed LS with a valid list so loadList() at module state() init never fires the seed persist
LS.setItem('categoryState', JSON.stringify({ list: [cat(1, 'seed-a'), cat(2, 'seed-b')] }))

const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const makeStore = () => new Vuex.createStore({ modules: { category } })
const tick = () => new Promise(r => setImmediate(r))
async function drain () { for (let i = 0; i < 10; i++) await tick() }

test('[cat-wam] category/init (the externalReload re-entry) persists ZERO rows — read-back never writes back', async () => {
  const host = makeHost([cat(9001, 'Work'), cat(9002, 'Study')])
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  assert.equal(host.puts.length, 0, 'init from DB rows must not re-commit any category row')
  assert.equal(store.state.category.list.length, 2, 'memory still shows the DB rows')

  // The reload loop's shape: init again (new rows → setListFromDb again) — still zero writes
  host.db.set(9003, cat(9003, 'Life'))
  await store.dispatch('category/init')
  await drain()
  assert.equal(host.puts.length, 0, 'second init round (the reload storm path) still persists nothing')
  assert.equal(store.state.category.list.length, 3)
})

test('[cat-wam] persist commits ONLY the changed row: one updateCategory patch → exactly 1 upsertCategory', async () => {
  const host = makeHost([cat(9101, 'Work'), cat(9102, 'Study')])
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  host.puts.length = 0

  store.commit('category/updateCategory', { categoryId: 9101, categoryName: 'Work renamed' })
  await drain()
  assert.equal(host.puts.length, 1, 'only the actually-changed row is committed')
  assert.equal(host.puts[0].id, 9101)
  assert.equal(host.puts[0].name, 'Work renamed')

  // Re-running the same full-list replacement (legacy setList callers) with identical rows: diff suppresses all
  const snapshot = store.state.category.list.map(c => ({ ...c }))
  store.commit('category/setList', snapshot)
  await drain()
  assert.equal(host.puts.length, 1, 'identical re-persist emits zero writes')
})

test('[cat-wam] a FAILED commit is not remembered — the next persist retries that row', async () => {
  const host = makeHost([cat(9201, 'Work')])
  Object.assign(globalThis.window, host.api)
  const store = makeStore()
  await store.dispatch('category/init')
  await drain()
  host.puts.length = 0

  host.failNextPutFor(9201)
  store.commit('category/updateCategory', { categoryId: 9201, categoryName: 'rename-1' })
  await drain()
  assert.equal(host.attempts.length, 1)
  assert.equal(host.puts.length, 0, 'the simulated EPIPE put is not a success')

  // Same payload again: the first commit failed, so the row must NOT be diff-suppressed
  store.commit('category/updateCategory', { categoryId: 9201, categoryName: 'rename-1' })
  await drain()
  assert.equal(host.attempts.length, 2, 'row retried after the failed commit (SQLite converges with LS)')
  assert.equal(host.puts.length, 1)
})
