/* F4 regression #4 (2026-09-15): same-day taskSort is computed from each window's in-memory min/max,
 * so two windows adding to the same day with the same (stale) view derive the IDENTICAL sort value and
 * the resulting order depends on DB row return order. A true fix needs an atomic DB-side next-sort
 * channel (cross-module, main process) — recorded on the skip list. This pins the low-risk mitigation:
 * a sub-half-step jitter (±128 of the 512 step) makes colliding rows distinct and ordered by arrival,
 * while staying well inside the insertion band so top/bottom semantics survive. No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const startOfDayTs = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const mkDayjs = ts => {
  const t = ts == null ? Date.now() : (ts && typeof ts === 'object' && ts.valueOf ? ts.valueOf() : ts)
  const o = {
    valueOf: () => t,
    startOf: u => u === 'day' ? mkDayjs(startOfDayTs(t)) : o,
    add: () => o,
    subtract: () => o,
    isSame: (x) => t === (x && x.valueOf ? x.valueOf() : x)
  }
  return o
}
globalThis.dayjs = mkDayjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: async () => null } }

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions

const today0 = startOfDayTs(Date.now())
const baseCtx = () => ({
  state: { todoList: [{ taskId: 'seed', delete: false, dayStart: today0, taskSort: 1024 }] },
  rootState: { settings: {}, auth: { user: { userId: 'u' } } },
  commit: () => {},
  dispatch: async () => {}
})

test('F4: two windows adding to the same day from the same stale view never collide on taskSort', async () => {
  // Simulate window A and window B: identical memory, identical base sort derivation
  const a = await todoActions.addTodo.call({}, baseCtx(), { todoContent: 'A', todoDate: today0 })
  const b = await todoActions.addTodo.call({}, baseCtx(), { todoContent: 'B', todoDate: today0 })
  assert.notEqual(a.taskSort, b.taskSort, 'jitter keeps same-derived sort values distinct')
  // Jitter stays within half the insertion step (512) so top/bottom insertion semantics survive
  assert.ok(Math.abs(a.taskSort - (1024 + 512)) < 256, `jitter bound: ${a.taskSort}`)
  assert.ok(Math.abs(b.taskSort - (1024 + 512)) < 256, `jitter bound: ${b.taskSort}`)
})
