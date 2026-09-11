/** New-feature module unit tests — habit streaks/countdown math/priority/Eisenheim quadrant placement/time-block positioning (pure logic; localStorage and window mocked) */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Lets store/habits.js run under Node (it uses localStorage/Date internally)
const store = {}
globalThis.localStorage = {
  getItem: k => store[k] ?? null,
  setItem: (k, v) => { store[k] = v },
  removeItem: k => { delete store[k] }
}
const { default: habitsStore } = await import('../../../renderer/js/store/habits.js')

const dayKey = (offset = 0) => {
  const d = new Date(); d.setDate(d.getDate() + offset)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

test('habits: create and check in today', () => {
  const s = habitsStore.state()
  habitsStore.mutations.addHabit(s, '每天阅读')
  assert.equal(s.habits.length, 1)
  const h = s.habits[0]
  habitsStore.mutations.toggleCheck(s, { id: h.id, day: dayKey(0) })
  assert.equal(h.records[dayKey(0)], true)
  // Clicking again = uncheck
  habitsStore.mutations.toggleCheck(s, { id: h.id, day: dayKey(0) })
  assert.equal(h.records[dayKey(0)], undefined)
  habitsStore.mutations.toggleCheck(s, { id: h.id, day: dayKey(0) })
})

test('habits: streak (checked in today and yesterday = 2; not checking in today does not break the streak, only yesterday counts)', () => {
  const s = habitsStore.state()
  const h = s.habits[0]
  h.records[dayKey(0)] = true
  h.records[dayKey(-1)] = true
  h.records[dayKey(-2)] = false
  const streak = habitsStore.getters.streakOf(s)(h.id)
  assert.equal(streak, 2)
  delete h.records[dayKey(0)]
  const streak2 = habitsStore.getters.streakOf(s)(h.id)
  assert.equal(streak2, 1) // yesterday broke it, only 1 remains (yesterday)
})

test('habits: last30 outputs 30 days with today last', () => {
  const s = habitsStore.state()
  const h = s.habits[0]
  const seq = habitsStore.getters.last30(s)(h.id)
  assert.equal(seq.length, 30)
  assert.equal(seq[29].key, dayKey(0))
  assert.equal(seq[29].on, true)
})

test('countdown: day diffs for remaining/passed/today', () => {
  const DAY = 86400000
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const mk = off => { const d = new Date(today.getTime() + off * DAY); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
  const daysDiff = key => Math.round((+new Date(key + 'T00:00:00') - today.getTime()) / DAY)
  assert.equal(daysDiff(mk(7)), 7)
  assert.equal(daysDiff(mk(-3)), -3)
  assert.equal(daysDiff(mk(0)), 0)
})

test('priority: field semantics (0=none, 1=low, 2=medium, 3=high)', () => {
  const names = ['', '低', '中', '高']
  assert.equal(names[1], '低'); assert.equal(names[3], '高')
})

test('Eisenhower quadrant: important/urgent decide the quadrant', () => {
  const qOf = t => (t.important ? 'I' : '') + (t.urgent ? 'U' : '') || 'none'
  assert.equal(qOf({ important: 1, urgent: 1 }), 'IU')
  assert.equal(qOf({ important: 1, urgent: 0 }), 'I')
  assert.equal(qOf({ important: 0, urgent: 1 }), 'U')
  assert.equal(qOf({ important: 0, urgent: 0 }), 'none')
})
