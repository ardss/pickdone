/**
 * Quick-add effective-date decision (utils/quickAddDate) - the pure logic behind b14f885 making the inbox the default target.
 * Run: npm test
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveQuickAddDate, reminderTsFromParse } from '../../../renderer/js/utils/quickAddDate.js'

const TODAY = 1756500000000

test('quickadd: user explicitly chooses no date -> 0; NL parsing no longer applies', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: 0, parsedTs: 123, inTodoBox: false, todayTs: TODAY }), 0)
  assert.equal(resolveQuickAddDate({ pickedDate: 0, parsedTs: 123, inTodoBox: true, todayTs: TODAY }), 0)
})

test('quickadd: an explicitly picked date wins', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: 999, parsedTs: 123, inTodoBox: false, todayTs: TODAY }), 999)
})

test('quickadd: the NL-parsed date applies when nothing is explicitly picked', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: 777, inTodoBox: false, todayTs: TODAY }), 777)
})

test('quickadd: nothing specified - the inbox page defaults to 0 (into the inbox); other pages default to today', () => {
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: true, todayTs: TODAY }), 0)
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY }), TODAY)
})

// [J1 journey-audit 2026-10-22] Selected non-today day in the today view is the add target:
// the day view's empty state promises "add a task to this day"; defaulting to today silently
// moved the row off the screen the user was looking at.
test('quickadd: a selected non-today view day becomes the default target (no explicit date)', () => {
  const YESTERDAY = TODAY - 86400000
  const TOMORROW = TODAY + 86400000
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY, viewDayTs: YESTERDAY }), YESTERDAY)
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY, viewDayTs: TOMORROW }), TOMORROW)
})

test('quickadd: view day defaults keep every existing override intact', () => {
  const TOMORROW = TODAY + 86400000
  // explicit "no date" still wins (box/undated behavior unchanged)
  assert.equal(resolveQuickAddDate({ pickedDate: 0, parsedTs: 123, inTodoBox: false, todayTs: TODAY, viewDayTs: TOMORROW }), 0)
  // explicit pick still wins
  assert.equal(resolveQuickAddDate({ pickedDate: 999, parsedTs: null, inTodoBox: false, todayTs: TODAY, viewDayTs: TOMORROW }), 999)
  // NL-parsed date still wins
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: 777, inTodoBox: false, todayTs: TODAY, viewDayTs: TOMORROW }), 777)
  // inbox page stays undated even with a view day selected
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: true, todayTs: TODAY, viewDayTs: TOMORROW }), 0)
  // a view day equal to today is a no-op
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY, viewDayTs: TODAY }), TODAY)
  // absent/0 view day (other routes) keeps today
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY, viewDayTs: 0 }), TODAY)
  assert.equal(resolveQuickAddDate({ pickedDate: null, parsedTs: null, inTodoBox: false, todayTs: TODAY }), TODAY)
})

// [P2 config-surface 2026-10-22] A time-bearing NL parse shows the time in the chip ("后天 09:30"),
// so the created task must carry it as reminderTime — the old hardcoded todoReminderTime: 0 made
// the quick-add silently promise a reminder it never set. The label gains a trailing 'HH:mm'
// exactly when a parser branch consumed a time-of-day phrase.
test('quickadd reminder: a time-bearing parse wires the reminder ts', () => {
  const TS = 1792704600000
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: '后天 09:30' } }), TS)
  // time-only Chinese parse (no date words): same handoff
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: '09:30' } }), TS)
  // English time phrase ('tomorrow 3pm' → 'tomorrow 15:00')
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: 'tomorrow 15:00' } }), TS)
})

test('quickadd reminder: date-only parses and manual chips stay at 0', () => {
  const TS = 1792704600000
  // date-only parse: label has no trailing HH:mm
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: '明天' } }), 0)
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: '10月30日' } }), 0)
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: { valueOf: () => TS }, label: 'next friday' } }), 0)
  // manual chip (any value, incl. explicit-clear 0) overrides the parsed date → no NL reminder
  assert.equal(reminderTsFromParse({ pickedDate: 123, parsed: { date: { valueOf: () => TS }, label: '明天 15:00' } }), 0)
  assert.equal(reminderTsFromParse({ pickedDate: 0, parsed: { date: { valueOf: () => TS }, label: '明天 15:00' } }), 0)
  // no parse at all
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: null }), 0)
  assert.equal(reminderTsFromParse({ pickedDate: null, parsed: { date: null, label: '' } }), 0)
})
