/**
 * [maint/d26 P2] CalendarView edge auto-month-flip used to dispatch a bare
 * `patch: { todoTime: <new month midnight> }` — a 14:30 schedule silently became all-day AND its
 * reminderTime/reminderExtra stayed anchored to the OLD month (the orphan class crossDayMovePatch
 * exists to prevent; the eventDrop path already routed through it).
 * Fix: the edge-flip path now uses the same crossDayMovePatch/crossDayRevertPatch invariant.
 * Run: node --test tests/unit/renderer/maint-d26-calendar-edge-flip.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import '../../setup.mjs' // window.dayjs UMD shim + i18n + localStorage, must load before utils

// eventDragStop touches document listeners (edge auto-flip); Node has none
if (!globalThis.document) globalThis.document = { addEventListener () {}, removeEventListener () {} }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const { buildCalendarOptions } = await import(
  pathToFileURL(path.join(ROOT, 'renderer/js/views/calendarOptions.js')).href
)
const { dayStart } = await import(
  pathToFileURL(path.join(ROOT, 'renderer/js/utils/todayBounds.js')).href
)
const { dayjs } = await import(
  pathToFileURL(path.join(ROOT, 'renderer/js/utils/core.js')).href
)

const ORIG = dayStart(new Date(2026, 9, 5).getTime()) // Oct 5 2026
const AT1430 = 14 * 3600000 + 30 * 60000

const baseTask = {
  taskId: 't1',
  dayStart: ORIG,
  todoTime: ORIG + AT1430, // 14:30 schedule anchored to the old day
  reminderTime: ORIG + 9 * 3600000,
  reminderExtra: [ORIG + 8 * 3600000]
}

function makeSelf (task, dispatched) {
  return {
    view: 'dayGridMonth',
    taskById: new Map([[task.taskId, task]]),
    $store: {
      dispatch (action, payload) { dispatched.push({ action, payload }) }
    },
    $t: key => key,
    _dragInfo: null,
    _autoNav: 0
  }
}

// Simulate the real gesture: eventDragStart arms state, the edge timer sets _autoNav, then
// eventDragStop fires (its own page-flip branch does the move when the drop never lands).
function edgeFlip (self, taskId, dir) {
  const opts = buildCalendarOptions(self, ORIG)
  opts.eventDragStart({ event: { id: taskId } })
  self._autoNav = dir
  opts.eventDragStop({ event: { id: taskId } })
}

test('edge auto-month-flip preserves time-of-day and re-anchors old-day reminders', () => {
  const dispatched = []
  const self = makeSelf(baseTask, dispatched)
  edgeFlip(self, 't1', 1)
  const move = dispatched.find(d => d.action === 'todo/updateTodoFields')
  assert.ok(move, 'moveWithUndo.apply must dispatch updateTodoFields')
  const patch = move.payload.patch
  assert.equal(move.payload.taskId, 't1')
  assert.equal(patch.dayStart, +dayjs(ORIG).add(1, 'month').startOf('day'), 'dayStart moves one month ahead')
  assert.equal(patch.todoTime, patch.dayStart + AT1430, '14:30 preserved (old code wrote bare midnight ts)')
  assert.equal(patch.reminderTime, patch.dayStart + 9 * 3600000, 'reminder follows the move instead of staying orphaned')
  assert.deepEqual(patch.reminderExtra, [patch.dayStart + 8 * 3600000], 'extra reminder follows too')
})

test('edge-flip undo restores the FULL prior state (time-of-day included)', () => {
  const dispatched = []
  const self = makeSelf(baseTask, dispatched)
  edgeFlip(self, 't1', 1)
  assert.ok(dispatched.length, 'move dispatched')
  dispatched.length = 0
  // The revert closure runs against the post-move snapshot; re-run the flip backwards to
  // exercise the same revert patch builder on the original values.
  const back = makeSelf({ ...baseTask, dayStart: +dayjs(ORIG).add(1, 'month').startOf('day'), todoTime: +dayjs(ORIG).add(1, 'month').startOf('day') + AT1430, reminderTime: +dayjs(ORIG).add(1, 'month').startOf('day') + 9 * 3600000, reminderExtra: [] }, dispatched)
  edgeFlip(back, 't1', -1)
  const undo = dispatched.find(d => d.action === 'todo/updateTodoFields')
  assert.ok(undo, 'reverse flip dispatches the revert patch')
  assert.equal(undo.payload.patch.todoTime, ORIG + AT1430, 'revert restores the original timed todoTime, not a midnight')
  assert.equal(undo.payload.patch.reminderTime, ORIG + 9 * 3600000)
  assert.equal(undo.payload.patch.dayStart, ORIG)
})
