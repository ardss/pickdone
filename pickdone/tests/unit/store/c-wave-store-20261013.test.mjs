/**
 * Agent F2 (renderer store/undo domain) — regression tests for the 2026-10-13 fix wave.
 *   C1 undoLink: the undo toast link is keyboard-reachable (role/tabindex + Enter/Space keydown)
 *   C2 moveWithUndo/batchMoveWithUndo close only their OWN toast (closeAll killed concurrent toasts)
 *   C3 deleteTodo: chip snapshot BEFORE the row upsert (deleteTodosMany's crash-safe order)
 *   C4 persistSnapshotDiffCore upsert arm strips the local `deleting` flag (no spread via undo snapshots)
 *   C5 a FAILED repeatRule meta read ≠ "rule absent": repeatId is NOT stripped, renewal skipped one round
 *   C6 addTodo with todoTime only: taskSort comes from the effective-day pool, not the no-date pool
 * Run: node --test tests/unit/store/c-wave-store-20261013.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const confirmMod = await import('../../../renderer/js/utils/confirm.js')
const todoMod = await import('../../../renderer/js/store/todo.js')
const { persistSnapshotDiffCore } = await import('../../../renderer/js/store/helpers/undo.js')

const LS = globalThis.localStorage
// undoToast owns a real 5s dismiss timer per toast; cap every timeout at 20ms (h7 precedent)
// so leaked/armed timers die instantly instead of keeping handles alive under --test-force-exit
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, 20))
const clearLS = () => { for (let i = LS.length - 1; i >= 0; i--) LS.removeItem(LS.key(i)) }

/* -------- tiny Vue.h mock: (tag, props, children) => vnode record -------- */
const h = (tag, props, children) => ({ tag, props, children })

/* ---------------- C1: keyboard-reachable undo link ---------------- */
const { undoLink } = confirmMod

test('C1: undoLink renders role/tabindex and fires on Enter/Space keydown', () => {
  let clicks = 0
  const vnode = undoLink(h, 'Undo', () => { clicks++ })
  assert.equal(vnode.tag, 'a')
  assert.equal(vnode.props.role, 'button', 'must expose role=button')
  assert.ok(vnode.props.tabindex !== undefined, 'must expose tabindex (focusable)')
  assert.equal(typeof vnode.props.onClick, 'function')
  assert.equal(typeof vnode.props.onKeydown, 'function')
  vnode.props.onClick({}) // mouse path still works
  assert.equal(clicks, 1)
  vnode.props.onKeydown({ key: 'Enter', preventDefault () {} })
  vnode.props.onKeydown({ key: ' ', preventDefault () {} })
  assert.equal(clicks, 3, 'Enter and Space both activate the link')
  vnode.props.onKeydown({ key: 'Escape', preventDefault () {} })
  assert.equal(clicks, 3, 'other keys must not activate')
})

/* ---------------- C2: undo click closes only its own toast ---------------- */
const { moveWithUndo, batchMoveWithUndo } = confirmMod

/** Build a vm whose $message returns a fresh fake msg per call, with per-call close spies.
 *  closeAll throwing = the old closeAll() regression (killed concurrent toasts) would fail loudly. */
function makeSpyVm () {
  const msgs = []
  const vm = {
    $message: Object.assign(() => {
      const msg = { closeCount: 0, close () { this.closeCount++ } }
      msgs.push(msg)
      return msg
    }, { closeAll: () => { throw new Error('closeAll regression: killed concurrent undo toasts') } })
  }
  return { vm, msgs }
}
/** Run fn with a capturing globalThis.window.Vue.h; return the undo links (role=button vnodes) it rendered. */
function captureUndoLinks (fn) {
  const captured = []
  const savedVue = globalThis.globalThis.window.Vue
  globalThis.globalThis.window.Vue = { h: (tag, props, children) => { captured.push({ tag, props, children }); return { tag, props, children } } }
  try { fn() } finally { globalThis.globalThis.window.Vue = savedVue }
  // h('span', children) overload: children may arrive in the props slot
  return captured.flatMap(c => (c.children !== undefined ? c.children : c.props))
    .filter(ch => ch && ch.props && ch.props.role === 'button')
}

test('C2a: moveWithUndo undo closes only its own toast (concurrent toast survives)', () => {
  const { vm, msgs } = makeSpyVm()
  const reverted = []
  const links1 = captureUndoLinks(() => moveWithUndo(vm, { label: 'A', apply: () => {}, revert: () => reverted.push('a') }))
  const links2 = captureUndoLinks(() => moveWithUndo(vm, { label: 'B', apply: () => {}, revert: () => reverted.push('b') }))
  assert.equal(links1.length, 1)
  assert.equal(links2.length, 1)
  links1[0].props.onClick({}) // undo toast A
  assert.deepEqual(reverted, ['a'], 'the revert applied')
  assert.equal(msgs[0].closeCount, 1, 'toast A closed exactly once — its own close')
  assert.equal(msgs[1].closeCount, 0, 'concurrent toast B must survive')
  links2[0].props.onClick({})
  assert.equal(msgs[1].closeCount, 1)
  // close both toasts: showUndoToast owns a 5s auto-dismiss timer per toast — leaving them
  // armed leaks handles and, under --test-force-exit, blames the next pending test
  msgs.forEach(m => m.close())
})

test('C2b: batchMoveWithUndo undo closes only its own toast', () => {
  const { vm, msgs } = makeSpyVm()
  const links1 = captureUndoLinks(() => batchMoveWithUndo(vm, { label: 'M1', snap: [{ taskId: 'a' }, { taskId: 'b' }], revertOf: () => {} }))
  const links2 = captureUndoLinks(() => batchMoveWithUndo(vm, { label: 'M2', snap: [{ taskId: 'c' }], revertOf: () => {} }))
  assert.equal(links1.length, 1)
  links1[0].props.onClick({})
  assert.equal(msgs[0].closeCount, 1, 'first toast closed by its own undo')
  assert.equal(msgs[1].closeCount, 0, 'the concurrent second toast must survive')
  links2[0].props.onClick({})
  assert.equal(msgs[1].closeCount, 1)
  msgs.forEach(m => m.close()) // clear the owned 5s timers (see C2a)
})

/* ---------------- C3: deleteTodo snapshot order ---------------- */
const todo = todoMod.default

function makeTodoCtx (state, { dbOps } = {}) {
  const dispatched = []
  const ops = []
  globalThis.window.todoAPI = globalThis.window.todoAPI || {}
  const oldCall = globalThis.window.todoAPI.dbCall
  // full-suite runs share one process: an earlier file may have left a window.commands bridge
  // behind, which would divert commandBus away from dbCall — force the dbCall door for this test
  const oldCommands = globalThis.window.commands
  delete globalThis.window.commands
  globalThis.window.todoAPI.dbCall = (op, params) => {
    ops.push(op)
    return Promise.resolve(dbOps && dbOps[op] ? dbOps[op](params) : null)
  }
  const ctx = {
    state,
    rootState: { settings: {}, auth: { user: { userId: 42 } }, tomato: {} },
    commit: (m, p) => { if (todo.mutations[m]) todo.mutations[m](state, p) },
    dispatch: (path) => { dispatched.push(path); return Promise.resolve() }
  }
  const restore = () => { globalThis.window.todoAPI.dbCall = oldCall; globalThis.window.commands = oldCommands }
  return { ctx, dispatched, ops, restore }
}

test('C3: deleteTodo snapshots chips BEFORE the row upsert (crash-safe order, no ghost chips)', async () => {
  clearLS()
  const state = { todoList: [{ taskId: 9, taskContent: 'T', delete: false, updateTime: 1, version: 1 }], recycleList: [] }
  const { ctx, ops, restore } = makeTodoCtx(state, {
    dbOps: { getById: () => ({ taskId: 9, taskContent: 'T', delete: false, updateTime: 1, version: 1 }), planAll: () => [{ id: 'c1', taskId: 9, day: '2026-10-13', mm: 540 }] }
  })
  try {
    const self = { state: { todo: state } }
    await todo.actions.deleteTodo.call(self, ctx, { taskId: 9 })
    const iSnap = ops.indexOf('setMeta') // planChipsSnapshot:<id> meta put
    const iPut = ops.indexOf('upsert') // safeUpsert row write
    assert.ok(iSnap >= 0, 'chip snapshot meta put must happen')
    assert.ok(iPut >= 0, 'row upsert must happen')
    assert.ok(iSnap < iPut, `snapshot (setMeta@${iSnap}) must land BEFORE the row upsert (upsert@${iPut}) — row-first order produced ghost chips on crash`)
  } finally { restore() }
})

/* ---------------- C4: deleting flag stripped at the snapshot-replay choke point ---------------- */

test('C4: undo snapshot replay does not write `deleting` back to memory or the durable store', async () => {
  clearLS()
  const state = { todoList: [], recycleList: [] }
  const commit = (m, p) => { if (todo.mutations[m]) todo.mutations[m](state, p) }
  const upserted = []
  const safeUpsert = row => upserted.push(row)
  globalThis.globalThis.window.todoAPI = globalThis.globalThis.window.todoAPI || {}
  const oldCall = globalThis.globalThis.window.todoAPI.dbCall
  globalThis.globalThis.window.todoAPI.dbCall = () => Promise.resolve([{ taskId: 'x' }]) // durable-existence read: row exists
  try {
    const from = { todoList: [{ taskId: 'x', taskContent: 'k', updateTime: 1, deleting: false }], recycleList: [] }
    const to = { todoList: [{ taskId: 'x', taskContent: 'k', updateTime: 2, deleting: true }], recycleList: [] }
    const changed = await persistSnapshotDiffCore({ commit }, { from, to }, safeUpsert)
    assert.equal(changed.length, 1)
    assert.ok(!('deleting' in upserted[0]), 'durable write must NOT carry the deleting UI flag (pre-fix it spread forever via undo snapshots)')
    assert.ok(!('deleting' in state.todoList[0]), 'in-memory restored row must not carry deleting either')
  } finally { globalThis.globalThis.window.todoAPI.dbCall = oldCall }
})

/* ---------------- C5: failed repeatRule read ≠ rule absent ---------------- */
test('C5a: restoreFromRecycle keeps repeatId when the repeatRule meta read THROWS (no chain severing)', async () => {
  clearLS()
  const state = { todoList: [], recycleList: [] }
  const dispatched = []
  const ctx = {
    state, commit: () => {},
    dispatch: async (path, payload) => {
      dispatched.push({ path, payload })
      if (path === 'updateTodoFields') return { taskId: payload.taskId, ...payload.patch }
      return null
    }
  }
  globalThis.globalThis.window.todoAPI = globalThis.globalThis.window.todoAPI || {}
  const oldCall = globalThis.globalThis.window.todoAPI.dbCall
  globalThis.globalThis.window.todoAPI.dbCall = (op, params) => {
    if (op === 'getMeta' && String(params).startsWith('repeatRule:')) return Promise.reject(new Error('ipc jitter'))
    return Promise.resolve(null) // planChipsSnapshot: absent → restoreSnapshot no-op
  }
  try {
    await todo.actions.restoreFromRecycle.call({ state: { todo: state } }, ctx, { taskId: 5, repeatId: 'r1' })
    const strip = dispatched.find(d => d.path === 'updateTodoFields' && d.payload && d.payload.patch && d.payload.patch.repeatId === null)
    assert.ok(!strip, 'a FAILED rule read must not strip repeatId (pre-fix an IPC jitter severed the renewal chain)')
  } finally { globalThis.globalThis.window.todoAPI.dbCall = oldCall }
})

test('C5a2: rule truly absent (null meta) still strips the dangling repeatId (B5 guard intact)', async () => {
  clearLS()
  const state = { todoList: [], recycleList: [] }
  const dispatched = []
  const ctx = {
    state, commit: () => {},
    dispatch: async (path, payload) => { dispatched.push({ path, payload }); return { taskId: payload && payload.taskId } }
  }
  globalThis.globalThis.window.todoAPI = globalThis.globalThis.window.todoAPI || {}
  const oldCall = globalThis.globalThis.window.todoAPI.dbCall
  globalThis.globalThis.window.todoAPI.dbCall = () => Promise.resolve(null) // getMeta → null: rule really GCed
  try {
    await todo.actions.restoreFromRecycle.call({ state: { todo: state } }, ctx, { taskId: 5, repeatId: 'r1' })
    const strip = dispatched.find(d => d.path === 'updateTodoFields' && d.payload && d.payload.patch && d.payload.patch.repeatId === null)
    assert.ok(strip, 'the dangling-repeatId guard must still fire on a real null meta')
  } finally { globalThis.globalThis.window.todoAPI.dbCall = oldCall }
})

test('C5b: ensureNextRepeatInstance skips the round (no addTodo) when the rule read throws', async () => {
  clearLS()
  const day = 1736380800000 // some dayStart
  const fakeStore = { state: { todo: { todoList: [{ taskId: 1, repeatId: 'r9', delete: false, dayStart: day, complete: true }], holidayList: [] } } }
  const dispatched = []
  const ctx = { dispatch: async (path) => { dispatched.push(path); return null } }
  globalThis.globalThis.window.todoAPI = globalThis.globalThis.window.todoAPI || {}
  const oldCall = globalThis.globalThis.window.todoAPI.dbCall
  globalThis.globalThis.window.todoAPI.dbCall = () => Promise.reject(new Error('ipc jitter'))
  try {
    await todo.actions.ensureNextRepeatInstance.call(fakeStore, ctx, { repeatId: 'r9', taskId: 1, dayStart: day })
    assert.ok(!dispatched.includes('addTodo'), 'a failed rule read skips renewal for this round instead of renewing with a broken rule')
  } finally { globalThis.globalThis.window.todoAPI.dbCall = oldCall }
})

/* ---------------- C6: todoTime-only add sorts into the effective-day pool ---------------- */
test('C6: addTodo with only todoTime takes taskSort from the todoTime-derived day pool', async () => {
  clearLS()
  const dayTs = 1760284800000 // 2025-10-13 00:00 local
  const withinDay = dayTs + 3600 * 1000 * 14
  const state = {
    todoList: [
      { taskId: 'd1', delete: false, dayStart: dayTs, taskSort: 1000 }, // the target day pool
      { taskId: 'n1', delete: false, dayStart: 0, taskSort: 5000 } // the no-date pool
    ],
    recycleList: []
  }
  const { ctx, restore } = makeTodoCtx(state)
  try {
    const t = await todo.actions.addTodo.call({ state: { todo: state } }, ctx, { todoContent: 'tb', todoDate: 0, todoTime: withinDay, todoSublist: null, todoImage: null, fileList: null })
    assert.equal(t.dayStart, dayTs, 'row lands in the todoTime-derived day group')
    assert.ok(t.taskSort > 1000 && t.taskSort < 2000, `taskSort (${t.taskSort}) must come from the target day pool (1000±jitter/step), not the no-date pool (5000)`)
    // and a true no-date add still uses the no-date pool
    const t2 = await todo.actions.addTodo.call({ state: { todo: state } }, ctx, { todoContent: 'nd', todoDate: 0, todoTime: 0, todoSublist: null, todoImage: null, fileList: null })
    assert.equal(t2.dayStart, 0)
    assert.ok(t2.taskSort > 4800, `no-date add (${t2.taskSort}) must use the no-date pool`)
  } finally { restore() }
})
