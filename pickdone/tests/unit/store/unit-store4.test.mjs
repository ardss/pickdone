/** Additional store unit tests - todo cloud-sync snapshot semantics, event backup contents, habits check-in day decision.
 *  Assertion discipline: verify contract values (version numbers, status transitions, snapshot JSON contents); no tautological assertions.
 *  Run: npm test */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import todo from '../../../renderer/js/store/todo.js'
import { isDueOn } from '../../../renderer/js/store/habits.js'

/** Builds a fake action context: records commit/dispatch calls */
function makeCtx (state, rootState = {}) {
  const calls = { commits: [], dispatches: [] }
  return {
    calls,
    state,
    rootState,
    commit: (t, p) => calls.commits.push([t, p]),
    dispatch: async (t, p) => { calls.dispatches.push([t, p]); return null },
    rootGetters: {}
  }
}

const ROOT = { settings: { backupDir: '' }, auth: { user: { userId: 1 } }, category: { list: [] }, habits: { habits: [], moments: [], savedAt: 0 } }

test('todo: syncTodos - version written to meta, rows marked synced, rows edited during the await are not wrongly marked', async () => {
  const rows = [
    { taskId: 'a', taskContent: 'A', delete: false, complete: false, updateTime: 1, status: 'add', version: 0, syncTime: 0 },
    { taskId: 'b', taskContent: 'B', delete: false, complete: false, updateTime: 1, status: 'add', version: 0, syncTime: 0 }
  ]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  const saved = []
  const metas = []
  globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
    dbCall: async (op, p) => {
      if (op === 'upsertMany') {
        saved.push(...p)
        // Simulate the user editing a again during the await: the row's status flips back to update (the core scenario named in the todo.js:516 comment)
        rows[0].status = 'update'
        return true
      }
      if (op === 'getMeta') return '0'
      if (op === 'setMeta') { metas.push(p); return true }
      return null
    },
    writeCriticalStateBackup: async () => true
  })
  const ctx = makeCtx(state, ROOT)
  await todo.actions.syncTodos.call(todo, ctx)
  assert.equal(saved.length, 2) // both rows in the snapshot are persisted
  const meta = metas.find(m => m[0] === 'todosVersion')
  assert.equal(meta[1], String(state.version)) // version contract: the post-bumpVersion value is written to meta
  assert.equal(rows[0].status, 'update') // edited during the await -> must not be marked synced (prevents clobbering the user's newer edit)
  assert.equal(rows[1].status, 'sync')   // not re-edited -> marked synced
  assert.equal(rows[1].version, state.version)
  assert.equal(state.isSyncing, false) // reset in finally; the exception path must not wedge it
  assert.ok(ctx.calls.dispatches.some(([t]) => t === 'writeCriticalBackup')) // a debounced backup must trigger after sync
})

test('todo: writeEventBackup - snapshot JSON contains task data, tag lowercased, retention policy', async () => {
  const calls = []
  globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
    runAutoBackup: async (json, opts) => { calls.push([json, opts]); return { ok: true, file: 'x' } }
  })
  const ctx = makeCtx(
    { todoList: [{ taskId: 'a', taskContent: '快照任务' }], recycleList: [], search: 'kw', version: 7 },
    ROOT
  )
  await todo.actions.writeEventBackup.call(todo, ctx, 'PURGE') // an uppercase reason must also be normalized
  assert.equal(calls.length, 1)
  const [json, opts] = calls[0]
  const dump = JSON.parse(json)
  const todoState = JSON.parse(dump.backup.todoState)
  assert.ok(todoState.todoList.some(t => t.taskId === 'a'), 'the snapshot must contain the task data')
  assert.equal(todoState.search, 'kw')
  assert.equal(JSON.parse(dump.backup.settingsState).backupDir, '')
  assert.equal(opts.tag, 'purge') // the reason is lowercased; the evt filename depends on this convention
  assert.equal(opts.eventKeep, 10)
})

test('habits: isDueOn across the three frequencies', () => {
  // weekly: weekdays are mon0-based (0=Monday); 2026-08-31 is a Monday
  const hWeek = { frequency: { type: 'weekdays', weekdays: [0] }, createdAt: Date.now() }
  assert.equal(isDueOn(hWeek, '2026-08-31'), true)
  assert.equal(isDueOn(hWeek, '2026-09-01'), false)
  // interval: every N days, counted from the creation day (day 0)
  const created = new Date(); created.setHours(12, 0, 0, 0)
  const hInt = { frequency: { type: 'interval', intervalN: 2 }, createdAt: created.getTime() }
  const keyOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  assert.equal(isDueOn(hInt, keyOf(created)), true)
  assert.equal(isDueOn(hInt, keyOf(new Date(created.getTime() + 86400000))), false)
  assert.equal(isDueOn(hInt, keyOf(new Date(created.getTime() + 2 * 86400000))), true)
  assert.equal(isDueOn({ frequency: { type: 'daily' } }, '2026-08-30'), true)
})
