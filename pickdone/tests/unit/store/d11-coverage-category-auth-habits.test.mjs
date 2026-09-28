/* maint/d11 coverage-restore wave: behavior tests for category.js (cascade delete, project flags,
 * meta lifecycle, init tombstone retention), auth.js (saveSnowGain dedup + delta fold), and
 * habits.js (isDueOn schedules, record normalization) branches the d11 rounds touched.
 * Run: node --test tests/unit/store/d11-coverage-category-auth-habits.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import category, { collectCascadeIds, COLOR_PALETTE } from '../../../renderer/js/store/category.js'
import auth from '../../../renderer/js/store/auth.js'
import habits, { isDueOn, normalizeHabitRecords } from '../../../renderer/js/store/habits.js'

const cat = (id, extra = {}) => Object.assign({
  categoryId: id, categoryName: 'c' + id, categoryColor: null, createTime: 1,
  listSort: 100, folderIs: 0, folderId: 0, delete: false
}, extra)

function metaStore () {
  const m = new Map()
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'getMeta') return m.has(params) ? m.get(params) : null
      if (op === 'setMeta') { m.set(params[0], params[1]); return 1 }
      if (op === 'deleteMeta') { m.delete(params); return 1 }
      if (op === 'getAllCategories') return []
      return null
    }
  }
  return m
}

test('category getters: byId excludes soft-deleted; hierarchical nests folder children; roots/sortedAll order', () => {
  const s = { list: [cat(2, { listSort: 50 }), cat(1, { listSort: 10 }), cat(3, { folderIs: 1, listSort: 5 }), cat(4, { folderId: 3, listSort: 6 }), cat(5, { delete: true })], projectIds: [], projectMeta: {} }
  assert.equal(category.getters.byId(s)(5), null, 'soft-deleted category no longer answers byId')
  assert.equal(category.getters.byId(s)(1).categoryId, 1)
  const roots = category.getters.roots(s)
  assert.deepEqual(roots.map(c => c.categoryId), [1, 2], 'folders excluded from roots, sorted by listSort')
  assert.deepEqual(category.getters.folders(s).map(c => c.categoryId), [3])
  assert.equal(category.getters.visibleCount(s), 1)
  const hier = category.getters.hierarchical(s)
  const folder = hier.find(c => c.categoryId === 3)
  assert.deepEqual(folder.children.map(c => c.categoryId), [4], 'children nested under the folder')
  assert.equal(category.getters.projectStatus(s)(9), 'active', 'absent/invalid status normalizes to active')
})

test('collectCascadeIds: nested folders cascade, cycles truncate instead of recursing forever', () => {
  const s = { list: [cat(1, { folderIs: 1 }), cat(2, { folderId: 1, folderIs: 1 }), cat(3, { folderId: 2 }), cat(4, { folderId: 3, folderIs: 1 }), cat(5, { folderId: 4 })] }
  const ids = collectCascadeIds(s, 1)
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2, 3], 'folder cascade covers the folder subtree (folders keep walking, plain cats are collected)')
  const cyc = { list: [cat(1, { folderIs: 1, folderId: 2 }), cat(2, { folderIs: 1, folderId: 1 })] }
  const ids2 = collectCascadeIds(cyc, 1)
  assert.ok(ids2.length >= 1 && ids2.length <= 2, 'A↔B mutual parents must not RangeError')
})

test('category mutations: addCategory appends sort + palette color; updateCategory ignores unknown ids; reorder rewrites sort scores', () => {
  globalThis.localStorage.removeItem('categoryState')
  const s = category.state()
  s.list = []
  category.mutations.addCategory(s, { categoryName: 'alpha' })
  assert.equal(s.list[0].categoryName, 'alpha')
  assert.equal(s.list[0].categoryColor, COLOR_PALETTE[0])
  assert.equal(s.list[0].listSort, 100)
  category.mutations.addCategory(s, { categoryName: 'beta' })
  assert.equal(s.list[1].listSort, 200)
  assert.equal(s.list[1].categoryColor, COLOR_PALETTE[1])
  category.mutations.updateCategory(s, { categoryId: 999, categoryName: 'ghost' })
  assert.ok(!s.list.some(c => c.categoryName === 'ghost'), 'unknown id ignored')
  category.mutations.updateCategory(s, { categoryId: s.list[0].categoryId, categoryName: 'renamed' })
  assert.equal(s.list[0].categoryName, 'renamed')
  category.mutations.reorder(s, [s.list[1].categoryId, s.list[0].categoryId])
  assert.equal(s.list[1].listSort, 100)
  assert.equal(s.list[0].listSort, 200)
  category.mutations.setProject(s, { id: s.list[0].categoryId, flag: true })
  assert.ok(s.projectIds.includes(s.list[0].categoryId), 'project flag enters the session list')
  category.mutations.setProject(s, { id: s.list[0].categoryId, flag: false })
  assert.ok(!s.projectIds.includes(s.list[0].categoryId), 'unmark removes it')
  category.mutations.mergeProjectMeta(s, { [s.list[0].categoryId]: { status: 'paused' } })
  assert.equal(s.projectMeta[s.list[0].categoryId].status, 'paused')
  category.mutations.setProjectStatus(s, { id: s.list[0].categoryId, status: 'bogus' })
  assert.equal(s.projectMeta[s.list[0].categoryId].status, 'active', 'invalid status normalizes')
})

test('category mutations.markCascade + softDelete: descendants tombstoned, projectIds trimmed', () => {
  metaStore()
  const s = category.state()
  s.list = [cat(1, { folderIs: 1 }), cat(2, { folderId: 1 }), cat(3)]
  s.projectIds = [1, 3]
  const commit = (m, p) => { const name = String(m).split('/').pop(); if (category.mutations[name]) category.mutations[name](s, p) }
  category.mutations.softDelete.call({ commit, state: s }, s, 1)
  const one = s.list.find(c => c.categoryId === 1)
  assert.equal(one.delete, true)
  assert.ok(one.deletedAt > 0, 'tombstone stamped with deletion time')
  assert.equal(s.list.find(c => c.categoryId === 2).delete, true, 'child of the folder cascades')
  assert.equal(s.list.find(c => c.categoryId === 3).delete, false, 'unrelated survives')
  assert.deepEqual(s.projectIds, [3], 'deleted project ids leave the session list')
})

test('category actions.init: live rows win, LS tombstones re-attach only inside the retention window', async () => {
  metaStore()
  const freshTomb = { ...cat(9, { delete: true }), deletedAt: Date.now() - 1000 }
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [freshTomb] }))
  const a = { commit: (m, p) => { const name = String(m).split('/').pop(); if (category.mutations[name]) category.mutations[name](a.state, p) }, state: category.state(), rootState: { settings: { recycleBinAutoDeleteDays: 30 } } }
  globalThis.window.todoAPI.dbCall = async (op, params) => {
    if (op === 'getAllCategories') return [cat(1), cat(2)]
    if (op === 'getMeta') return null
    return null
  }
  const n = await category.actions.init.call({ dispatch: async () => {} }, a)
  assert.equal(n, 2)
  assert.deepEqual(a.state.list.map(c => c.categoryId).sort(), [1, 2, 9], 'recent tombstone re-attached for recovery')

  // retention window 0 = never purge tombstones
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [{ ...cat(9, { delete: true }), deletedAt: 1 }] }))
  const b = { commit: (m, p) => { const name = String(m).split('/').pop(); if (category.mutations[name]) category.mutations[name](b.state, p) }, state: category.state(), rootState: { settings: { recycleBinAutoDeleteDays: 0 } } }
  globalThis.window.todoAPI.dbCall = async (op) => { if (op === 'getAllCategories') return [cat(1)]; return null }
  await category.actions.init.call({ dispatch: async () => {} }, b)
  assert.deepEqual(b.state.list.map(c => c.categoryId).sort(), [1, 9], 'never-purge keeps even ancient tombstones')

  // retention 30d: ancient tombstone dropped
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [{ ...cat(9, { delete: true }), deletedAt: Date.now() - 40 * 86400000 }] }))
  const c = { commit: (m, p) => { const name = String(m).split('/').pop(); if (category.mutations[name]) category.mutations[name](c.state, p) }, state: category.state(), rootState: { settings: { recycleBinAutoDeleteDays: 30 } } }
  globalThis.window.todoAPI.dbCall = async (op) => { if (op === 'getAllCategories') return [cat(1)]; return null }
  await category.actions.init.call({ dispatch: async () => {} }, c)
  assert.deepEqual(c.state.list.map(x => x.categoryId), [1], 'tombstone past the retention window is not resurrected')
  globalThis.localStorage.removeItem('categoryState')
})

test('auth.saveSnowGain: dedupKey applies once across retries; bare-number legacy payload still works', async () => {
  globalThis.localStorage.removeItem('authSnowGainDedup')
  const st = auth.state()
  st.user = { userId: 1, snow: 10, tomatoGain: 2 }
  const patched = []
  const ctx = { state: st, commit: (m, p) => { patched.push(p); auth.mutations.patchUser(st, p) } }
  await auth.actions.saveSnowGain(ctx, { gain: 25, dedupKey: '12345' })
  assert.equal(st.user.snow, 35)
  assert.equal(st.user.tomatoGain, 27)
  await auth.actions.saveSnowGain(ctx, { gain: 25, dedupKey: '12345' })
  assert.equal(st.user.snow, 35, 'same dedupKey never double-applies (completeFocus retry safety)')
  await auth.actions.saveSnowGain(ctx, 5)
  assert.equal(st.user.snow, 40, 'legacy bare-number payload still applies')
  assert.equal(patched.length, 2)
  globalThis.localStorage.removeItem('authSnowGainDedup')
})

test('auth mutations: setUser/patchUser persist; logout flips the flag', () => {
  const st = auth.state()
  auth.mutations.setUser(st, { userId: 2, snow: 1 })
  assert.equal(st.user.userId, 2)
  auth.mutations.patchUser(st, { snow: 9 })
  assert.equal(st.user.snow, 9)
  assert.equal(st.user.userId, 2, 'patch keeps the rest of the user')
  auth.mutations.setLastLoginRecord(st, { method: 2, value: 'x' })
  assert.equal(st.lastLoginRecord.method, 2)
  auth.mutations.logout(st)
  assert.equal(st.loggedIn, false)
})

test('habits.isDueOn: daily/weekdays/interval schedules and the unknown-type fallback', () => {
  assert.equal(isDueOn({}, '2026-09-28'), true, 'no frequency defaults to daily')
  assert.equal(isDueOn({ frequency: { type: 'daily' } }, '2026-09-28'), true)
  // 2026-09-28 is a Monday (mon0 = 0)
  assert.equal(isDueOn({ frequency: { type: 'weekdays', weekdays: [0] } }, '2026-09-28'), true)
  assert.equal(isDueOn({ frequency: { type: 'weekdays', weekdays: [1] } }, '2026-09-28'), false)
  assert.equal(isDueOn({ frequency: { type: 'weekdays' } }, '2026-09-28'), false, 'empty weekday list never due')
  assert.equal(isDueOn({ frequency: { type: 'interval', intervalN: 2 }, createdAt: '2026-09-26T00:00:00' }, '2026-09-28'), true, 'every-2 lands on anchor+2')
  assert.equal(isDueOn({ frequency: { type: 'interval', intervalN: 2 }, createdAt: '2026-09-26T00:00:00' }, '2026-09-27'), false)
  assert.equal(isDueOn({ frequency: { type: 'interval', intervalN: 2 }, createdAt: '2026-09-26T00:00:00' }, '2026-09-25'), false, 'before creation never due')
  assert.equal(isDueOn({ frequency: { type: 'mystery' } }, '2026-09-28'), true, 'unknown type falls through to due (documented)')
})

test('habits.normalizeHabitRecords: coerces records to a date-keyed map (streak getters rely on it)', () => {
  const list = [
    { id: 'h1', records: 'garbage' },
    { id: 'h2', records: { '2026-09-27': true } },
    { id: 'h3' }
  ]
  normalizeHabitRecords(list)
  assert.deepEqual(list[0].records, {}, 'non-object records reset to an empty map')
  assert.deepEqual(list[1].records, { '2026-09-27': true }, 'valid map untouched')
  assert.deepEqual(list[2].records, {}, 'missing records field gets an empty map')
  normalizeHabitRecords('not a list')
  normalizeHabitRecords([null, 42])
})

test('habits.toggleCheck: stamps and un-stamps today in the records map; unknown habit is a no-op', () => {
  const today = globalThis.window.dayjs().format('YYYY-MM-DD')
  const s = { habits: [{ id: 'h1', name: 'drink', records: {} }], moments: [], savedAt: 0 }
  habits.mutations.toggleCheck(s, { id: 'h1', day: today })
  assert.equal(s.habits[0].records[today], true, 'toggle stamps today')
  habits.mutations.toggleCheck(s, { id: 'h1', day: today })
  assert.equal(s.habits[0].records[today], undefined, 'second toggle un-stamps (idempotent switch)')
  habits.mutations.toggleCheck(s, { id: 'ghost', day: today })
})
