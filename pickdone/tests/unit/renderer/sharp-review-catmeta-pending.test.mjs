/**
 * Sharp-review round (2026-09-22) — [renderer-5] cross-window project-meta backup race.
 * pendingMetaBackups is a module-level per-window Map: a recover in window B never sees window A's
 * in-flight delete-time backup and used to read `catProjectMetaBak.<id>` before the backup write landed —
 * deadline/milestones/status permanently lost. Fix: a durable in-DB marker `catProjectMetaBak.pending.<id>`
 * brackets the read→backup-write→clear roundtrip; recover (in ANY window) waits it out before restoring.
 * The map lookup returning undefined (window B) and the lookup hitting (window A) both funnel through the
 * same `.then(() => waitOutPendingMetaBak(id))` — these tests assert the marker's observable lifecycle and
 * that recover consults it before restoring.
 * Run: node --test tests/unit/renderer/sharp-review-catmeta-pending.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CAT_ID = 555001
const flagKey = 'projectCategoryFlag:' + CAT_ID
const deadlineKey = 'projectDeadline:' + CAT_ID
const statusKey = 'projectStatus:' + CAT_ID
const milestonesKey = 'projectMilestones:' + CAT_ID
const bakKey = 'catProjectMetaBak.' + CAT_ID
const pendingKey = 'catProjectMetaBak.pending.' + CAT_ID

const meta = { [flagKey]: '1', [deadlineKey]: '1735689600000', [statusKey]: 'paused', [milestonesKey]: '[]' }
const puts = []
const metaReads = []
let gate = null
const dbCall = (op, p) => {
  if (op === 'getMeta') {
    metaReads.push(p)
    if (gate && p === flagKey) { const g = gate; gate = null; return g.promise.then(() => meta[p]) }
    return Promise.resolve(meta[p] != null ? meta[p] : null)
  }
  if (op === 'setMeta') { const [k, v] = p; meta[k] = v; puts.push(['setMeta', k, v]); return Promise.resolve(true) }
  if (op === 'deleteMeta') { delete meta[p]; puts.push(['deleteMeta', p]); return Promise.resolve(true) }
  if (op === 'getAllCategories') return Promise.resolve([{ categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: 0 }])
  return Promise.resolve(null)
}
if (!globalThis.window) globalThis.window = {}
globalThis.window = Object.assign(globalThis.window, { location: { hash: '' }, todoAPI: { dbCall } })

const LS = globalThis.localStorage
LS.categoryState = JSON.stringify({ list: [
  { categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false }
] })

const Vuex = (await import('vuex')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const tick = () => new Promise(r => setImmediate(r))
const makeCategoryStore = () => new Vuex.createStore({ modules: { category } })

test('[renderer-5] softDelete writes a durable pending marker and clears it only after the roundtrip', async () => {
  const store = makeCategoryStore()
  await store.dispatch('category/init')
  // Hold the backup's first meta read in flight — the roundtrip is mid-flight
  let release
  gate = { promise: new Promise(r => { release = r }) }
  store.commit('category/softDelete', CAT_ID)
  await tick(); await tick()
  assert.equal(meta[pendingKey], '1', 'durable pending marker written at delete time (visible to every window)')

  release()
  for (let i = 0; i < 20; i++) await tick()
  assert.equal(meta[pendingKey], undefined, 'marker cleared only after backup write + live-key clears')
  assert.ok(puts.some(p => p[0] === 'setMeta' && p[1] === bakKey), 'backup blob landed before the marker cleared')
  const bakIdx = puts.findIndex(p => p[0] === 'setMeta' && p[1] === bakKey)
  const clrIdx = puts.findIndex(p => p[0] === 'deleteMeta' && p[1] === pendingKey)
  assert.ok(clrIdx > bakIdx, 'marker clears AFTER the backup write, never before')
})

test('[renderer-5] recover consults the durable marker before restoring (window-B path)', async () => {
  const store = makeCategoryStore()
  await store.dispatch('category/init')
  store.commit('category/softDelete', CAT_ID)
  await tick(); await tick()
  metaReads.length = 0
  store.commit('category/recover', CAT_ID)
  for (let i = 0; i < 30; i++) await tick()
  assert.ok(metaReads.includes(pendingKey), 'recover read the pending marker (the only cross-window signal window B has)')
  assert.equal(meta[deadlineKey], '1735689600000', 'deadline restored to its live key')
  assert.equal(meta[statusKey], 'paused', 'status restored')
  assert.equal(meta[milestonesKey], '[]', 'milestones restored')
})

test('[renderer-5] restore still happens when the marker leaked (bounded wait, no wedge)', async () => {
  // Simulate a crashed window that left the marker behind with the backup already written
  meta[pendingKey] = '1'
  meta[bakKey] = JSON.stringify({ flag: true, status: 'paused', deadline: '1735689600000', milestones: '[]' })
  delete meta[deadlineKey]; delete meta[statusKey]; delete meta[milestonesKey]
  const list = [{ categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: true }]
  LS.categoryState = JSON.stringify({ list })
  const store = makeCategoryStore()
  // Module state was loaded before this test — plant the tombstoned row directly (no init(): the DB row
  // with delete:0 would overwrite the tombstone this scenario needs)
  store.commit('category/setList', [{ categoryId: CAT_ID, userId: 840001, categoryName: 'P', categoryColor: '#0f9d8f', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: true }])
  store.commit('category/recover', CAT_ID)
  // The leaked-marker wait is wall-clock bounded (PENDING_META_BAK_WAIT_MS = 3s) — poll real time for it
  for (let i = 0; i < 100 && meta[deadlineKey] !== '1735689600000'; i++) {
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(meta[deadlineKey], '1735689600000', 'restore proceeded despite the leaked marker')
  assert.equal(meta[pendingKey], undefined, 'leaked marker cleared so later recovers do not re-wait')
})
