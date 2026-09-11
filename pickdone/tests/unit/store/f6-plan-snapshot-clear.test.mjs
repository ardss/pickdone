/* F6 regression (2026-09-12): planSnapshotRowSync's date-removal branch must snapshot chips before clearing.
 * Previously it returned only {op:'clearTaskChips'}, so undoing a "clear date" had no snapshot meta to
 * restore and the schedule chips were lost permanently (rowChipSync's same scenario did snapshot).
 * Runs the real planChips/dayPlans chain against a fake in-memory db bridge. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const SEP4 = +new Date('2026-09-04T00:00:00')
globalThis.dayjs = ts => {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return { format: f => f === 'YYYY-MM-DD' ? ymd : String(ts), valueOf: () => ts }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

// Fake db bridge: in-memory plan_chips rows + meta map implementing the ops dayPlans uses
const meta = new Map()
let chips = []
let dbHandler = async () => []
globalThis.window = {
  location: { hash: '' },
  todoAPI: { dbCall: (op, params) => dbHandler(op, params) }
}
const resetDb = () => { meta.clear(); chips = [] }
dbHandler = async (op, p) => {
  if (op === 'planAll') return chips.slice()
  if (op === 'setMeta') { meta.set(p[0], p[1]); return }
  if (op === 'getMeta') return meta.get(p) ?? null
  if (op === 'deleteMeta') { meta.delete(p); return }
  if (op === 'planDeleteTask') { chips = chips.filter(c => c.taskId !== p); return }
  if (op === 'planDeleteTaskDay') { chips = chips.filter(c => !(c.taskId === p.taskId && c.day === p.day)); return }
  if (op === 'planAddMany') { chips.push(...p); return p.map((c, i) => c.id || 'c' + i) }
  if (op === 'planMoveTask') return 0
  return []
}

const planChips = await import('../../../renderer/js/store/planChips.js')
const undoMod = await import('../../../renderer/js/store/undo.js')

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', ...over
})
const snap = rows => ({ todoList: rows, recycleList: [] })
const replay = (from, to) => undoMod.persistSnapshotDiffCore({ commit: () => {} }, { from, to }, () => {})
const drain = () => new Promise(r => setTimeout(r, 20))

beforeEach(resetDb)

test('F6: pure planner — live date removal returns snapshotForDelete + clearTaskChips', () => {
  const eff = planChips.planSnapshotRowSync(row('A', { dayStart: SEP4 }), row('A', { dayStart: 0, updateTime: 2 }))
  assert.deepEqual(eff, [{ op: 'snapshotForDelete', taskId: 'A' }, { op: 'clearTaskChips', taskId: 'A' }])
})

test('F6: clear-date via undo replay persists a chip snapshot meta that a later restore can use', async () => {
  chips.push({ id: 'c1', taskId: 't1', day: '2026-09-04', mm: '09:00' })
  // set date -> clear date (the fix under test: snapshot meta must land before chips are cleared)
  await replay(snap([row('t1', { dayStart: 0 })]), snap([row('t1', { dayStart: SEP4, updateTime: 2 })]))
  await drain()
  await replay(snap([row('t1', { dayStart: SEP4, updateTime: 2 })]), snap([row('t1', { dayStart: 0, updateTime: 3 })]))
  await drain()
  assert.equal(chips.length, 0, 'chips cleared after date removal')
  const raw = meta.get('planChipsSnapshot:t1')
  assert.ok(raw, 'snapshot meta persisted on date removal')
  assert.deepEqual(JSON.parse(raw), [{ id: 'c1', taskId: 't1', day: '2026-09-04', mm: '09:00' }])
  // undo the clear: restoreSnapshot (the chain's effect) must bring the chips back from that meta
  await planChips.restoreSnapshot('t1')
  await drain()
  assert.deepEqual(chips, [{ id: 'c1', taskId: 't1', day: '2026-09-04', mm: '09:00' }], 'chips restored from snapshot')
  assert.equal(meta.get('planChipsSnapshot:t1'), '', 'snapshot meta emptied after restore')
})

test('F6: no-op when the task had no chips to snapshot (meta absent, clear still runs)', async () => {
  await replay(snap([row('t2', { dayStart: 0 })]), snap([row('t2', { dayStart: SEP4, updateTime: 2 })]))
  await drain()
  await replay(snap([row('t2', { dayStart: SEP4, updateTime: 2 })]), snap([row('t2', { dayStart: 0, updateTime: 3 })]))
  await drain()
  assert.equal(meta.has('planChipsSnapshot:t2'), false, 'no chips -> no snapshot meta written')
})
