/* Undo of a date-clear (planSnapshotRowSync's restoreSnapshot+toTs transition): the snapshot-replay
 * executor in store/helpers/undo.js must pass the eff.toTs day to restoreSnapshot (rowChipSync's
 * D14-B4 contract) so the pre-delete chip snapshot is re-homed onto the row's (re-)dated day.
 * Root cause vs symptom: the executor called restoreSnapshot(taskId) verbatim, so undoing a
 * date-clear landed the chips back on the OLD day while the restored row lives on the new day —
 * ghost blocks on the old day, missing chips on the row's day, until planPrune GC'd them.
 * Run: node --test tests/unit/renderer/undo-redate-restore.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window) globalThis.window = {}
const planPutMany = []
const metaDeleted = []
const metaMap = new Map()
const DAY_Y = new Date('2026-10-05T00:00:00').getTime()
globalThis.window = Object.assign(globalThis.window, {
  location: { hash: '' },
  todoAPI: {
    dbCall (op, p) {
      if (op === 'getAll') return Promise.resolve([{ taskId: 'tk' }, { taskId: 'tk2' }]) // purged-generation guard: both rows durable
      if (op === 'getMeta') return Promise.resolve(metaMap.get(p) ?? null)
      if (op === 'setMeta') { const [k, v] = p; metaMap.set(k, v); return Promise.resolve(true) }
      if (op === 'deleteMeta') { metaDeleted.push(p); metaMap.delete(p); return Promise.resolve(true) }
      if (op === 'planAddMany') { planPutMany.push(...p); return Promise.resolve(p.map(r => r.id)) }
      return Promise.resolve(null)
    }
  }
})

const { persistSnapshotDiffCore } = await import('../../../renderer/js/store/helpers/undo.js')
const tick = (ms = 25) => new Promise(r => setTimeout(r, ms))

const row = (over = {}) => ({ taskId: 'tk', taskContent: 't', delete: false, dayStart: 0, todoTime: 0, updateTime: 1, status: 'update', version: 1, ...over })
const mkCommit = () => { const calls = []; return { calls, commit: (type, p) => { calls.push([type, p]); return undefined } } }

test('undo executor re-dates restoreSnapshot onto the restored day (eff.toTs honored, YYYY-MM-DD)', async () => {
  metaMap.set('planChipsSnapshot:tk', JSON.stringify([
    { id: 'c1', taskId: 'tk', day: '2026-09-28', mm: '09:00', sort: 0, updatedAt: 5 }
  ]))
  const from = { todoList: [row()], recycleList: [] }
  const to = { todoList: [row({ dayStart: DAY_Y, updateTime: 2 })], recycleList: [] }
  const { commit } = mkCommit()
  persistSnapshotDiffCore({ commit }, { from, to }, () => {})
  await tick()
  // planSnapshotRowSync(date re-added) → {op:'restoreSnapshot', toTs: DAY_Y}; the executor must pass
  // fmtChipDay(DAY_Y) so the snapshot chip lands on the row's day, not verbatim on 2026-09-28
  assert.ok(planPutMany.length === 1, 'snapshot chip written back exactly once')
  assert.equal(planPutMany[0].day, '2026-10-05', 'chip follows the restored day — no ghost block on 2026-09-28')
  assert.ok(!metaMap.has('planChipsSnapshot:tk'), 'snapshot meta consumed')
})

test('undo executor keeps the verbatim restore when the effect carries no toTs (soft-delete undo)', async () => {
  planPutMany.length = 0
  metaMap.set('planChipsSnapshot:tk2', JSON.stringify([
    { id: 'c2', taskId: 'tk2', day: '2026-09-28', mm: '10:00', sort: 0, updatedAt: 5 }
  ]))
  // undone soft-delete: the row is deleted in the snapshot we come FROM, live in the one we move TO
  const from = { todoList: [], recycleList: [row({ taskId: 'tk2', delete: true, deletedAt: 9 })] }
  const to = { todoList: [row({ taskId: 'tk2', updateTime: 2 })], recycleList: [] }
  const { commit } = mkCommit()
  persistSnapshotDiffCore({ commit }, { from, to }, () => {})
  await tick()
  assert.ok(planPutMany.length === 1, 'snapshot restored')
  assert.equal(planPutMany[0].day, '2026-09-28', 'no toTs → verbatim day (existing contract unchanged)')
})
