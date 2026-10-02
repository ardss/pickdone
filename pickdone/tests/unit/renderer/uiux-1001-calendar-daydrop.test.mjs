/**
 * [uiux-2026-10-01 J4 P0] Day-grid drag-to-reschedule never persisted.
 * FullCalendar fires eventDragStop BEFORE eventDrop; eventDragStop used to reset
 * self._dragInfo = null, so eventDrop's `self._dragInfo &&` guard could never pass and
 * moveWithUndo never ran — the chip visually landed (optimistic MERGE_EVENTS) but the
 * store kept the old dayStart, silently losing the reschedule.
 * Fix: eventDrop now derives origTs from info.oldEvent (no drag-state bookkeeping) and
 * rides the shared crossDayMovePatch invariant (same [R4] rule as tbDrop).
 * Run: node --test tests/unit/renderer/uiux-1001-calendar-daydrop.test.mjs
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

const DAY = 86400000
// Two fixed local midnights (avoid DST/month edge cases by anchoring to a fixed date)
const ORIG = dayStart(new Date(2026, 9, 5).getTime())
const TARGET = ORIG + 7 * DAY

function makeSelf (task, dispatched) {
  return {
    view: 'dayGridMonth',
    taskById: new Map([[task.taskId, task]]),
    $store: {
      dispatch (action, payload) { dispatched.push({ action, payload }) }
    },
    $t: key => key,
    _dragInfo: null // exactly the state eventDragStop leaves behind (fires before eventDrop)
  }
}

const baseTask = {
  taskId: 't1',
  dayStart: ORIG,
  todoTime: ORIG + 14 * 3600000 + 30 * 60000, // 14:30 schedule anchored to the old day
  reminderTime: ORIG + 9 * 3600000
}

test('J4 P0: eventDrop persists the move even when eventDragStop already nulled _dragInfo', () => {
  const dispatched = []
  const self = makeSelf(baseTask, dispatched)
  const opts = buildCalendarOptions(self, ORIG)
  // Simulate FullCalendar's real order: dragstop first (resets state), then drop
  opts.eventDragStop({ event: { id: 't1', start: new Date(ORIG) } })
  assert.equal(self._dragInfo, null, 'precondition: dragstop left _dragInfo null')

  opts.eventDrop({
    oldEvent: { start: new Date(ORIG) },
    event: { id: 't1', start: new Date(TARGET) }
  })

  const move = dispatched.find(d => d.action === 'todo/updateTodoFields')
  assert.ok(move, 'moveWithUndo.apply must dispatch updateTodoFields (old guard never did)')
  const patch = move.payload.patch
  assert.equal(move.payload.taskId, 't1')
  assert.equal(patch.dayStart, TARGET, 'dayStart moves to the drop day')
  assert.equal(patch.todoTime, TARGET + 14 * 3600000 + 30 * 60000,
    'time-of-day (14:30) preserved on the new day per the crossDayMovePatch [R4] rule')
  assert.equal(patch.reminderTime, TARGET + 9 * 3600000,
    'old-day-anchored reminder re-anchors to the new day instead of being orphaned')
})

test('J4 P0: undo reverts exactly the fields the move rewrote', () => {
  const dispatched = []
  const self = makeSelf(baseTask, dispatched)
  const opts = buildCalendarOptions(self, ORIG)
  opts.eventDrop({
    oldEvent: { start: new Date(ORIG) },
    event: { id: 't1', start: new Date(TARGET) }
  })
  assert.ok(dispatched.some(d => d.action === 'todo/updateTodoFields'), 'move dispatched')
  // No $message / window.Vue in this harness: moveWithUndo skips the toast but the revert
  // closure is exactly the one the toast click would call.
  dispatched.length = 0
  opts.eventDrop({
    oldEvent: { start: new Date(TARGET) },
    event: { id: 't1', start: new Date(ORIG) }
  })
  const undo = dispatched.find(d => d.action === 'todo/updateTodoFields')
  assert.ok(undo, 'reverse drop (undo semantics) dispatches again')
  assert.equal(undo.payload.patch.dayStart, ORIG)
  assert.equal(undo.payload.patch.todoTime, ORIG + 14 * 3600000 + 30 * 60000)
  assert.equal(undo.payload.patch.reminderTime, ORIG + 9 * 3600000)
})

test('J4 P0: same-day drop is a no-op (no dispatch)', () => {
  const dispatched = []
  const self = makeSelf(baseTask, dispatched)
  const opts = buildCalendarOptions(self, ORIG)
  opts.eventDrop({
    oldEvent: { start: new Date(ORIG) },
    event: { id: 't1', start: new Date(ORIG + 3 * 3600000) }
  })
  assert.equal(dispatched.length, 0, 'no move within the same day')
})

test('J4 P0: task without todoTime lands on the drop day (fallback todoTime = day start)', () => {
  const dispatched = []
  const self = makeSelf({ taskId: 't2', dayStart: ORIG }, dispatched)
  const opts = buildCalendarOptions(self, ORIG)
  opts.eventDrop({
    oldEvent: { start: new Date(ORIG) },
    event: { id: 't2', start: new Date(TARGET) }
  })
  const move = dispatched.find(d => d.action === 'todo/updateTodoFields')
  assert.ok(move, 'marker task still moves')
  assert.equal(move.payload.patch.dayStart, TARGET)
  assert.equal(move.payload.patch.todoTime, TARGET, 'no fabricated time-of-day: midnight marker')
})
