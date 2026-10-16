/**
 * F2 round (2026-10-17) — renderer repeat-restore + dependency fixes, behavior tests
 * (real store actions driven with a fake `this`, same paradigm as maint-0926-domainD).
 *
 * Covered:
 *   [F2-1] restoreFromRecycle cancels (REPEAT_TWIN_EXISTS) when a LIVE sibling of the same
 *          repeat group already occupies the same scheduled day — the schema-v9 partial UNIQUE
 *          index idx_todos_repeat_day used to reject the restore write with a bare stack;
 *          the pre-check refuses BEFORE any write. A failed twin-query read does NOT block
 *          the restore (the index stays the backstop).
 *   [F2-2] addTodo's renewal idempotency pre-check now consults the recycle bin too: a twin
 *          the user soft-deleted on the SAME rid+day blocks regeneration (return null).
 *   [F2-4] restoreFromRecycle re-validates dependencies after restore: a cycle closed through
 *          the recycled row (invisible to the write-time guard) strips the restored row's
 *          predecessors without rolling back the restore (_depCycleStripped flag).
 *
 * Run: node --test tests/unit/renderer/f2-repeat-restore-deps.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const todo = (await import('../../../renderer/js/store/todo.js')).default

const recycledRow = (over = {}) => Object.assign({
  taskId: 't1', taskContent: 'recycled instance', delete: true, complete: false,
  dayStart: 20261017, repeatId: 'r1', predecessors: null,
  status: 'delete', version: 0, updateTime: 1
}, over)

/** Fake store: real action, fake commit/dispatch. dispatch('updateTodoFields') returns the
 *  merged row shape updateTodoFields really returns (base merged with the patch). */
function makeCtx ({ state, baseRow = {}, dbCall = async () => null } = {}) {
  const dispatches = []
  const dispatch = async (a, p) => { dispatches.push([a, p]); return Object.assign({}, baseRow, (p && p.patch) || {}) }
  const commitLog = []
  const ctx = {
    commit: (t) => commitLog.push(t),
    dispatch,
    rootState: { settings: {}, auth: { user: { userId: 1 } } }
  }
  globalThis.window.todoAPI = { dbCall }
  return { ctx, state, dispatches, commitLog }
}

/* ---------- [F2-1] restore twin guard ---------- */

test('[F2-1] restore cancels with REPEAT_TWIN_EXISTS when a live sibling occupies the same rid+day', async () => {
  const state = { todo: { todoList: [], recycleList: [recycledRow()] } }
  const { ctx, dispatches } = makeCtx({
    state,
    dbCall: async (op, params) => op === 'queryTodos' && params && params.deleted === 0
      ? [{ taskId: 'twin', repeatId: 'r1', dayStart: 20261017 }] // a LIVE sibling on the same day
      : null
  })
  await assert.rejects(
    () => todo.actions.restoreFromRecycle.call({ state }, ctx, { taskId: 't1', repeatId: 'r1' }),
    e => e.code === 'REPEAT_TWIN_EXISTS',
    'the restore is refused BEFORE any write, not rejected by the UNIQUE index mid-write'
  )
  assert.equal(dispatches.length, 0, 'cancel = no updateTodoFields dispatch at all')
})

test('[F2-1] no live sibling → restore proceeds (unchanged happy path)', async () => {
  const state = { todo: { todoList: [], recycleList: [recycledRow()] } }
  const { ctx, dispatches } = makeCtx({
    state,
    dbCall: async (op, params) => op === 'queryTodos' && params && params.deleted === 0 ? [] : null
  })
  const r = await todo.actions.restoreFromRecycle.call({ state }, ctx, { taskId: 't1', repeatId: 'r1' })
  assert.ok(dispatches.some(([a]) => a === 'updateTodoFields'), 'the restore write went through')
  assert.equal(r && r.code, undefined)
})

test('[F2-1] a failed twin-query read does not block the restore (UNIQUE index backstops)', async () => {
  const state = { todo: { todoList: [], recycleList: [recycledRow()] } }
  const { ctx, dispatches } = makeCtx({
    state,
    dbCall: async (op, params) => {
      if (op === 'queryTodos') throw new Error('ipc down')
      return null
    }
  })
  const r = await todo.actions.restoreFromRecycle.call({ state }, ctx, { taskId: 't1', repeatId: 'r1' })
  assert.ok(dispatches.some(([a]) => a === 'updateTodoFields'), 'the read failure degraded to restore-anyway')
  assert.equal(r && r.code, undefined)
})

/* ---------- [F2-2] renewal dedupe includes the recycle bin ---------- */

test('[F2-2] addTodo renewal: a binned twin on the same rid+day skips generation (returns null)', async () => {
  const state = { todoList: [], recycleList: [] }
  const { ctx } = makeCtx({
    state,
    dbCall: async (op, params) => (op === 'queryTodos' && params && params.deleted === 1)
      ? [{ taskId: 'binned1', repeatId: 'r1', dayStart: 20261018 }]
      : []
  })
  const r = await todo.actions.addTodo.call({ state }, ctx, {
    todoContent: 'renewal target', repeatId: 'r1', dayOverride: 20261018
  })
  assert.equal(r, null, 'red before the fix: the renewal re-minted the day the user had deleted')
})

test('[F2-2] addTodo renewal: a LIVE twin is still returned as the idempotent existing row', async () => {
  const state = { todoList: [], recycleList: [] }
  const existing = { taskId: 'live1', repeatId: 'r1', dayStart: 20261018 }
  const { ctx } = makeCtx({
    state,
    dbCall: async (op, params) => (op === 'queryTodos' && params && params.deleted === 0) ? [existing] : []
  })
  const r = await todo.actions.addTodo.call({ state }, ctx, {
    todoContent: 'renewal target', repeatId: 'r1', dayOverride: 20261018
  })
  assert.equal(r && r.taskId, 'live1', 'the unchanged live-twin contract holds')
})

/* ---------- [F2-4] post-restore dependency-cycle re-validation ---------- */

function cycleState (xPreds) {
  return { todo: {
    todoList: [{ taskId: 'x', taskContent: 'x', delete: false, predecessors: xPreds, complete: false }],
    recycleList: [recycledRow({ repeatId: null, predecessors: '["x"]', dayStart: 0 })]
  } }
}

test('[F2-4] restoring a row whose predecessors now close a cycle strips them (restore kept)', async () => {
  const state = cycleState('["t1"]') // x → t1 → x: a live cycle only after the restore
  const { ctx, dispatches } = makeCtx({ state, baseRow: recycledRow({ delete: false, predecessors: '["x"]' }) })
  const r = await todo.actions.restoreFromRecycle.call({ state }, ctx, { taskId: 't1' })
  const strip = dispatches.filter(([a, p]) => a === 'updateTodoFields' && p.patch && 'predecessors' in p.patch && p.patch.predecessors === null)
  assert.equal(strip.length, 1, 'red before the fix: the restored row shipped a live cycle the write-time guard would have rejected')
  assert.equal(r && r._depCycleStripped, true, 'the result flags the strip so views can warn')
})

test('[F2-4] an acyclic restored dependency set is left untouched', async () => {
  const state = cycleState('["other"]') // x depends on an unrelated task: no cycle
  const { ctx, dispatches } = makeCtx({ state, baseRow: recycledRow({ delete: false, predecessors: '["x"]' }) })
  const r = await todo.actions.restoreFromRecycle.call({ state }, ctx, { taskId: 't1' })
  assert.equal(dispatches.filter(([a, p]) => a === 'updateTodoFields' && p.patch && p.patch.predecessors === null).length, 0)
  assert.equal(r && r._depCycleStripped, undefined)
})
