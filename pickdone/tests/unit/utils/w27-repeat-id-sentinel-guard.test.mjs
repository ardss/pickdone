/**
 * [w27 P3 2026-11-01] legacy repeatId==='null' string sentinel must NOT count as a repeat task.
 *
 * Live finding: toggleCompleteWithUndo's undo path guarded the renewed-instance removal with a
 * bare truthy `cur.repeatId` check. Plain tasks upgraded from an old build carry the string
 * sentinel 'null'; undoing such a task's completion dispatched removeRenewedInstance, which (for
 * a multi-day plain task with other same-dayStart rows) could soft-delete a phantom "renewed
 * instance" and cascade its plan chips away. Fix: use the shared isRepeatTask() predicate at the
 * completeAction entry, plus the same-sentinel guard inside repeatUndo.js (defense in depth).
 *
 * Run: node --test tests/unit/utils/w27-repeat-id-sentinel-guard.test.mjs
 */
import '../../setup.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let cleanupGlobals = () => {}
let toggleCompleteWithUndo
let removeRenewedInstance

before(async () => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const Vue = require('vue')
  w.Vue = Vue // showUndoToast needs window.Vue.h
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({ window: w, document: w.document, navigator: w.navigator })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
  ;({ toggleCompleteWithUndo } = await import('../../../renderer/js/utils/completeAction.js'))
  ;({ removeRenewedInstance } = await import('../../../renderer/js/utils/repeatUndo.js'))
})
after(() => { cleanupGlobals() })

function makeStore () {
  const undone = {
    taskId: 'plain', taskContent: '普通任务', complete: true, completedAt: 999,
    repeatId: 'null', dayStart: 20261101, delete: false, subtasks: '[]'
  }
  // A sibling row sharing the rid string: pre-fix, the sentinel path grouped these as a
  // "repeat group" and could soft-delete one as the "renewed instance".
  const sibling = {
    taskId: 'plain-b', taskContent: '普通任务B', complete: false, completedAt: 0,
    repeatId: 'null', dayStart: 20261102, delete: false, subtasks: '[]'
  }
  const state = { todo: { todoList: [undone, sibling], recycleList: [] } }
  const calls = { upsertLocal: [], computeViews: 0 }
  const store = {
    state,
    commit (type, payload) { if (type === 'upsertLocal') calls.upsertLocal.push(payload) },
    dispatch (type, payload) {
      if (type === 'todo/toggleComplete') {
        payload.complete = !payload.complete
        payload.completedAt = payload.complete ? 1000 : 0
        return Promise.resolve(payload)
      }
      if (type === 'todo/updateTodoFields') return Promise.resolve(payload)
      if (type === 'computeViews' || type === 'writeCriticalBackup') calls.computeViews++
      return Promise.resolve(null)
    }
  }
  const noopHelpers = { safeUpsert: () => {}, snapshotForDelete: async () => {} }
  return { undone, sibling, state, store, calls, noopHelpers }
}

const messageStub = () => {
  const toasts = []
  const fn = (opt) => { toasts.push(opt) }
  fn.closeAll = () => {}
  return fn
}

test('w27: undo of a repeatId==="null" plain task must NOT removeRenewedInstance (completeAction entry)', async () => {
  const { undone, sibling, store, calls } = makeStore()
  const p = toggleCompleteWithUndo({ store, message: messageStub(), todo: undone })
  await p
  // The completion itself must not touch the sentinel-carrying sibling.
  assert.equal(sibling.delete || false, false, 'sibling must stay untouched by the completion itself')
  assert.equal(calls.upsertLocal.length, 0, 'no soft-delete commit fired during complete/undo setup')
})

test('w27: removeRenewedInstance with the legacy "null" sentinel is a no-op (defense in depth)', async () => {
  const { undone, sibling, state, store, calls, noopHelpers } = makeStore()
  await removeRenewedInstance({ todo: undone, state: state.todo, commit: store.commit, dispatch: store.dispatch, ...noopHelpers })
  assert.equal(calls.upsertLocal.length, 0, 'sentinel rid must not enter the renewed-instance removal')
  assert.equal(sibling.delete || false, false, 'sibling must not be soft-deleted')
  assert.equal(calls.computeViews, 0, 'no view recompute for a no-op removal')
})

test('w27: a REAL repeatId still goes through removeRenewedInstance (no over-correction)', async () => {
  const { undone, sibling, state, store, calls, noopHelpers } = makeStore()
  undone.repeatId = 'rep1'
  undone.dayStart = 20261101
  undone.complete = true
  undone.completedAt = 1000
  sibling.repeatId = 'rep1'
  sibling.dayStart = 20261102 // nearest LATER dayStart + last live instance = the renewed next
  sibling.createTime = 2000 // minted at completion time (renewal discriminator)
  await removeRenewedInstance({ todo: undone, state: state.todo, commit: store.commit, dispatch: store.dispatch, ...noopHelpers })
  const softDeleted = calls.upsertLocal.find(r => r.taskId === 'plain-b')
  assert.ok(softDeleted, 'a genuine repeat group still removes the renewed instance')
  assert.equal(softDeleted && softDeleted.delete, true)
})
