/* QC round 1 — purge result convergence (behavior tests, no source anchors):
 *  - purgeAllRecycle returns true on success / false on IPC failure (was: undefined either way,
 *    so both RecycleBinView.clearAll and SettingsDataTab.purgeRecycle toasted success on failure)
 *  - purgeIds returns { done, failed } so the per-item purge view can surface a total failure
 *  Mirrors the harness pattern of store-r5-store.test.mjs. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const startOfDayTs = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const ymdOf = ts => {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const mkDayjs = ts => {
  const t = ts == null ? Date.now() : (ts && typeof ts === 'object' && ts.valueOf ? ts.valueOf() : ts)
  const o = {
    format: f => f === 'YYYY-MM-DD' ? ymdOf(t) : String(t),
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

let hardDeleteImpl = () => Promise.resolve()
let purgeRecycleBinImpl = () => Promise.resolve(true)
const fileDeletes = []
globalThis.window = {
  location: { hash: '' },
  dayjs: mkDayjs,
  todoAPI: {
    dbCall: (op, ...a) => {
      if (op === 'hardDelete') { hardDeleteImpl(...a); return Promise.resolve() }
      return Promise.resolve(null)
    },
    writeCriticalStateBackup: () => Promise.resolve(),
    deleteTodoFilesRelevant: id => { fileDeletes.push(id); return Promise.resolve() },
    purgeRecycleBin: (...a) => purgeRecycleBinImpl(...a)
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions
const { pendingUpserts } = todoMod._testInternals

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', ...over
})

beforeEach(() => {
  pendingUpserts.splice(0, pendingUpserts.length)
  fileDeletes.length = 0
  hardDeleteImpl = () => Promise.resolve()
  purgeRecycleBinImpl = () => Promise.resolve(true)
})

test('qc1 purgeAllRecycle resolves true on a successful purge', async () => {
  const state = { recycleList: [row('a', { delete: true }), row('b', { delete: true })] }
  const ok = await todoActions.purgeAllRecycle.call({}, {
    commit: () => {},
    dispatch: async () => ({}),
    state
  })
  assert.equal(ok, true, 'success must be reported as true so views show the success toast')
})

test('qc1 purgeAllRecycle resolves FALSE when the purge IPC fails (success toast must not fire)', async () => {
  purgeRecycleBinImpl = () => Promise.reject(new Error('ipc down'))
  const state = { recycleList: [row('a', { delete: true })] }
  const ok = await todoActions.purgeAllRecycle.call({}, {
    commit: () => {},
    dispatch: async () => ({}),
    state
  })
  assert.equal(ok, false, 'failure resolves (not rejects) with false — the view checks the flag')
  purgeRecycleBinImpl = () => Promise.resolve(undefined)
  const ok2 = await todoActions.purgeAllRecycle.call({}, {
    commit: () => {},
    dispatch: async () => ({}),
    state: { recycleList: [row('a', { delete: true })] }
  })
  assert.equal(ok2, false, 'a falsy IPC result counts as failure too')
})

test('qc1 purgeAllRecycle on an empty bin is a no-op resolving TRUE (success, nothing to purge)', async () => {
  const ok = await todoActions.purgeAllRecycle.call({}, {
    commit: () => {},
    dispatch: async () => ({}),
    state: { recycleList: [] }
  })
  assert.equal(ok, true, 'empty bin: nothing to purge — must read as success, not failure (r3)')
})

test('qc1 purgeIds returns done/failed split so a total failure is visible to the view', async () => {
  const ctx = {
    commit: () => {},
    dispatch: async (name) => {
      if (name === 'tomato/attach') return {}
      if (name === 'computeViews' || name === 'writeCriticalBackup' || name === 'writeEventBackup') return {}
      return {}
    },
    rootState: { tomato: { attachTodo: null } },
    state: { recycleList: [row('a', { delete: true }), row('b', { delete: true })] }
  }
  hardDeleteImpl = (id) => { if (id === 'a') throw new Error('db locked') }
  const r = await todoActions.purgeIds.call(null, ctx, ['a', 'b'])
  assert.deepEqual(r.done, ['b'], 'only the id whose hardDelete succeeded is done')
  assert.deepEqual(r.failed, ['a'], 'the failed id is reported back')
})

test('qc1 purgeIds reports all-failed when every hardDelete throws', async () => {
  const ctx = {
    commit: () => {},
    dispatch: async () => ({}),
    rootState: { tomato: { attachTodo: null } },
    state: { recycleList: [row('x', { delete: true })] }
  }
  hardDeleteImpl = () => { throw new Error('db locked') }
  const r = await todoActions.purgeIds.call(null, ctx, ['x'])
  assert.deepEqual(r.done, [])
  assert.deepEqual(r.failed, ['x'])
})
