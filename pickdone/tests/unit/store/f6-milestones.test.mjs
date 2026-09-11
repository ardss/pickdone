/* F6 regression (2026-09-12): milestones — loadMilestones must drop entries with non-numeric dates (CLI-parity
 * `Number(m.date)` tolerance), and saveMilestones must surface setMeta failures (console.error + observable
 * savePromise) instead of silently swallowing them. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const meta = new Map()
let failNextSetMeta = false
const errors = []
const origError = console.error
globalThis.window = { todoAPI: { dbCall: async (op, p) => {
  if (op === 'getMeta') return meta.get(p) ?? null
  if (op === 'setMeta') { if (failNextSetMeta) throw new Error('db down'); meta.set(p[0], p[1]); return }
  return null
} } }

beforeEach(() => {
  meta.clear()
  failNextSetMeta = false
  console.error = (...args) => { errors.push(args) }
})

test('F6: loadMilestones filters out entries whose date is not numeric-parseable', async () => {
  meta.set('projectMilestones:p1', JSON.stringify([
    { id: 'a', title: 'good', date: 1730000000000 },
    { id: 'b', title: 'garbage', date: 'not-a-date' },
    { id: 'c', title: 'no-date' },
    null
  ]))
  const mod = await import('../../../renderer/js/utils/milestones.js')
  const list = await mod.loadMilestones('p1')
  assert.deepEqual(list.map(m => m.id), ['a'], 'non-numeric / missing date entries dropped (CLI parity)')
})

test('F6: saveMilestones keeps returning the sorted array for existing callers', async () => {
  const mod = await import('../../../renderer/js/utils/milestones.js')
  const saved = mod.saveMilestones('p2', [
    { title: 'B', date: 2000 },
    { title: 'A', date: 1000 }
  ])
  assert.ok(Array.isArray(saved), 'still a plain array (ProjectView assigns it directly)')
  assert.deepEqual(saved.map(m => m.title), ['A', 'B'], 'date-sorted as before')
  assert.equal(saved[0].id.startsWith('ms_'), true)
  assert.equal(await saved.savePromise, true, 'savePromise resolves true on successful write')
  console.error = origError
})

test('F6: saveMilestones logs and reports failure instead of swallowing it', async () => {
  failNextSetMeta = true
  const mod = await import('../../../renderer/js/utils/milestones.js')
  const saved = mod.saveMilestones('p3', [{ title: 'X', date: 5 }])
  assert.equal(await saved.savePromise, false, 'savePromise resolves false so callers can detect the loss')
  assert.equal(errors.length, 1, 'failure is logged')
  console.error = origError
})
