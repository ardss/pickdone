/**
 * F2 round (2026-10-17) — CLI repeat-restore/renewal/focus fixes (renderer parity):
 *   [F2-1] `restore` refuses (REPEAT_TWIN_EXISTS) when the repeat group already has a LIVE
 *          instance on the same scheduled day — the restore write used to die on the
 *          idx_todos_repeat_day UNIQUE partial index with a bare stack.
 *   [F2-2] renewal dedupe includes the recycle bin: a soft-deleted instance on the SAME
 *          rid+day blocks the regeneration (both lib.js addTodo and lib-repeat.cjs
 *          renewRepeatAfterComplete — same caliber as the renderer pre-check).
 *   [F2-3] `delete` of a focus-bound task writes the tomato detach command (attach null)
 *          before the row lands in the recycle bin, so the completion record never books
 *          to a recycle-bin taskId (renderer twin: store/todo.js deleteTodo → tomato/attach null).
 * Run: node --test tests/unit/cli/f2-repeat-restore-twin.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-f2-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'f2 task', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------- [F2-1] restore twin guard ---------- */

test('f2: restore succeeds when no live sibling shares the rid+day (unchanged happy path)', () => {
  const D = +dayjs().add(1, 'day').startOf('day')
  const recycled = seed({ taskContent: 'f2 lone recycled', repeatId: 'r_f2a', todoTime: D, delete: true, deletedAt: Date.now(), status: 'delete', version: 0 })
  const restored = lib.restoreTodo(recycled.taskId)
  assert.equal(restored.delete, false, 'no twin → the restore goes through')
})

test('f2: restore refuses with REPEAT_TWIN_EXISTS when a live sibling occupies the same rid+day', () => {
  const D = +dayjs().add(2, 'day').startOf('day')
  const recycled = seed({ taskContent: 'f2 twin recycled', repeatId: 'r_f2b', todoTime: D, delete: true, deletedAt: Date.now(), status: 'delete', version: 0 })
  seed({ taskContent: 'f2 twin live', repeatId: 'r_f2b', todoTime: D }) // renewed while the other sat in the bin
  assert.throws(
    () => lib.restoreTodo(recycled.taskId),
    e => e.code === 'REPEAT_TWIN_EXISTS',
    'red before the fix: the restore write died on the idx_todos_repeat_day UNIQUE stack instead'
  )
  assert.equal(db.call('getById', recycled.taskId).delete, true, 'the refused row stays in the recycle bin')
})

/* ---------- [F2-2] renewal dedupe includes the recycle bin ---------- */

test('f2: completion renewal skips a day whose instance the user soft-deleted (renewRepeatAfterComplete)', () => {
  const base = +dayjs().add(3, 'day').startOf('day')
  const tpl = seed({ taskContent: 'f2 renew skip', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 1)
  const next = db.call('queryTodos', { deleted: 0, repeatId: r.rid }).find(x => x.dayStart > base)
  assert.ok(next, 'the expansion produced the next-day instance')
  // The user deletes that day's instance before completing the last live one
  db.call('upsert', { ...next, delete: true, deletedAt: Date.now(), status: 'delete', version: 0 })
  const res = lib.toggleComplete(tpl.taskId, true)
  assert.equal(res.renewed, null, 'red before the fix: the deleted:0 pre-check missed the binned twin and re-minted the day')
  const live = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  assert.ok(live.every(x => x.dayStart <= base), 'no new live instance appeared on the deliberately deleted day')
})

test('f2: lib.addTodo with a repeatId also skips a binned twin on the target day', () => {
  const D = +dayjs().add(5, 'day').startOf('day')
  seed({ taskContent: 'f2 add binned', repeatId: 'r_f2add', todoTime: D, delete: true, deletedAt: Date.now(), status: 'delete', version: 0 })
  const r = lib.addTodo({ content: 'f2 add probe', date: dayjs(D).format('YYYY-MM-DD'), repeatId: 'r_f2add' })
  assert.equal(r, null, 'red before the fix: the deleted:0 pre-check alone created a duplicate live instance')
})

/* ---------- [F2-3] delete detaches a focus-bound task ---------- */

test('f2: deleting a focus-bound task writes the tomato attach-null detach command', () => {
  const t = seed({ taskContent: 'f2 detach bound' })
  lib.commit('meta', 'put', ['tomatoRunningSession', JSON.stringify({
    status: 'startTomatoTime', startedAt: Date.now(), attachTaskId: t.taskId, tomatoTime: 25, restTime: 5, at: Date.now()
  })])
  lib.deleteTodo(t.taskId)
  const slot = JSON.parse(db.call('getMeta', 'cliTomatoCmd') || 'null')
  assert.ok(slot, 'red before the fix: the delete left the focus bound to a recycle-bin task')
  assert.equal(slot.action, 'attach')
  assert.equal(slot.taskId, null, 'attach null = the App-side tomato/attach(null) detach (renderer parity)')
  assert.equal(db.call('getById', t.taskId).delete, true, 'the delete itself still went through')
  lib.commit('meta', 'delete', 'cliTomatoCmd')
})

test('f2: deleting an unbound task writes no tomato command slot', () => {
  const t = seed({ taskContent: 'f2 detach free' })
  lib.deleteTodo(t.taskId)
  assert.equal(db.call('getMeta', 'cliTomatoCmd'), null, 'no phantom detach for an unbound delete')
})

test('f2: a STALE cliTomatoState receipt alone does not trigger the detach (session row wins)', () => {
  // No tomatoRunningSession row; a >15s-old receipt referencing the task must be ignored
  const t = seed({ taskContent: 'f2 detach stale receipt' })
  lib.commit('meta', 'put', ['cliTomatoState', JSON.stringify({
    seq: 1, status: 'startTomatoTime', startedAt: Date.now() - 600000,
    attach: { taskId: t.taskId, content: 'x' }, at: Date.now() - 60000, todayTomatoCount: 0
  })])
  lib.deleteTodo(t.taskId)
  const slot = db.call('getMeta', 'cliTomatoCmd')
  assert.equal(slot, null, 'a stale single-slot receipt must not trigger a phantom detach write')
  lib.commit('meta', 'delete', 'cliTomatoState')
})
