/* F6 regression (2026-09-12): fire-and-forget meta writes must log failures instead of `.catch(() => {})`.
 * Covers utils/tomatoEstimate.js (dual-write pair) and store/habits.js (persist). main.js expired-receipt
 * write is the same one-line pattern (console.error in the catch) but lives in the renderer shell bundle and
 * is not importable under node --test. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const errors = []
const origError = console.error
const realSetTimeout = globalThis.setTimeout
let dbShouldFail = false
const LS = {}
globalThis.localStorage = {
  getItem: k => LS[k] ?? null,
  setItem: (k, v) => { LS[k] = v },
  removeItem: k => { delete LS[k] }
}
globalThis.window = {
  dayjs: () => ({ format: () => '2026-09-12' }),
  todoAPI: { dbCall: async () => { if (dbShouldFail) throw new Error('meta write down'); return null } }
}

beforeEach(() => {
  dbShouldFail = false
  console.error = (...a) => { errors.push(a.join(' ')) }
})

test('F6: tomatoEstimate persist logs failed setMeta dual-writes', async () => {
  const mod = await import('../../../renderer/js/utils/tomatoEstimate.js')
  dbShouldFail = true
  mod.setEstimate('task-1', 3)
  await new Promise(r => realSetTimeout(r, 10))
  const hits = errors.filter(e => e.includes('tomatoEstimate'))
  assert.equal(hits.length >= 2, true, 'both LS_KEY and TS_KEY write failures are logged, got: ' + hits.length)
  // success path stays silent
  errors.length = 0
  dbShouldFail = false
  mod.setEstimate('task-1', 0)
  await new Promise(r => realSetTimeout(r, 10))
  assert.equal(errors.filter(e => e.includes('tomatoEstimate')).length, 0)
  console.error = origError
})

test('F6: habits persist logs failed setMeta (durable source of truth write)', async () => {
  const mod = await import('../../../renderer/js/store/habits.js')
  const state = { habits: [], moments: [], savedAt: 0 }
  dbShouldFail = true
  mod.default.mutations.addHabit(state, { name: 'read' })
  await new Promise(r => realSetTimeout(r, 10))
  assert.equal(errors.some(e => e.includes('habits')), true, 'failure is logged')
  // success path stays silent
  errors.length = 0
  dbShouldFail = false
  mod.default.mutations.renameHabit(state, { id: state.habits[0].id, name: 'read more' })
  await new Promise(r => realSetTimeout(r, 10))
  assert.equal(errors.filter(e => e.includes('habits')).length, 0)
  console.error = origError
})
