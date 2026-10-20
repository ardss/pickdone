/**
 * F2 2026-10-19 fix wave — regression tests:
 *   [1] habits applyExternal/applyExternalPatch: moments were whole-array LWW replaced — a newer
 *       peer blob silently erased this device's countdowns/anniversaries it never saw. Now moments
 *       are union-merged by id (ids from either side survive; overlapping id: incoming wins its
 *       defined fields, undefined fields backfill from local) — same conservative family as the
 *       records union-max merge.
 *   [2] todo purgeIds/purgeAllRecycle: purged ids stayed in survivors' predecessors forever
 *       (dangling references; blocked statistics silently shrank). Survivors now get the purged
 *       entries stripped via the normal updateTodoFields channel (removing edges can never close
 *       a cycle).
 *   [3] todo purgeExpiredRecycle: the cutoff fell back to updateTime, so legacy rows without
 *       deletedAt were indefinitely renewed by bin auto-save bumps. Cutoff now trusts ONLY
 *       deletedAt; legacy rows opt OUT of auto-purge.
 * Skipped (recorded, not fixed — product-caliber decision): utils/deps.js isTaskReady treats a
 * recycled-bin predecessor as "already satisfied" (a row unlocks at recycle time / re-blocks after
 * restore). Deletion reversibility vs blocking semantics — out of scope for this wave.
 * Run: node --test tests/unit/store/f2b-moments-union-purge-preds.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import habits, { unionMoments } from '../../../renderer/js/store/habits.js'

const LS = globalThis.localStorage
const clearLS = () => { for (let i = LS.length - 1; i >= 0; i--) LS.removeItem(LS.key(i)) }

const moment = (id, over = {}) => Object.assign({ id, name: 'm-' + id, date: '2026-01-01', kind: 'countdown' }, over)

/* ---------------- [1] habits moments union-merge on the external fold channels ---------------- */

test('habits [1a] applyExternal: newer blob missing a local moment keeps BOTH moments', () => {
  clearLS()
  const s = { habits: [], moments: [moment('m-a')], savedAt: 100, deleted: [] }
  habits.mutations.applyExternal(s, { habits: [], moments: [moment('m-b')], savedAt: 200 })
  const ids = s.moments.map(m => m.id).sort()
  assert.deepEqual(ids, ['m-a', 'm-b'], 'the local countdown/anniversary must survive a newer peer blob')
  assert.equal(s.savedAt, 200)
})

test('habits [1b] applyExternalPatch: partial moments field union-merges the same way', () => {
  clearLS()
  const s = { habits: [], moments: [moment('m-a')], savedAt: 100, deleted: [] }
  habits.mutations.applyExternalPatch(s, { fields: { moments: [moment('m-b')], savedAt: 250 } })
  assert.deepEqual(s.moments.map(m => m.id).sort(), ['m-a', 'm-b'])
  assert.equal(s.savedAt, 250)
})

test('habits [1c] overlapping id: incoming wins defined fields, undefined fields backfill from local', () => {
  clearLS()
  const local = moment('m-a', { name: 'renamed-locally' })
  const incoming = { id: 'm-a', date: '2026-05-05' } // peer copy lacks name/kind entirely
  const out = unionMoments([incoming], [local])
  assert.equal(out.length, 1)
  assert.equal(out[0].date, '2026-05-05', 'incoming defined field wins')
  assert.equal(out[0].name, 'renamed-locally', 'local-only field survives the merge')
  assert.equal(out[0].kind, 'countdown', 'base default still present')
})

test('habits [1d] stale rounds still rejected outright (unchanged guard)', () => {
  clearLS()
  const s = { habits: [], moments: [moment('m-a')], savedAt: 300, deleted: [] }
  habits.mutations.applyExternal(s, { habits: [], moments: [moment('m-x')], savedAt: 100 })
  assert.deepEqual(s.moments.map(m => m.id), ['m-a'])
})

/* ---------------- [2]/[3] todo purge: predecessor stripping + deletedAt-only cutoff ---------------- */

const calls = []
let dbHandler = null
// Merge-style stubs (maint-d7 pattern): mutate the shared window instead of replacing it, and
// import todo.js with a cache-busting query so this file gets a FRESH instance bound to OUR
// stubs — the plain-import instance may have been hydrated by setup.mjs's import graph with a
// different window shape, which under full-suite load showed up as a never-settling purge await.
if (!globalThis.window.location) globalThis.window.location = { hash: '' }
globalThis.window.commands = {
  commit: (entity, verb, payload) => {
    calls.push([entity, verb, payload])
    if (entity === 'todo' && verb === 'hardDeleteMany') return Promise.resolve(payload)
    return Promise.resolve(null)
  }
}
globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
  dbCall: (op, params) => { calls.push([op, params]); return dbHandler ? dbHandler(op, params) : Promise.resolve(null) },
  writeCriticalStateBackup: () => Promise.resolve(),
  deleteTodoFilesMany: () => Promise.resolve(0),
  purgeRecycleBin: () => Promise.resolve(true)
})

const todoMod = await import('../../../renderer/js/store/todo.js?f2b')
const todoActions = todoMod.default.actions
const { pendingUpserts } = todoMod._testInternals

const row = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 't-' + taskId, delete: false, complete: false,
  predecessors: null, updateTime: 1, status: 'add', version: 0
}, over)

const mkCtx = (state, extra = {}) => ({
  state,
  rootState: Object.assign({ settings: { recycleBinAutoDeleteDays: 7 }, auth: { user: { userId: 1 } }, category: { list: [] } }, extra.rootState || {}),
  commit: () => {},
  dispatch: extra.dispatch || (async () => null)
})

beforeEach(() => {
  calls.length = 0
  dbHandler = null
  pendingUpserts.splice(0, pendingUpserts.length)
  clearLS()
})

const dispatchedEdits = dispatchCalls => dispatchCalls.filter(d => d.action === 'updateTodoFields').map(d => d.payload)

// Diagnostic harness: the purge action historically showed a never-settling await ONLY inside the
// full-corpus run (2ms 'pending promise' runner artifact). The watchdog converts that silent pend
// into a named failure with the command log, and keeps the loop alive so the runner reports THIS
// error instead of a teardown artifact.
const withWatchdog = async (label, actionCall) => {
  let timer = null
  const r = await Promise.race([
    actionCall,
    new Promise(res => { timer = setTimeout(() => res({ __f2bTimeout: true }), 5000) })
  ])
  clearTimeout(timer)
  if (r && r.__f2bTimeout) {
    console.error('[f2b-diag]', label, 'did not settle; command log:', JSON.stringify(calls))
    throw new Error('[f2b-diag] ' + label + ' never settled — see command log above')
  }
  return r
}

test('purgeIds: live AND bin survivors referencing a purged id get their predecessors stripped', async () => {
  const dispatchCalls = []
  const dispatch = async (action, payload) => { dispatchCalls.push({ action, payload }); return null }
  const state = {
    todoList: [
      row('s1', { predecessors: JSON.stringify(['purged', 'keep']) }),
      row('s2', { predecessors: JSON.stringify(['keep']) }) // untouched — no purged reference
    ],
    recycleList: [row('b1', { delete: true, predecessors: JSON.stringify(['purged']) })]
  }
  const r = await withWatchdog('purgeIds#strip', todoActions.purgeIds.call({}, mkCtx(state, { dispatch }), ['purged']))
  assert.deepEqual(r.done, ['purged'])
  const edits = dispatchedEdits(dispatchCalls)
  assert.equal(edits.length, 2, 'exactly s1 (live) and b1 (bin) are patched')
  const byId = Object.fromEntries(edits.map(e => [e.taskId, e.patch]))
  assert.deepEqual(byId.s1.predecessors, ['keep'])
  assert.deepEqual(byId.b1.predecessors, [])
  assert.equal(byId.s1.status, 'update')
  assert.equal(byId.b1.status, 'update')
  assert.ok(!edits.some(e => e.taskId === 's2'), 'unaffected survivor is not rewritten')
})

test('purgeAllRecycle: live survivors referencing a binned-purged id are stripped too', async () => {
  const dispatchCalls = []
  const dispatch = async (action, payload) => { dispatchCalls.push({ action, payload }); return null }
  const state = {
    todoList: [row('s1', { predecessors: JSON.stringify(['bin-x']) })],
    recycleList: [row('bin-x', { delete: true }), row('bin-y', { delete: true })]
  }
  const ok = await withWatchdog('purgeAllRecycle#strip', todoActions.purgeAllRecycle.call({}, mkCtx(state, { dispatch })))
  assert.equal(ok, true)
  const edits = dispatchedEdits(dispatchCalls)
  assert.equal(edits.length, 1)
  assert.equal(edits[0].taskId, 's1')
  assert.deepEqual(edits[0].patch.predecessors, [], 'last reference stripped -> empty predecessors')
})

test('purgeIds: a stripping edit dispatch never happens when nothing references the purged ids', async () => {
  const dispatchCalls = []
  const dispatch = async (action, payload) => { dispatchCalls.push({ action, payload }); return null }
  const state = { todoList: [row('s1')], recycleList: [row('gone', { delete: true })] }
  await withWatchdog('purgeIds#noop', todoActions.purgeIds.call({}, mkCtx(state, { dispatch }), ['gone']))
  assert.equal(dispatchedEdits(dispatchCalls).length, 0)
})

test('purgeExpiredRecycle: legacy rows without deletedAt opt OUT; deletedAt rows past cutoff purge', async () => {
  const now = Date.now()
  const old = now - 30 * 86400000
  const dispatchCalls = []
  const dispatch = async (action, payload) => { dispatchCalls.push({ action, payload }); return null }
  const state = {
    recycleList: [
      row('legacy', { delete: true, updateTime: old }), // no deletedAt: was purgeable via the updateTime fallback, now exempt
      row('stamped', { delete: true, deletedAt: old }),
      row('fresh', { delete: true, deletedAt: now - 86400000 }) // inside the 7-day window
    ]
  }
  await withWatchdog('purgeExpiredRecycle#cutoff', todoActions.purgeExpiredRecycle.call({}, mkCtx(state, { dispatch }), { force: true }))
  const purgeCall = dispatchCalls.find(d => d.action === 'purgeIds')
  assert.ok(purgeCall, 'auto-purge dispatched')
  assert.deepEqual(purgeCall.payload, ['stamped'], 'only the deletedAt-stamped row past cutoff purges; legacy and fresh rows survive')
})
