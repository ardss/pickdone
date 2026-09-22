/**
 * Renderer consistency round (sharp-review 2026-09-22) — regression guards.
 * Fixes covered:
 *   [R1] category softDelete vs recover undo-race: the delete-time project-meta backup
 *        (backupThenClearProjectMeta) is retained per victim id; recover awaits it before reading
 *        the backup key — an instant undo no longer loses deadline/milestones/status.
 *   [R3] SettingsDataTab: shared parseStampedSeg schemaV guard over ALL stamped segments
 *        (category/habits/filter/plan; todoState keeps its dedicated parseTodoState).
 *   [R4] categoryDelete resets settings via the settings/update action (config.json mirror).
 *   [R7] aux-window detection centralized in utils/auxWindow.js (isAuxWindow).
 * Run: node --test tests/unit/store/render-consistency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../setup.mjs' // window.dayjs / localStorage shims (must precede renderer imports)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- [R1] store-level: softDelete→instant recover awaits the in-flight meta backup ---------- */
const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}

const CAT_ID = 501
const flagKey = 'projectCategoryFlag:' + CAT_ID
const deadlineKey = 'projectDeadline:' + CAT_ID
const statusKey = 'projectStatus:' + CAT_ID
const milestonesKey = 'projectMilestones:' + CAT_ID
const bakKey = 'catProjectMetaBak.' + CAT_ID

// Simulated main-process meta table + a gate that holds the FIRST getMeta in flight (the
// delete-time backup read) so the test can click undo inside the roundtrip window.
const meta = { [flagKey]: '1', [deadlineKey]: '1735689600000', [statusKey]: 'paused', [milestonesKey]: '[]' }
const puts = []
let gate = null
const dbCall = (op, p) => {
  if (op === 'getMeta') {
    if (p === flagKey && gate) { const g = gate; gate = null; return g.promise.then(() => meta[p]) }
    return Promise.resolve(meta[p] != null ? meta[p] : null)
  }
  if (op === 'setMeta') { const [k, v] = p; meta[k] = v; puts.push(['setMeta', k, v]); return Promise.resolve(true) }
  if (op === 'deleteMeta') { delete meta[p]; puts.push(['deleteMeta', p]); return Promise.resolve(true) }
  if (op === 'getAllCategories') return Promise.resolve([{ categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: 0 }])
  return Promise.resolve(null)
}
globalThis.window = Object.assign(globalThis.window || {}, { location: { hash: '' }, todoAPI: { dbCall } })

LS.categoryState = JSON.stringify({ list: [
  { categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false }
] })

const { default: Vue } = await import('vue')
globalThis.window.Vue = Vue
const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const tick = () => new Promise(r => setImmediate(r))

function makeCategoryStore () {
  return new Vuex.createStore({ modules: { category } })
}

test('[R1] undo clicked inside the backup roundtrip still restores deadline/status/milestones', async () => {
  const store = makeCategoryStore()
  await store.dispatch('category/init')
  store.commit('category/setProjectIds', [CAT_ID])

  // Hold the backup's first meta read in flight (~50-300ms roundtrip in production)
  let release
  gate = { promise: new Promise(r => { release = r }) }

  store.commit('category/softDelete', CAT_ID)
  assert.equal(store.state.category.list[0].delete, true, 'category is tombstoned immediately')

  // User clicks undo INSTANTLY — before the delete-time backup roundtrip resolved
  store.commit('category/recover', CAT_ID)
  assert.equal(store.state.category.list[0].delete, false, 'category is recovered immediately')

  // The roundtrip now completes
  release()
  for (let i = 0; i < 20; i++) await tick()

  // The restore consumes the backup (restoreProjectMetaBackup deletes it after write-back), so the
  // live keys are the observable outcome: they must hold the pre-delete values again.
  assert.equal(meta[deadlineKey], '1735689600000', 'deadline restored to its live key (was: permanently lost)')
  assert.equal(meta[statusKey], 'paused', 'status restored to its live key')
  assert.equal(meta[milestonesKey], '[]', 'milestones restored to their live key')
  assert.ok(puts.some(p => p[0] === 'setMeta' && p[1] === bakKey), 'a backup blob was written during the roundtrip')
  assert.ok(store.state.category.projectIds.includes(CAT_ID), 'project flag re-enters projectIds')
})

test('[R1] recover without an in-flight backup still works (plain path unchanged)', async () => {
  const store = makeCategoryStore()
  await store.dispatch('category/init')
  store.commit('category/setProjectIds', [])
  store.commit('category/softDelete', CAT_ID)
  for (let i = 0; i < 10; i++) await tick() // let the backup settle before undo
  store.commit('category/recover', CAT_ID)
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(store.state.category.list[0].delete, false)
  assert.equal(meta[deadlineKey], '1735689600000', 'backup restored via the plain path too')
})

/* ---------- [R3/R4/R7] source anchors ---------- */

test('[R3] SettingsDataTab guards schemaV over every stamped segment via a shared helper', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.ok(src.includes('parseStampedSeg'), 'shared segment guard helper exists')
  assert.ok(src.includes("import { SCHEMA_V } from '../../store/todoBackup.js'"), 'threshold comes from the single SCHEMA_V source')
  for (const seg of ['b.categoryState', 'b.habitsState', 'b.filterState', 'b.planState']) {
    assert.ok(src.includes('this.parseStampedSeg(' + seg + ')'), 'stamped segment guarded: ' + seg)
  }
  assert.ok(src.includes('parseTodoState(b.todoState)'), 'todoState keeps its dedicated guard')
  const guard = src.indexOf('parseStampedSeg (raw)')
  const body = src.slice(guard, guard + 500)
  assert.ok(/Number\(seg\.schemaV\) > SCHEMA_V/.test(body), 'helper refuses newer-schema segments')
})

test('[R4] categoryDelete resets settings through the settings/update action, not the raw mutation', () => {
  const src = read('renderer/js/components/side-nav/categoryDelete.js')
  assert.ok(src.includes("dispatch('settings/update', reset)"), 'reset rides the update action (config.json mirror)')
  assert.ok(src.includes("dispatch('settings/update', preReset)"), 'undo restore rides the update action too')
  assert.ok(!src.includes("commit('settings/updateSettings'"), 'raw settings mutation is gone')
})

test('[R7] aux-window detection is centralized in utils/auxWindow.js', async () => {
  const { isAuxWindow } = await import('../../../renderer/js/utils/auxWindow.js')
  assert.equal(isAuxWindow(), false, 'main window hash is not aux')
  const prev = globalThis.window.location
  globalThis.window.location = { hash: '#/__quick-add' }
  try { assert.equal(isAuxWindow(), true, 'quick-add hash detected') } finally { globalThis.window.location = prev }
  globalThis.window.location = { hash: '#/__tomato-float' }
  try { assert.equal(isAuxWindow(), true, 'tomato float hash detected') } finally { globalThis.window.location = prev }
  for (const f of ['renderer/js/store/todoBackup.js', 'renderer/js/store/habits.js', 'renderer/js/store/settings.js']) {
    assert.ok(read(f).includes('utils/auxWindow.js'), f + ' uses the centralized helper')
  }
  assert.ok(!read('renderer/js/store/todoBackup.js').includes('/__tomato-float|__quick-add/'), 'hand-copied regex removed from todoBackup')
})
