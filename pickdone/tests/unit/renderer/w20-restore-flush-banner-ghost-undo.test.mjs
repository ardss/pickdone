/**
 * w20 P2 batch — executing regression tests:
 *
 * #1 EditPanel.restoreFromBin used `_save.clearTimer()` before takeDirty — that only cancelled
 *    the 350ms debounce; queueSave's immediate `setPending` slot stayed unconsumed, so an edit
 *    made <350ms before "恢复" was silently dropped (H1 caliber). Fix: await flushSave().
 *    → behavior: flushSave consumes the pending immediate patch; anchor: restoreFromBin flushes.
 * #2 editSave.queueSave's multi-task branch called opts.onDone() unconditionally after a
 *    per-entry failure — the onFail banner was lit and extinguished in the same tick while the
 *    writes were only requeued. Fix: onDone fires only when failedEntries is empty.
 * #3 completeAction's undo dispatched only updateTodoFields{complete:false}, bypassing
 *    toggleComplete's `!target` removeRenewedInstance recycle — undoing a completed repeat task
 *    left the renewed "下一次" instance on the calendar forever. Fix: the undo's success path
 *    mirrors the store's cleanup via removeRenewedInstance.
 * Run: node --test tests/unit/renderer/w20-restore-flush-banner-ghost-undo.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

function stubStorage () {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: k => { map.delete(k) },
    key: i => [...map.keys()][i] ?? null,
    get length () { return map.size }
  }
}

test('#1 flushSave consumes the pending immediate patch (the restoreFromBin contract)', async () => {
  const { createSaveQueue } = await import(url('renderer/js/utils/editSave.js?w20a=' + Math.random()))
  const dispatched = []
  const store = { dispatch: (op, { taskId, patch }) => { dispatched.push({ taskId, patch }); return Promise.resolve() } }
  const q = createSaveQueue(store, { getTaskId: () => 't1', debounceMs: 100 })
  q.boot()
  q.queueSave({ title: 'typed then restore clicked' }) // lands in the immediate slot, timer armed
  await q.flushSave() // what restoreFromBin now awaits before takeDirty
  assert.ok(dispatched.some(d => d.taskId === 't1' && d.patch.title === 'typed then restore clicked'),
    'the <350ms immediate edit is persisted by the flush instead of being dropped')
})

test('#1 anchor: restoreFromBin awaits flushSave and no longer just clearTimer', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/async restoreFromBin \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'restoreFromBin block found')
  assert.ok(/await this\._save\.flushSave\(\)/.test(m[0]), 'restoreFromBin flushes (consuming the immediate slot) before takeDirty')
  assert.ok(!/this\._save\.clearTimer\(\)/.test(m[0]), 'the discard-only clearTimer is gone from restoreFromBin')
})

test('#2 multi-task queueSave failure lights onFail and does NOT fire onDone', async () => {
  const { createSaveQueue } = await import(url('renderer/js/utils/editSave.js?w20b=' + Math.random()))
  // Task switches inside the debounce window → the per-entry multi-task branch; "a"'s dispatch fails
  let cur = 'a'
  const store = { dispatch: (op, { taskId }) => taskId === 'a' ? Promise.reject(new Error('db busy')) : Promise.resolve() }
  let done = 0; let fail = 0
  const q = createSaveQueue(store, { getTaskId: () => cur, debounceMs: 30, onDone: () => done++, onFail: () => fail++ })
  q.queueSave({ title: 'x' }) // enqueue-time task "a"
  cur = 'b'
  await tick(80)
  assert.equal(fail, 1, 'the failure banner fires')
  assert.equal(done, 0, 'onDone is suppressed in the same tick — no fake "saved"')
})

test('#2 multi-task queueSave success still fires onDone exactly once', async () => {
  const { createSaveQueue } = await import(url('renderer/js/utils/editSave.js?w20c=' + Math.random()))
  const dispatched = []
  const store = { dispatch: (op, { taskId, patch }) => { dispatched.push({ taskId, patch }); return Promise.resolve() } }
  let cur = 'a'
  let done = 0; let fail = 0
  // Task switches inside the debounce window → the per-entry multi-task branch runs
  const q = createSaveQueue(store, { getTaskId: () => cur, debounceMs: 30, onDone: () => done++, onFail: () => fail++ })
  q.queueSave({ title: 'x' }) // enqueue-time task "a"
  cur = 'b'
  await tick(80)
  assert.equal(done, 1, 'the success path keeps its single onDone')
  assert.equal(fail, 0, 'no failure banner on success')
  assert.ok(dispatched.some(d => d.taskId === 'a' && d.patch.title === 'x'), 'the queued patch is dispatched to its enqueue-time task')
})

test('#2 same-task dispatch failure goes to the outer catch: onFail without onDone', async () => {
  const { createSaveQueue } = await import(url('renderer/js/utils/editSave.js?w20d=' + Math.random()))
  const store = { dispatch: () => Promise.reject(new Error('db busy')) }
  let done = 0; let fail = 0
  const q = createSaveQueue(store, { getTaskId: () => 't1', debounceMs: 5, onDone: () => done++, onFail: () => fail++ })
  q.queueSave({ title: 'x' })
  await tick(60)
  assert.equal(fail, 1, 'failure surfaces via onFail')
  assert.equal(done, 0, 'a failed sameTask write never reports success')
})

test('#3 undo of a completed repeat task removes the renewed next instance', async () => {
  globalThis.localStorage = stubStorage()
  globalThis.window.Vue = { h: (tag, x) => ({ tag, x }) }
  try {
    const { toggleCompleteWithUndo } = await import(url('renderer/js/utils/completeAction.js?w20=' + Math.random()))
    const cur = { taskId: 't1', taskContent: 'R', repeatId: 'r1', complete: true, dayStart: 20261030, subtasks: '[]' }
    const renewed = { taskId: 't2', taskContent: 'R', repeatId: 'r1', complete: false, dayStart: 20261106 }
    const store = {
      state: { todo: { todoList: [cur, renewed], recycleList: [] } },
      dispatch: () => Promise.resolve(),
      commit: (op, row) => { store.state.todo.todoList = store.state.todo.todoList.map(t => t.taskId === row.taskId ? row : t) }
    }
    const toasts = []
    const message = m => toasts.push(m)
    message.closeAll = () => {}
    toggleCompleteWithUndo({ store, message, todo: cur, announce: () => {} })
    // Extract the undo callback the same way showUndoToast receives it: the vnode child of the toast
    const toastArg = toasts[toasts.length - 1]
    const children = toastArg.message.x
    const undoVnode = children.find(c => c && c.tag === 'a')
    assert.ok(undoVnode, 'the toast carries the undo affordance')
    await undoVnode.x.onClick()
    const t2 = store.state.todo.todoList.find(t => t.taskId === 't2')
    assert.equal(t2.delete, true, 'the renewed "下一次" instance is soft-deleted by the undo (no ghost on the calendar)')
    assert.equal(t2.status, 'delete', 'the removal follows the deleteTodo row shape')
  } finally { delete globalThis.window.Vue }
})

test('#3 undo of a non-repeat task does not touch the group cleanup', async () => {
  globalThis.localStorage = stubStorage()
  globalThis.window.Vue = { h: (tag, x) => ({ tag, x }) }
  try {
    const { toggleCompleteWithUndo } = await import(url('renderer/js/utils/completeAction.js?w20b=' + Math.random()))
    const cur = { taskId: 't1', taskContent: 'A', complete: true, subtasks: '[]' }
    const dispatched = []
    const store = {
      state: { todo: { todoList: [cur], recycleList: [] } },
      dispatch: (op, p) => { dispatched.push({ op, p }); return Promise.resolve() },
      commit: () => {}
    }
    const toasts = []
    const message = m => toasts.push(m)
    message.closeAll = () => {}
    toggleCompleteWithUndo({ store, message, todo: cur, announce: () => {} })
    const children = toasts[toasts.length - 1].message.x
    await children.find(c => c && c.tag === 'a').x.onClick()
    assert.ok(dispatched.some(d => d.op === 'todo/updateTodoFields' && d.p.patch.complete === true), 'the completion revert still lands (snapshot reverts to pre-toggle complete=true)')
    assert.ok(!dispatched.some(d => d.op === 'computeViews'), 'no repeat-group view recompute for a non-repeat task')
  } finally { delete globalThis.window.Vue }
})
