/**
 * [dw-wave6 domain-4] views & undo-state misc fixes — regression guards.
 *  F5  DayRail entry-card task candidates: dayStart/todoTime are ms-timestamps; comparing them
 *      against a 'YYYY-MM-DD' string was always false, so pure day-scheduled (no todoTime) tasks
 *      vanished from the entry-card dropdown.
 *  F1  RecycleBinView restore-to-today / pick-date restore: hard todoTime=day-00:00 (wiping a
 *      14:30 schedule) and never touching reminderTime — now via the shared crossDayMovePatch.
 *  F13 undo/redo parse guard: snapshots that PARSE but are shape-corrupt (`{}`) blew up in
 *      persistSnapshotDiffCore after the stack entry was already popped — the undo step was
 *      permanently lost. Now a single shared parseSnapshot (parse + shape) guard.
 * Run: node --test tests/unit/renderer/dw6-domain4-views-undo.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { crossDayMovePatch } from '../../../renderer/js/utils/crossDayMove.js'
import { dayStart } from '../../../renderer/js/utils/todayBounds.js'
import { undoStep, redoStep } from '../../../renderer/js/store/helpers/undo.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- F5: DayRail entry-card candidates in timestamp caliber ---------- */

/** Extract the taskOptions computed from the SFC and eval it as a plain function of `this` */
function loadTaskOptions () {
  const src = read('renderer/js/components/DayRail.vue')
  const start = src.indexOf('taskOptions () {')
  assert.ok(start >= 0, 'DayRail: taskOptions computed present')
  const end = src.indexOf('/* Fact layer', start)
  const chunk = src.slice(start, end).trim().replace(/,\s*$/, '')
  return new Function('dayjs', `const computed = { ${chunk} }; return computed.taskOptions`)(dayjs)
}

test('F5 taskOptions: pure day-scheduled task (no todoTime) is a candidate — dayStart ts caliber', () => {
  const taskOptions = loadTaskOptions()
  const day = +dayjs('2026-09-24').startOf('day')
  const ctx = {
    selDayStart: day,
    $store: { state: { todo: { todoList: [
      { id: 'pure', delete: false, dayStart: day }, // previously INVISIBLE: dayStart(ts) === today('YYYY-MM-DD') was always false
      { id: 'timed', delete: false, dayStart: day, todoTime: +dayjs('2026-09-24').hour(14).minute(30) },
      { id: 'otherDay', delete: false, dayStart: day + 86400000 },
      { id: 'deleted', delete: true, dayStart: day }
    ] } } }
  }
  const ids = taskOptions.call(ctx).map(t => t.id)
  assert.deepEqual(ids, ['pure', 'timed'], 'pure-day and timed tasks of the selected day are candidates, others are not')
})

test('F5 taskOptions: timed task whose todoTime falls on the selected day counts even with a stale dayStart', () => {
  const taskOptions = loadTaskOptions()
  const day = +dayjs('2026-09-24').startOf('day')
  const ctx = {
    selDayStart: day,
    $store: { state: { todo: { todoList: [
      { id: 'moved', delete: false, dayStart: day - 86400000, todoTime: +dayjs('2026-09-24').hour(9) }
    ] } } }
  }
  assert.deepEqual(taskOptions.call(ctx).map(t => t.id), ['moved'])
})

/* ---------- F1: RecycleBinView restore via the shared crossDayMovePatch ---------- */

test('F1 restore-to-today: a 14:30 schedule + reminder keep their time-of-day on today (shared patch rules)', () => {
  const today = dayStart(Date.now())
  const oldDay = today - 5 * 86400000
  const t = {
    taskId: 'x1',
    dayStart: oldDay,
    todoTime: oldDay + 14.5 * 3600000, // 14:30 on the old day
    reminderTime: oldDay + 8 * 3600000,
    reminderExtra: [oldDay + 9 * 3600000, oldDay + 3 * 86400000 + 18 * 3600000]
  }
  // exactly the composition RecycleBinView.restore(patchToToday) dispatches
  const patch = { delete: false, status: 'update', ...crossDayMovePatch(t, today, dayStart) }
  assert.equal(patch.dayStart, today)
  assert.equal(patch.todoTime, today + 14.5 * 3600000, 'schedule keeps 14:30 instead of being wiped to 00:00')
  assert.equal(patch.reminderTime, today + 8 * 3600000, 'reminder travels with the day, not orphaned')
  assert.deepEqual(patch.reminderExtra, [today + 9 * 3600000, oldDay + 3 * 86400000 + 18 * 3600000])
})

test('F1 RecycleBinView wiring: crossDayMovePatch in, hard day-00:00 writes out', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /import \{ crossDayMovePatch \} from '\.\.\/utils\/crossDayMove\.js'/)
  assert.match(src, /crossDayMovePatch\(t, today, dayStart\)/, 'restore-to-today uses the shared builder')
  assert.match(src, /crossDayMovePatch\(t, day, dayStart\)/, 'pick-date restore uses the shared builder')
  assert.ok(!/todoTime: today \}/.test(src), 'hard todoTime=today-00:00 wipe stays deleted')
  assert.ok(!/dayStart: day, todoTime: day \}/.test(src), 'hard pick-date todoTime=day-00:00 write stays deleted')
})

/* ---------- F13 + refactor: shared parseSnapshot guard in undo/redo ---------- */

function makeCtx ({ undoTop, redoTop }) {
  const calls = []
  const state = {
    undoStack: undoTop !== undefined ? [undoTop] : [],
    redoStack: redoTop !== undefined ? [redoTop] : [],
    todoList: [{ taskId: 'live', taskContent: 'live' }],
    recycleList: [],
    _histEpoch: 0
  }
  const ctx = {
    state,
    commit (m, p) { calls.push([m, p]) },
    async dispatch (m, p) {
      calls.push([m, p && p.from ? 'diff' : m])
      if (m === 'persistSnapshotDiff') return []
      return undefined
    }
  }
  return { ctx, state, calls }
}

test('F13 undo: shape-corrupt snapshot ({}) is dropped as corrupt, step disposed, no restore/redopush', async () => {
  const { ctx, calls } = makeCtx({ undoTop: '{}' })
  const r = await undoStep(ctx)
  assert.equal(r, false, 'corrupt step reports not-done')
  assert.ok(calls.some(([m]) => m === 'historyUndoPop'), 'unusable entry disposed so older steps stay reachable')
  assert.ok(!calls.some(([m]) => m === 'historyRestore'), 'state never moves onto the corrupt snapshot')
  assert.ok(!calls.some(([m]) => m === 'historyRedoPush'), 'redo chain never seeded from a corrupt step')
  assert.ok(!calls.some(([m]) => m === 'persistSnapshotDiff'), 'no diff persisted off a corrupt snapshot')
})

test('F13 undo: syntactically valid but shape-corrupt {"_e":3} is dropped the same way', async () => {
  const { ctx, calls } = makeCtx({ undoTop: '{"_e":3}' })
  assert.equal(await undoStep(ctx), false)
  assert.ok(calls.some(([m]) => m === 'historyUndoPop'))
  assert.ok(!calls.some(([m]) => m === 'historyRestore'))
})

test('F13 undo: syntactically broken JSON still takes the same corrupt path (old behavior kept)', async () => {
  const { ctx, calls } = makeCtx({ undoTop: '{"todoList":' })
  assert.equal(await undoStep(ctx), false)
  assert.ok(calls.some(([m]) => m === 'historyUndoPop'))
  assert.ok(!calls.some(([m]) => m === 'historyRestore'))
})

test('F13 undo: a well-formed snapshot still restores (guard does not over-drop)', async () => {
  const prev = { todoList: [{ taskId: 'a', taskContent: 'a', updateTime: 1 }], recycleList: [] }
  const { ctx, calls } = makeCtx({ undoTop: JSON.stringify(prev) })
  const r = await undoStep(ctx)
  assert.equal(r && r.ok, true)
  const restore = calls.find(([m]) => m === 'historyRestore')
  assert.ok(restore, 'historyRestore committed')
  assert.deepEqual(restore[1], prev)
  assert.ok(calls.some(([m, tag]) => m === 'persistSnapshotDiff' && tag === 'diff'))
  assert.ok(calls.some(([m]) => m === 'historyUndoPop'))
})

test('F13 redo: shape-corrupt snapshot dropped, no restore/push; redo of a good snapshot still works', async () => {
  const bad = makeCtx({ redoTop: '{}' })
  assert.equal(await redoStep(bad.ctx), false)
  assert.ok(bad.calls.some(([m]) => m === 'historyRedoPop'))
  assert.ok(!bad.calls.some(([m]) => m === 'historyRestore'))
  assert.ok(!bad.calls.some(([m]) => m === 'historyPushKeepRedo'))

  const next = { todoList: [{ taskId: 'b', taskContent: 'b', updateTime: 2 }], recycleList: [] }
  const good = makeCtx({ redoTop: JSON.stringify(next) })
  const r = await redoStep(good.ctx)
  assert.equal(r && r.ok, true)
  const restore = good.calls.find(([m]) => m === 'historyRestore')
  assert.ok(restore)
  assert.deepEqual(restore[1], next)
})
