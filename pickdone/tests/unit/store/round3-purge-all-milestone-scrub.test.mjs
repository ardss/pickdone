/* QC Round-3 P1 (2026-09-21, fix/round3-p1): purgeAllRecycle milestone scrub + focus detach.
 *  The bulk "empty recycle bin" path used to skip what purgeIds does:
 *    - phantom taskIds stayed in `projectMilestones:<catId>` (the D5 bug on the bulk path:
 *      an unmet milestone with zero surviving links could flip to 'done')
 *    - a task still bound by the tomato focus was purged without detaching the focus
 *  Mirrors the harness pattern of qc1-purge-result-convergence.test.mjs. No electron required.
 *  Run: node --test tests/unit/store/round3-purge-all-milestone-scrub.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const startOfDayTs = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const mkDayjs = ts => {
  const t = ts == null ? Date.now() : (ts && typeof ts === 'object' && ts.valueOf ? ts.valueOf() : ts)
  const o = {
    format: f => String(t),
    valueOf: () => t,
    startOf: u => u === 'day' ? mkDayjs(startOfDayTs(t)) : o,
    add: () => o,
    subtract: () => o,
    isSame: () => false,
    hour: () => ({ minute: () => ({ second: () => ({ valueOf: () => t }) }) })
  }
  return o
}
globalThis.dayjs = mkDayjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 exposes a read-only navigator */ }

const purgeRecycleBinCalls = []
const meta = new Map()
const detached = []
globalThis.window = {
  location: { hash: '' },
  dayjs: mkDayjs,
  todoAPI: {
    dbCall: (op, ...a) => {
      if (op === 'hardDelete') return Promise.resolve()
      if (op === 'getMeta') return Promise.resolve(meta.get(a[0]) ?? null)
      if (op === 'setMeta') { meta.set(a[0][0], a[0][1]); return Promise.resolve() }
      if (op === 'deleteMeta') { meta.delete(a[0]); return Promise.resolve() }
      return Promise.resolve(null)
    },
    writeCriticalStateBackup: () => Promise.resolve(),
    deleteTodoFilesRelevant: () => Promise.resolve(),
    purgeRecycleBin: () => { purgeRecycleBinCalls.push(1); return Promise.resolve(true) }
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: true, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'delete', categoryId: 7, ...over
})

beforeEach(() => {
  purgeRecycleBinCalls.length = 0
  detached.length = 0
  meta.clear()
})

test('round3: purgeAllRecycle scrubs the purged ids from projectMilestones:<catId>', async () => {
  // One milestone in category 7 linked to a recycled task and a live task; purging the bin
  // must keep only the live link.
  meta.set('projectMilestones:7', JSON.stringify([
    { id: 'ms1', title: 'Ship it', date: 1735689600000, taskIds: ['dead1', 'alive1'] },
  ]))
  const state = { recycleList: [row('dead1')] } // alive1 is a LIVE task (not in the bin)
  const ctx = {
    commit: () => {},
    dispatch: async (name) => { if (name === 'tomato/attach') detached.push(name); return {} },
    rootState: { tomato: { attachTodo: null } },
    state
  }
  const ok = await todoActions.purgeAllRecycle.call({}, ctx)
  assert.equal(ok, true)
  assert.equal(purgeRecycleBinCalls.length, 1)
  const ms = JSON.parse(meta.get('projectMilestones:7'))
  assert.deepEqual(ms[0].taskIds, ['alive1'], 'phantom taskId scrubbed; the live link survives')
})

test('round3: purgeAllRecycle detaches the tomato focus when the focused task is purged', async () => {
  const calls = []
  const state = { recycleList: [row('focused')] }
  const ctx = {
    commit: () => {},
    dispatch: async (name, payload, opts) => { calls.push({ name, payload, opts }); return {} },
    rootState: { tomato: { attachTodo: { taskId: 'focused' } } },
    state
  }
  const ok = await todoActions.purgeAllRecycle.call({}, ctx)
  assert.equal(ok, true)
  const attach = calls.find(c => c.name === 'tomato/attach')
  assert.ok(attach, 'tomato/attach dispatched')
  assert.equal(attach.payload, null, 'focus detached (the deleted task is never booked)')
  assert.equal(attach.opts && attach.opts.root, true)
})

test('round3: purgeAllRecycle leaves unrelated milestones untouched', async () => {
  meta.set('projectMilestones:9', JSON.stringify([
    { id: 'ms2', title: 'No links here', date: 1735689600000 },
    { id: 'ms3', title: 'Other cat', date: 1735689600000, taskIds: ['liveX'] },
  ]))
  const state = { recycleList: [row('dead2', { categoryId: 0 })] } // categoryId 0 → no cat scrub target
  const ctx = {
    commit: () => {},
    dispatch: async () => ({}),
    rootState: { tomato: { attachTodo: null } },
    state
  }
  await todoActions.purgeAllRecycle.call({}, ctx)
  const ms = JSON.parse(meta.get('projectMilestones:9'))
  assert.deepEqual(ms[1].taskIds, ['liveX'], 'unrelated milestone links intact')
})
