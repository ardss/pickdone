/* maint/deep-r2 regression tests (2026-10-02) — five verified renderer store/utils defects:
 *  - B2 (P1): undoing a repeat-group completion now removes the auto-renewed next instance
 *    (port of the CLI fix, cli/lib.js "F3 P2 2026-09-21"); shared contract in
 *    renderer/js/utils/repeatUndo.js, applied in store/todo.js toggleComplete's !target branch.
 *  - B8 (P2): queryTodos --keyword now post-filters via matchTodoKeyword (NFKC folding,
 *    whitespace-split multi-term AND, subtask scope) instead of a raw ASCII-case-insensitive
 *    SQL LIKE — end-to-end against a real temp-dir todos.db.
 *  - B14 (P2): peak-hours honors the user-facing copy: 2-hour window (2 bins, endHour=(h+2)%24),
 *    not the former 3-bin sum.
 *  - A13 (P3): focusedMinutesText is the single source of the measured-duration formula
 *    (TomatoBar's dead computed deleted; AbandonModal + FloatPage consume the helper).
 *  - A14 (P3): daysDiffFromToday derives "today" from an injected timestamp (the reactive
 *    store.todo.todayTimestamp), no wall-clock read.
 * Run: node --test tests/unit/store/maint-deepr2-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { findRenewedNextInstance } from '../../../renderer/js/utils/repeatUndo.js'
import todoMod from '../../../renderer/js/store/todo.js'
const todoActions = todoMod.actions
import { buildReviewMetrics } from '../../../renderer/js/views/statistics/metrics.js'
import { focusedMinutesText } from '../../../renderer/js/utils/tomatoShared.js'
import { daysDiffFromToday } from '../../../renderer/js/utils/momentDays.js'
const require = createRequire(import.meta.url)
const dbRows = require('../../../src/main/db-rows.js')

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', complete: false, ...over
})

// IPC seam: safeUpsert / snapshotForDelete funnel through window.todoAPI.dbCall (swappable per test)
globalThis.window.todoAPI = { dbCall: () => Promise.resolve(null) }

/* ---------------- B2: repeat-group undo removes the renewed next instance ---------------- */

test('B2: findRenewedNextInstance picks the nearest later, group-last, incomplete sibling', () => {
  const undone = row('a', { dayStart: 10 })
  // Renewal only ever creates the group's LAST instance, so the removal target is the single
  // later sibling when it is also the last (the [12,17] case below must stay a non-target).
  const group = [row('m', { dayStart: 12 })] // ascending dayStart
  assert.equal(findRenewedNextInstance(undone, group), group[0],
    'the instance renewal created (nearest later dayStart AND group last) is the removal target')
  // An earlier sibling (a genuine older instance the user un-did) is never the target
  assert.equal(findRenewedNextInstance(row('b', { dayStart: 17 }), group), null,
    'no sibling AFTER the undone row -> nothing to remove')
  // Renewed-next exists but a later sibling is the group's last -> renewal never fired there
  const three = [row('x', { dayStart: 12 }), row('y', { dayStart: 17 })]
  assert.equal(findRenewedNextInstance(row('a', { dayStart: 10 }), three), null,
    'nearest-later sibling is not the group last -> not a renewal artifact')
  // Renewed-next is the last but already re-completed -> keep it
  const doneNext = [row('b2', { dayStart: 17, complete: true })]
  assert.equal(findRenewedNextInstance(row('a', { dayStart: 10 }), doneNext), null,
    'a completed later instance is never removed by an undo')
  // Guards: undated rows / empty groups
  assert.equal(findRenewedNextInstance(row('a', { dayStart: 0 }), group), null)
  assert.equal(findRenewedNextInstance(row('a', { dayStart: 10 }), []), null)
})

function undoCtx (todoList, dispatchLog) {
  const commits = []
  const dbCalls = []
  const ctx = {
    state: { todoList },
    commit: (type, payload) => commits.push([type, payload]),
    dispatch: async (type, payload) => {
      dispatchLog.push([type, payload])
      if (type === 'updateTodoFields') {
        const t = todoList.find(x => x.taskId === payload.taskId)
        return Object.assign({}, t, payload.patch)
      }
      return {}
    },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } }
  }
  return { ctx, commits, dbCalls }
}

test('B2: undoing the renewed completion soft-deletes the phantom next instance (same undo step)', async () => {
  const dispatchLog = []
  const undone = row('a', { dayStart: 10, repeatId: 'r1', complete: true })
  const renewed = row('b', { dayStart: 17, repeatId: 'r1' })
  const { ctx, commits, dbCalls } = undoCtx([undone, renewed], dispatchLog)
  globalThis.window.todoAPI.dbCall = (op, params) => { dbCalls.push([op, params]); return Promise.resolve(null) }
  await todoActions.toggleComplete.call({}, ctx, undone)

  const removed = commits.filter(c => c[0] === 'upsertLocal' && c[1].taskId === 'b')
  assert.equal(removed.length, 1, 'the renewed instance is soft-deleted locally')
  assert.equal(removed[0][1].delete, true)
  assert.equal(removed[0][1].version, 0, 'version reset to 0 so the removal re-enters the sync snapshot (deleteTodo parity)')
  assert.equal(removed[0][1].status, 'delete')
  assert.ok(dbCalls.some(c => c[1] && c[1].taskId === 'b' && (c[1].delete === true || c[1].deleted === 1)),
    'the removal is persisted via the db command bus')
  assert.equal(dispatchLog.some(d => d[0] === 'ensureNextRepeatInstance'), false,
    'the undo direction never renews')
  const breakIdx = commits.findIndex(c => c[0] === 'historyBreakMerge')
  const removeIdx = commits.findIndex(c => c[0] === 'upsertLocal' && c[1].taskId === 'b')
  assert.ok(removeIdx >= 0 && removeIdx < breakIdx, 'the removal lands inside the same undo step (before the merge break)')
})

test('B2: undoing a non-renewed completion leaves the group untouched', async () => {
  const dispatchLog = []
  // undone row has a later sibling that is NOT the group's last -> renewal never fired on it
  const undone = row('a', { dayStart: 10, repeatId: 'r1', complete: true })
  const mid = row('m', { dayStart: 12, repeatId: 'r1' })
  const last = row('z', { dayStart: 17, repeatId: 'r1' })
  const { ctx, commits } = undoCtx([undone, mid, last], dispatchLog)
  await todoActions.toggleComplete.call({}, ctx, undone)
  assert.equal(commits.some(c => c[0] === 'upsertLocal' && c[1].taskId !== 'a'), false,
    'no sibling rows are modified when the undone row was not the renewed one')
  // a completed later instance is also left alone
  const doneNext = row('b2', { dayStart: 17, repeatId: 'r2', complete: true })
  const ctx2 = undoCtx([row('a2', { dayStart: 10, repeatId: 'r2', complete: true }), doneNext], dispatchLog)
  await todoActions.toggleComplete.call({}, ctx2.ctx, ctx2.ctx.state.todoList[0])
  assert.equal(ctx2.commits.some(c => c[0] === 'upsertLocal' && c[1].taskId !== 'a2'), false,
    'a completed later instance is never removed by an undo')
})

/* ---------------- B8: --keyword NFKC + multi-term + subtask-scope post-filter ---------------- */

test('B8: matchTodoKeywordTerms / matchTodoKeyword pin the matcher contract', () => {
  assert.deepEqual(dbRows.matchTodoKeywordTerms('Ａ１  milk'), ['a1', 'milk'], 'NFKC fold + whitespace split')
  assert.equal(dbRows.matchTodoKeywordTerms('   '), null, 'blank keyword -> no filter')
  assert.equal(dbRows.matchTodoKeywordTerms(null), null)

  const todoRow = {
    taskContent: 'buy Ａ１ milk',
    taskDescribe: '',
    subtasks: JSON.stringify([{ text: 'check 牛奶 expiry' }])
  }
  // fullwidth query matches ASCII-folded content and vice versa (NFKC both sides)
  assert.equal(dbRows.matchTodoKeyword(todoRow, ['a1', 'milk']), true)
  assert.equal(dbRows.matchTodoKeyword({ taskContent: 'a1 task', subtasks: null }, dbRows.matchTodoKeywordTerms('Ａ１')), true)
  // subtask scope: term only present in a subtask text still matches
  assert.equal(dbRows.matchTodoKeyword({ taskContent: 'plain', subtasks: todoRow.subtasks }, ['牛奶']), true)
  // multi-term is AND across the union of fields
  assert.equal(dbRows.matchTodoKeyword(todoRow, ['buy', 'expiry']), true, 'terms may split across fields')
  assert.equal(dbRows.matchTodoKeyword(todoRow, ['buy', 'cheese']), false)
  // malformed subtask JSON must not throw, plain fields still match
  assert.equal(dbRows.matchTodoKeyword({ taskContent: 'ok', subtasks: '{broken' }, ['ok']), true)
})

test('B8: queryTodos --keyword end-to-end (fullwidth + subtask scope) on a real temp db', () => {
  const db = require('../../../src/main/db.js')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deepr2-db-'))
  db.init(path.join(tmp, 'todos.db'))
  db.call('upsert', { taskId: 'fw', taskContent: 'buy Ａ１ milk', dayStart: 10 })
  db.call('upsert', { taskId: 'sub', taskContent: 'plain task', subtasks: JSON.stringify([{ text: '牛奶 purchase' }]), dayStart: 11 })
  db.call('upsert', { taskId: 'no', taskContent: 'unrelated', dayStart: 12 })
  const q = kw => db.call('queryTodos', { keyword: kw }).map(r => r.taskId)
  assert.deepEqual(q('a1'), ['fw'], 'ASCII query matches a fullwidth row (NFKC)')
  assert.deepEqual(q('Ａ１'), ['fw'], 'fullwidth query matches the same row')
  assert.deepEqual(q('牛奶'), ['sub'], 'term living only in a subtask text matches')
  assert.deepEqual(q('unrelated extra'), [], 'multi-term AND: one miss excludes the row')
  assert.equal(db.call('queryTodos', {}).length, 3, 'no keyword -> unfiltered')
  assert.deepEqual(q('%'), [], 'LIKE metacharacters are literal terms now, not wildcards')
})

/* ---------------- B14: peak hours = 2-hour window (2 bins) ---------------- */

const DAY = 24 * 3600 * 1000
const rec = (endTime, focusDuration) => ({ endTime, focusDuration, succeed: true })
const periodNow = ts => ({ start: ts - 7 * DAY, end: ts, label: 'week' })

test('B14: peak-hours sums 2 bins and endHour=(h+2)%24 (2-hour window, exclusive end)', () => {
  const now = Date.now()
  const dayBase = new Date(now); dayBase.setHours(0, 0, 0, 0); const d2 = +dayBase - 2 * DAY
  // 10 + 10 at hours 10/11 vs 90 at hour 12: the old 3-bin sum peaked at h=10 (110) and reported
  // 10–13; the 2-hour contract peaks at h=11 (100) with endHour 13... discriminates both ways.
  const records = [
    rec(d2 + (10 * 3600 + 30 * 60) * 1000, 10),
    rec(d2 + (11 * 3600 + 30 * 60) * 1000, 10),
    rec(d2 + (12 * 3600 + 30 * 60) * 1000, 90)
  ]
  const m = buildReviewMetrics({ todos: [], records, catNameOf: () => 'x' }, periodNow(now))
  assert.ok(m.peakHours, 'a >=30min week produces a peak')
  assert.equal(m.peakHours.startHour, 11, 'the 2-bin window (11,12) beats any single hour window containing the 12-only spike pair')
  assert.equal(m.peakHours.endHour, 13, 'endHour is exclusive (h+2), not the former (h+3)')
  assert.equal(m.peakHours.share, Math.round(100 / 110 * 100))
})

test('B14: a single 2-bin pair wins over the old 3-bin spread; midnight wrap keeps endHour mod 24', () => {
  const now = Date.now()
  const dayBase = new Date(now); dayBase.setHours(0, 0, 0, 0); const d2 = +dayBase - 2 * DAY
  const records = [
    rec(d2 + 22 * 3600 * 1000, 30),
    rec(d2 + 23 * 3600 * 1000, 30)
  ]
  const m = buildReviewMetrics({ todos: [], records, catNameOf: () => 'x' }, periodNow(now))
  assert.deepEqual(m.peakHours, { startHour: 22, endHour: 0, share: 100 },
    'the 22:00–24:00 window wraps endHour to 0 (2-hour copy honored)')
})

/* ---------------- A13: focusedMinutesText single source ---------------- */

test('A13: focusedMinutesText floors/clamps the measured session minutes', () => {
  const start = Date.now() - 90 * 60 * 1000 - 500 // 90m00.5s of elapsed focus -> 90 whole minutes
  assert.equal(focusedMinutesText(start), '90')
  assert.equal(focusedMinutesText(Date.now() - 59 * 1000), '0', 'sub-minute floors to 0')
  assert.equal(focusedMinutesText(Date.now() + 60000), '0', 'clock skew clamps to 0')
  assert.equal(focusedMinutesText(null), '0', 'not started -> "0"')
  assert.equal(focusedMinutesText(5000, 5 * 60000 + 5000), '5', 'injected now is honored')
})

/* ---------------- A14: daysDiffFromToday uses an injected "today" ---------------- */

test('A14: daysDiffFromToday derives the diff from the injected today timestamp', () => {
  const today = new Date(2026, 9, 2, 14, 30).getTime() // mid-day wall clock on 2026-10-02
  // todayTimestamp is already a day-start ts (setTodayTs), but the helper re-normalizes anyway
  assert.equal(daysDiffFromToday('2026-10-02', today), 0)
  assert.equal(daysDiffFromToday('2026-10-01', today), -1)
  assert.equal(daysDiffFromToday('2026-10-05', today), 3)
  assert.equal(daysDiffFromToday('2026-10-02', new Date(2026, 9, 2, 0, 0, 0).getTime()), 0,
    'a day-start today ts (what the store actually holds) yields the same diff')
  assert.equal(daysDiffFromToday('2026-10-02', null), daysDiffFromToday('2026-10-02', Date.now()),
    'missing today falls back to the wall clock (helper-level default only)')
})
