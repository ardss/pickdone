/**
 * QC follow-up round (renderer store) — behavior regression guards.
 * Fixes covered:
 *   [U-1] repeat renewal writes the per-task estimate meta key for the NEW instance
 *   [U-2] orphan repeat-rule cleanup calls deleteMeta with the bare key string (util extracted from RepeatDeleteModal)
 *   [U-4] category softDelete backs up project meta; recover restores flag/status/deadline/milestones
 *   [U-5] project unmark rewrites the legacy projectCategoryIds array without the id (init no longer resurrects)
 *   [U-8] purgeExpiredRecycle: same-local-day dedupe + stamp written only AFTER the purge attempt
 * Run: node --test tests/unit/renderer/qc-ui-followup-store.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { todayMidnightMs } from '../../lib/clock.mjs'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const dbCalls = []
const metaStore = new Map()

// setup.mjs already installs globalThis.localStorage; expose the same shim on window (browser alias)
// and use it directly so action-body writes (bare `localStorage`) are observable in assertions.
const LS = globalThis.localStorage
globalThis.window.localStorage = LS
const setLS = (k, v) => LS.setItem(k, v)
const getLS = k => LS.getItem(k)

globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    if (op === 'getAllCategories') return []
    if (op === 'getAll') return []
    return 'ok'
  },
  notification: () => {}
}
// RepeatDeleteModal's orphan-rule path: queryTodos routing honors a per-test impl when installed
globalThis.window.todoAPI.queryTodosImpl = null
globalThis.window.todoAPI.dbCall = (op => async (o, p) => { if (o === 'queryTodos' && globalThis.window.todoAPI.queryTodosImpl) return globalThis.window.todoAPI.queryTodosImpl(p); return op(o, p) })(globalThis.window.todoAPI.dbCall)
const callsOf = op => dbCalls.filter(([o]) => o === op).map(([, p]) => p)
const resetCalls = () => { dbCalls.length = 0 }

const DAY = 86400000
const today0 = todayMidnightMs() // D4 clock determinism: noon-anchored via tests/lib/clock.mjs

const todo = (await import('../../../renderer/js/store/todo.js')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const repeatUtils = await import('../../../renderer/js/utils/repeat.js')

/* ---------- [U-1] repeat renewal keeps the estimate (per-task meta key on the NEW task) ---------- */

test('[U-1] ensureNextRepeatInstance writes the per-task estimate meta key for the renewed instance', async () => {
  const rid = 'u1r'
  metaStore.set('repeatRule:' + rid, JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 30 }))
  const completed = {
    taskId: 'u1src', repeatId: rid, dayStart: today0, todoTime: today0, categoryId: 0,
    taskContent: 'recurring', taskDescribe: '', estimate: 4, reminderTime: 0,
    reminderOffsets: [], reminderExtra: [], subtasks: null, difficulty: 0
  }
  const ctx = { dispatch: (n, p) => Promise.resolve({ taskId: 'u1new', estimate: p && p.estimate }) }
  const fakeThis = { state: { todo: { todoList: [{ ...completed }], holidayList: [] } } }
  resetCalls()
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, completed)
    const setCalls = callsOf('setMeta').filter(p => p[0] === 'tomatoEstimateState:u1new')
  assert.equal(setCalls.length, 1, 'renewal must write the per-task estimate meta key for the new task')
  assert.equal(setCalls[0][1], '4', 'the new instance inherits the completed task estimate')
})

/* ---------- [U-2] orphan-rule cleanup deleteMeta bare string ---------- */

test('[U-2] cleanupOrphanRepeatRule passes the bare key string to deleteMeta (not an array)', async () => {
  resetCalls()
  metaStore.set('repeatRule:u2r', '{}')
  globalThis.window.todoAPI.queryTodosImpl = async () => [] // no live instances → orphan cleanup runs
  await repeatUtils.cleanupOrphanRepeatRule('u2r')
  await new Promise(r => setTimeout(r, 10))
  const dels = callsOf('deleteMeta')
  assert.ok(dels.length >= 1, 'orphan rule cleanup must call deleteMeta')
  assert.equal(typeof dels[dels.length - 1], 'string', 'deleteMeta arg must be a bare string (array form binds as positional params and throws)')
  assert.equal(dels[dels.length - 1], 'repeatRule:u2r')
})

/* ---------- [U-4] soft-delete backs up project meta, recover restores it ---------- */

test('[U-4] softDelete → recover restores project flag/status/deadline/milestones and deletes the backup', async () => {
  const id = 987001
  const state = {
    list: [{ categoryId: id, userId: 1, categoryName: 'P', categoryColor: '#fff', createTime: 1, listSort: 100, folderIs: false, folderId: 0, delete: false }],
    projectIds: [id],
    projectMeta: { [id]: { status: 'paused', deadline: 123, nextMilestone: null } },
    filters: { list: [] }
  }
  metaStore.set('projectCategoryFlag:' + id, '1')
  metaStore.set('projectStatus:' + id, 'paused')
  metaStore.set('projectDeadline:' + id, '123')
  metaStore.set('projectMilestones:' + id, JSON.stringify([{ id: 'm1', title: 'M', date: 999, taskIds: [] }]))
  const commits = []
  const ctx = {
    commit: (t, p) => {
      commits.push([t, p])
      if (t === 'category/markCascade') category.mutations.markCascade.call(null, state, id)
    },
    state
  }
  category.mutations.softDelete.call(ctx, state, id)
  // softDelete is sync but the backup/clear chain is async — wait for it to settle
  await new Promise(r => setTimeout(r, 20))
  assert.ok(metaStore.has('catProjectMetaBak.' + id), 'softDelete must write the machine-local backup key')
  assert.equal(metaStore.get('projectCategoryFlag:' + id), undefined, 'live flag key cleared after backup')
  assert.equal(metaStore.get('projectStatus:' + id), undefined, 'live status key cleared after backup')
  assert.equal(metaStore.get('projectMilestones:' + id), undefined, 'milestones cleared symmetrically with the CLI')

  // recover
  category.mutations.recover.call({ state }, state, id)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(state.list[0].delete, false, 'recover un-deletes the category')
  assert.equal(metaStore.get('projectCategoryFlag:' + id), '1', 'flag restored')
  assert.equal(metaStore.get('projectStatus:' + id), 'paused', 'status restored')
  assert.equal(metaStore.get('projectDeadline:' + id), '123', 'deadline restored')
  assert.ok(String(metaStore.get('projectMilestones:' + id)).includes('m1'), 'milestones restored')
  assert.equal(metaStore.get('catProjectMetaBak.' + id), undefined, 'backup deleted after restore')
  assert.ok(state.projectIds.includes(id), 'restored project flag re-enters projectIds')
})

/* ---------- [U-5] project unset rewrites the legacy array (no resurrection) ---------- */

test('[U-5] setProject(flag:false) rewrites legacy projectCategoryIds without the id so init no longer resurrects it', async () => {
  const id = 987002
  const state = { list: [], projectIds: [id], projectMeta: {} }
  metaStore.set('projectCategoryIds', JSON.stringify([id, 42]))
  category.mutations.setProject.call({}, state, { id, flag: false })
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(JSON.parse(metaStore.get('projectCategoryIds')), [42], 'legacy array rewritten without the id')
  assert.equal(metaStore.get('projectCategoryFlag:' + id), undefined, 'per-cat flag key deleted')
})

/* ---------- [U-8] purgeExpiredRecycle same-day dedupe + stamp-after-attempt ---------- */

test('[U-8] purgeExpiredRecycle: same local day skips; the stamp lands only after the purge attempt', async () => {
  const now = Date.now()
  const expiredRow = { taskId: 'old-1', deletedAt: now - 30 * DAY, updateTime: now - 30 * DAY }
  const makeCtx = (rows, disp) => ({
    state: { recycleList: rows },
    rootState: { settings: { recycleBinAutoDeleteDays: 7 } },
    dispatch: disp
  })
  // 1) first run of the day: attempts purge, then stamps
  setLS('recycleLastPurgeAt', '0')
  const dispatched = []
  await todo.actions.purgeExpiredRecycle.call({}, makeCtx([expiredRow], (a, p) => { dispatched.push([a, p]); return Promise.resolve(true) }), { force: true })
  assert.deepEqual(dispatched.map(d => d[0]), ['purgeIds'], 'first run of the day attempts the purge')
  const stamp1 = Number(getLS('recycleLastPurgeAt'))
  assert.ok(stamp1 >= now - 5000, 'stamp written after the attempt')
  // 2) second run the same day: skipped even with fresh expired rows
  const dispatched2 = []
  await todo.actions.purgeExpiredRecycle.call({}, makeCtx([{ taskId: 'old-2', deletedAt: now - 40 * DAY, updateTime: now - 40 * DAY }], (a, p) => { dispatched2.push([a, p]); return Promise.resolve(true) }), {})
  assert.equal(dispatched2.length, 0, 'same-local-day re-run is deduped')
  assert.equal(Number(getLS('recycleLastPurgeAt')), stamp1, 'deduped run does not re-stamp')
  // 3) last purge stamped yesterday: runs again
  setLS('recycleLastPurgeAt', String(now - DAY))
  const dispatched3 = []
  await todo.actions.purgeExpiredRecycle.call({}, makeCtx([expiredRow], (a, p) => { dispatched3.push([a, p]); return Promise.resolve(true) }), {})
  assert.equal(dispatched3.length, 1, 'a lastPurgeAt from a previous local day runs the purge')
  // 4) the stamp lands after the attempt even when the attempt fails (previously stamped up front → a failed purge never retried all day)
  setLS('recycleLastPurgeAt', '0')
  const dispatched4 = []
  const failDisp = (a, p) => { dispatched4.push([a, p]); return Promise.reject(new Error('db down')) }
  await todo.actions.purgeExpiredRecycle.call({}, makeCtx([expiredRow], failDisp), { force: true }).catch(() => {})
  assert.ok(dispatched4.length >= 1, 'attempt was made')
  assert.ok(Number(getLS('recycleLastPurgeAt')) >= now - 5000, 'stamp follows the attempt (never precedes it)')
})
