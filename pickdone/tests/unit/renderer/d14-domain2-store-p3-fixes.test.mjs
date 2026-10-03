/**
 * D14 domain-2 (renderer store layer) P3 regression batch — one test per finding, all red on the
 * pre-fix code:
 *   B6   settings initFromDb merges onboardingToursSeen per-key (never adopts the DB map wholesale)
 *   B7   ui renameUserTag/removeUserTag: failed meta put reverts the in-memory list and surfaces
 *   B9   category delete backs up doomed filters (catFiltersBak.<id>); recover restores them
 *   B10  restoreProjectMetaBackup merges milestones (live newer entries are never clobbered)
 *   B11  completed no-date tasks past completion day land in recent.expiredCompleted
 *   B15  habits applyExternal rejects TIES (prior writer wins, settings LWW doctrine)
 * Run: node --test tests/unit/renderer/d14-domain2-store-p3-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
const today = +dayjs().startOf('day')
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))

/* ===== shared db bridge stub ===== */
const dbCalls = []
const metaMap = new Map()
let failSetMeta = false
const filterUpserts = []
let filterListResult = []
const LS = globalThis.localStorage
globalThis.window.todoAPI = {
  dbCall (op, params) {
    dbCalls.push([op, params])
    switch (op) {
      case 'getMeta': return Promise.resolve(metaMap.has(params) ? metaMap.get(params) : null)
      case 'setMeta':
        if (failSetMeta) return Promise.reject(new Error('disk full'))
        if (Array.isArray(params)) metaMap.set(params[0], params[1])
        return Promise.resolve('ok')
      case 'deleteMeta': metaMap.delete(params); return Promise.resolve(1)
      case 'planAll': return Promise.resolve([])
      case 'filterUpsert': filterUpserts.push(params); return Promise.resolve(params && params.id)
      case 'filterList': return Promise.resolve(filterListResult)
      default: return Promise.resolve(null)
    }
  }
}

/* ==================== B6: settings initFromDb tour-map per-key merge ==================== */

test('B6 initFromDb merges onboardingToursSeen per-key instead of adopting the DB map wholesale', async () => {
  LS.setItem('settingsMirrorAt', '0') // force the restore branch (db stamp newer than LS)
  metaMap.set('db.settingsState', JSON.stringify({ _savedAt: 9e15, onboardingToursSeen: { tourB: 5 } }))
  const settings = (await import('../../../renderer/js/store/settings.js')).default
  const state = {
    onboardingToursSeen: { tourA: 1 },
    shortcutKeySettings: { dummy: true } // non-default → the Y2 config seeding path is skipped
  }
  const ctx = {
    state,
    commit (m, p) { if (m === 'updateSettings') Object.assign(state, p) },
    dispatch: async () => ({ ok: true })
  }
  await settings.actions.initFromDb.call(ctx, ctx)
  assert.equal(state.onboardingToursSeen.tourA, 1, 'local-only seen key SURVIVES (wholesale adoption used to drop it)')
  assert.equal(state.onboardingToursSeen.tourB, 5, 'DB-only seen key is merged in')
})

/* ==================== B7: ui tag meta puts surface failure + revert ==================== */

test('B7 renameUserTag/removeUserTag revert the in-memory list and rethrow on meta put failure', async () => {
  const ui = (await import('../../../renderer/js/store/ui.js')).default
  const state = { userTags: ['a', 'b'] }
  const ctx = { state, commit (m, p) { ui.mutations[m](state, p) }, dispatch (a, p) { return ui.actions.commitUserTags.call(ctx, ctx, p) } }
  failSetMeta = true
  await assert.rejects(ui.actions.renameUserTag.call(ctx, ctx, { from: 'a', to: 'A' }), /disk full/)
  assert.deepEqual(state.userTags, ['a', 'b'], 'failed rename is reverted (no silent revert at next startup)')
  await assert.rejects(ui.actions.removeUserTag.call(ctx, ctx, 'b'), /disk full/)
  assert.deepEqual(state.userTags, ['a', 'b'], 'failed removal is reverted')
  failSetMeta = false
  await ui.actions.renameUserTag.call(ctx, ctx, { from: 'a', to: 'A' })
  assert.deepEqual(state.userTags, ['A', 'b'])
  await ui.actions.removeUserTag.call(ctx, ctx, 'b')
  assert.deepEqual(state.userTags, ['A'])
})

/* ==================== B9 + B10: category filter backup/restore + milestone merge ==================== */

test('B9 softDelete backs up doomed filters per victim; recover restores them', async () => {
  const cat = (await import('../../../renderer/js/store/category.js')).default
  const f5 = { id: 'f5', conds: { catId: 5 }, name: 'F5' }
  const f9 = { id: 'f9', conds: { catId: 9 }, name: 'F9' }
  const cstate = { list: [{ categoryId: 5, delete: false, folderId: 0, folderIs: false, deletedAt: 0 }], projectIds: [], projectMeta: {} }
  const storeFake = {
    state: { filters: { list: [f5, f9] } },
    commit (m, p) {
      if (m === 'category/markCascade') cat.mutations.markCascade(cstate, p)
      if (m === 'filters/setList') filterListResult = p
    }
  }
  cat.mutations.softDelete.call(storeFake, cstate, 5)
  await tick()
  const bak = metaMap.get('catFiltersBak.5')
  assert.ok(bak && JSON.parse(bak).some(f => f.id === 'f5'), 'the doomed filter is backed up at delete time')
  assert.equal(cstate.list[0].delete, true, 'victim marked deleted')
  // recover side: restore project meta backup absent, filters backup present
  const cstate7 = { list: [{ categoryId: 7, delete: true, folderId: 0, folderIs: false, deletedAt: Date.now() }], projectIds: [] }
  metaMap.set('catFiltersBak.7', JSON.stringify([{ id: 'f7', conds: { catId: 7 }, name: 'F7' }]))
  filterListResult = [{ id: 'f7', conds: { catId: 7 }, name: 'F7' }]
  const storeFake7 = { state: { filters: { list: [] } }, commit (m, p) { if (m === 'filters/setList') filterListResult = p } }
  cat.mutations.recover.call(storeFake7, cstate7, 7)
  await tick(120)
  assert.ok(filterUpserts.some(f => f && f.id === 'f7'), 'recover re-puts the backed-up filter')
  assert.ok(!metaMap.has('catFiltersBak.7'), 'filters backup consumed after restore')
  assert.ok(filterListResult.some(f => f.id === 'f7'), 'filters list refreshed')
})

test('B10 milestone restore merges: live newer entries survive, backup-only entries are re-added', async () => {
  const cat = (await import('../../../renderer/js/store/category.js')).default
  metaMap.set('catProjectMetaBak.8', JSON.stringify({ flag: '', status: '', deadline: '', milestones: JSON.stringify([{ id: 'ms1', title: 'Old', date: today, taskIds: [] }]) }))
  metaMap.set('projectMilestones:8', JSON.stringify([{ id: 'ms2', title: 'Added while deleted', date: today + 86400000, taskIds: [] }]))
  const cstate = { list: [{ categoryId: 8, delete: true, folderId: 0, folderIs: false, deletedAt: Date.now() }], projectIds: [] }
  const storeFake = { state: { filters: { list: [] } }, commit () {} }
  cat.mutations.recover.call(storeFake, cstate, 8)
  await tick(120)
  const ms = JSON.parse(metaMap.get('projectMilestones:8'))
  const ids = ms.map(m => m.id).sort()
  assert.deepEqual(ids, ['ms1', 'ms2'], 'backup-only milestone re-added AND the newer live milestone kept (no clobber)')
  assert.equal(ms[0].id, 'ms1', 'merged list re-sorted by date')
})

/* ==================== B11: no-date completed tasks stay visible past completion day ==================== */

test('B11 a no-date completion from yesterday lands in recent.expiredCompleted (not vanished)', async () => {
  const { createStore } = await import('vuex')
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const rows = [
    { taskId: 'nd1', taskContent: 'nd1', delete: false, complete: true, dayStart: 0, createTime: 1000, updateTime: today - 86400000, completedAt: today - 86400000 },
    { taskId: 'nd2', taskContent: 'nd2', delete: false, complete: true, dayStart: 0, createTime: 1001, updateTime: Date.now(), completedAt: Date.now() }
  ]
  const store = createStore({
    modules: {
      todo: { ...todo, state: () => ({ ...todo.state(), todoList: rows, viewsDirty: true }) },
      settings: {
        namespaced: true,
        state: { recycleBinAutoDeleteDays: 0, showNoDate: false, todoBoxCategoryId: -1, todoBoxSortOrder: 'asc', todoBoxSortMethod: 'created', sortMode: 'default' }
      }
    }
  })
  await store.dispatch('todo/computeViews')
  const views = store.state.todo.views
  assert.ok(views.recent.expiredCompleted.some(t => t.taskId === 'nd1'),
    'yesterday\'s no-date completion is bucketed like the dated path (pre-fix: present nowhere but the uncapped global list)')
  assert.ok(views.todayDoneList.some(t => t.taskId === 'nd2'), "today's no-date completion stays in today-done")
})

/* ==================== B15: habits applyExternal tie guard ==================== */

test('B15 applyExternal rejects a TIE (prior writer wins); newer blobs still apply', async () => {
  const habits = (await import('../../../renderer/js/store/habits.js')).default
  const s = { habits: [{ id: 'h1', records: {} }], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(s, { habits: [{ id: 'h2', records: {} }], moments: [], savedAt: 100 })
  assert.equal(s.habits[0].id, 'h1', 'an equal savedAt no longer lets the inbound copy rewrite state')
  assert.equal(s.savedAt, 100)
  habits.mutations.applyExternal(s, { habits: [{ id: 'h3', records: {} }], moments: [], savedAt: 200 })
  assert.equal(s.habits[0].id, 'h3', 'strictly newer blobs still apply')
})
