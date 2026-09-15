/**
 * G1 regressions for store/habits.js:
 *  [5] streakOf hard cap — `frequency:{type:'weekdays',weekdays:[]}` with a missing createdAt must not
 *      hang the renderer in the for(;;) walk-back (both exit conditions were unreachable);
 *  [6] two-way relay — the main window's storage listener now feeds the external blob into the main
 *      Vuex state via the onExternalHabitBlob hook + habits/applyExternal mutation (and clears the
 *      ping), plus a one-time residual delivery of a leftover SYNC_KEY at registration.
 * Run: node --test tests/unit/store/g1-habits-streak-relay.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
const metaCalls = []
globalThis.window = {
  location: { hash: '' },
  dayjs: globalThis.window.dayjs,
  todoAPI: { dbCall: async (op, p) => { metaCalls.push([op, p]); return 'ok' } }
}
const listeners = []
globalThis.window.addEventListener = (ev, fn) => { if (ev === 'storage') listeners.push(fn) }

const SYNC_KEY = 'habitsSyncPing'
const mod = await import('../../../renderer/js/store/habits.js')
const habits = mod.default

test('G1 habits [5]: empty weekdays + missing createdAt does not hang streakOf (returns 0)', () => {
  const state = { habits: [{ id: 'h1', name: 'X', records: {}, frequency: { type: 'weekdays', weekdays: [] } }] }
  // No timeout assertion needed: an infinite loop would fail the suite by hanging; 730-iteration cap finishes instantly
  assert.equal(habits.getters.streakOf(state)('h1'), 0)
})

test('G1 habits [5]: a normal daily streak still counts through the capped loop', () => {
  const today = globalThis.window.dayjs().format('YYYY-MM-DD')
  const y = globalThis.window.dayjs().subtract(1, 'day').format('YYYY-MM-DD')
  const state = { habits: [{ id: 'h2', name: 'Y', records: { [today]: true, [y]: true }, frequency: { type: 'daily' } }] }
  assert.equal(habits.getters.streakOf(state)('h2'), 2, 'today + yesterday checked = streak 2 (today unchecked is lenient, checked counts)')
})

test('G1 habits [6]: applyExternal updates main-window state last-write-wins (no persist echo)', () => {
  const state = { habits: [{ id: 'old', records: {} }], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(state, { habits: [{ id: 'new', records: {} }], moments: [{ id: 'm' }], savedAt: 200 })
  assert.equal(state.habits[0].id, 'new', 'a newer external blob replaces main-window state')
  assert.equal(state.savedAt, 200)
  habits.mutations.applyExternal(state, { habits: [{ id: 'stale' }], savedAt: 50 })
  assert.equal(state.habits[0].id, 'new', 'an older blob is ignored (last-write-wins)')
  habits.mutations.applyExternal(state, null)
  assert.equal(state.habits[0].id, 'new', 'malformed blob ignored')
})

test('G1 habits [6]: storage relay applies the blob to Vuex state (hook), persists to DB, clears the ping', async () => {
  assert.equal(listeners.length, 1, 'main window registered exactly one storage listener')
  LS.habitsState = JSON.stringify({ schemaV: 1, habits: [{ id: 'aux-edit', records: {} }], moments: [], savedAt: 300 })
  LS[SYNC_KEY] = 'ping1'
  const applied = []
  mod.onExternalHabitBlob(b => applied.push(b))
  listeners[0]({ key: SYNC_KEY })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(applied.length, 1, 'the external blob was fed into the main Vuex state via the hook')
  assert.equal(applied[0].habits[0].id, 'aux-edit')
  assert.equal(LS[SYNC_KEY], undefined, 'the ping is consumed after relay')
  assert.ok(metaCalls.some(c => c[0] === 'setMeta'), 'the blob is still re-persisted to the durable DB meta')
})

test('G1 habits [6]: a residual SYNC_KEY left by a previous session is relayed once and cleared at load', async () => {
  // Fresh module instance (query-string cache-bust): LS already holds a leftover ping + blob
  LS.habitsState = JSON.stringify({ schemaV: 1, habits: [{ id: 'residual' }], moments: [], savedAt: 400 })
  LS[SYNC_KEY] = 'ping-leftover'
  metaCalls.length = 0
  await import('../../../renderer/js/store/habits.js?residual=1')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(LS[SYNC_KEY], undefined, 'leftover ping consumed at registration')
  assert.ok(metaCalls.some(c => c[0] === 'setMeta' && JSON.parse(c[1][1]).habits[0].id === 'residual'),
    'the residual blob reached the DB via the relay path')
})
