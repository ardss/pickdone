/**
 * perf-purge-ids-unbatched-ipc-loop — regression test.
 *
 * Root cause: purgeIds issued a per-id hardDelete commit, a per-id setEstimate meta.delete, and a
 * per-id delete-todo-files IPC; purgeAllRecycle did the per-file + per-estimate loops too — while
 * the server-side bulk op (hardDeleteMany) already GCs the DB estimate keys and returns the
 * physically-deleted ids.
 *
 * After the fix, purging 200 ids costs: exactly 1 todo/hardDeleteMany commit + 1
 * delete-todo-files-many IPC + 0 meta.delete commits; a missing id is excluded from `done`.
 * Red before the fix: >=3*N todo/meta commits + N file IPCs.
 * Run: node --test tests/unit/store/domainA-purge-batch.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const mkDayjs = ts => {
  const o = {
    format: f => String(ts), valueOf: () => ts,
    startOf: u => u === 'day' ? mkDayjs(0) : o,
    add: () => o, subtract: () => o, isSame: () => false,
    hour: () => ({ minute: () => ({ second: () => ({ valueOf: () => ts }) }) })
  }
  return o
}
globalThis.dayjs = mkDayjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 read-only */ }

const commits = [] // { entity, verb, payload }
const fileIpcs = [] // ('many', ids) | ('single', id)
const MISSING_ID = 'ghost-row'
let fileManySupported = true

globalThis.window = {
  location: { hash: '' },
  dayjs: mkDayjs,
  commands: {
    commit: (entity, verb, payload) => {
      commits.push({ entity, verb, payload })
      if (entity === 'todo' && verb === 'hardDeleteMany') {
        return Promise.resolve(payload.filter(id => id !== MISSING_ID)) // physically-deleted ids
      }
      if (entity === 'todo' && verb === 'hardDelete') {
        return Promise.resolve(payload === MISSING_ID ? [] : [String(payload)])
      }
      return Promise.resolve(null)
    }
  },
  todoAPI: {
    dbCall: () => Promise.resolve(null),
    writeCriticalStateBackup: () => Promise.resolve(),
    deleteTodoFilesRelevant: id => { fileIpcs.push(['single', id]); return Promise.resolve(true) },
    deleteTodoFilesMany: ids => {
      if (!fileManySupported) return Promise.reject(new Error('no such channel'))
      fileIpcs.push(['many', ids]); return Promise.resolve(ids.length)
    },
    purgeRecycleBin: () => Promise.resolve(true)
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions
const { pendingUpserts } = todoMod._testInternals

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: true, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', categoryId: 0, ...over
})

const mkCtx = state => ({
  state,
  commit: () => {},
  dispatch: async () => ({}),
  rootState: {}
})

beforeEach(() => {
  commits.length = 0
  fileIpcs.length = 0
  fileManySupported = true
  pendingUpserts.splice(0, pendingUpserts.length)
})

test('purgeIds: 200 ids + one missing row = 1 hardDeleteMany + 1 files-many + 0 meta.delete; missing id excluded', async () => {
  const ids = []
  for (let i = 0; i < 200; i++) ids.push('p' + i)
  const purgeList = [...ids, MISSING_ID]
  const state = { recycleList: purgeList.map(id => row(id)) }
  const r = await todoActions.purgeIds.call({}, mkCtx(state), purgeList)

  const many = commits.filter(c => c.entity === 'todo' && c.verb === 'hardDeleteMany')
  assert.equal(many.length, 1, 'exactly one bulk hardDeleteMany commit (was 201 per-id commits)')
  const estimateDeletes = commits.filter(c => c.entity === 'meta' && c.verb === 'delete' &&
    String(c.payload).startsWith('tomatoEstimateState:'))
  assert.equal(estimateDeletes.length, 0, 'no per-id ESTIMATE meta.delete — the bulk op owns the DB keys (chip-snapshot clears are separate and expected)')
  const fileMany = fileIpcs.filter(f => f[0] === 'many')
  assert.equal(fileMany.length, 1, 'exactly one delete-todo-files-many IPC')
  assert.deepEqual(fileMany[0][1], r.done.sort(), 'files-many is called once with the done ids')
  assert.equal(fileIpcs.filter(f => f[0] === 'single').length, 0, 'no per-id file IPCs remain')
  assert.ok(!r.done.includes(MISSING_ID), 'missing id must be excluded from done (server returned only physical deletes)')
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0], MISSING_ID)
})

test('purgeIds falls back to per-id hardDelete when the bulk commit rejects wholesale', async () => {
  const orig = globalThis.window.commands.commit
  globalThis.window.commands.commit = (entity, verb, payload) => {
    if (entity === 'todo' && verb === 'hardDeleteMany') return Promise.reject(new Error('legacy bus'))
    return orig(entity, verb, payload)
  }
  const state = { recycleList: [row('a1'), row('a2')] }
  const r = await todoActions.purgeIds.call({}, mkCtx(state), ['a1', 'a2'])
  globalThis.window.commands.commit = orig
  assert.deepEqual(r.done.sort(), ['a1', 'a2'], 'per-id fallback still converges on success')
  assert.equal(r.failed.length, 0)
})

test('purgeAllRecycle: one bulk DB purge + one files-many + 0 meta.delete', async () => {
  const ids = []
  for (let i = 0; i < 50; i++) ids.push('q' + i)
  const state = { recycleList: ids.map(id => row(id)) }
  const ok = await todoActions.purgeAllRecycle.call({}, mkCtx(state))
  assert.equal(ok, true)
  const fileMany = fileIpcs.filter(f => f[0] === 'many')
  assert.equal(fileMany.length, 1, 'one delete-todo-files-many IPC for the whole bin (was 50 per-id IPCs)')
  assert.equal(fileIpcs.filter(f => f[0] === 'single').length, 0, 'no per-id file IPCs remain')
  const metaDeletes = commits.filter(c => c.entity === 'meta' && c.verb === 'delete' &&
    String(c.payload).startsWith('tomatoEstimateState:'))
  assert.equal(metaDeletes.length, 0, 'no per-id ESTIMATE meta.delete on the bulk path')
})

test('degraded host without deleteTodoFilesMany: purge proceeds (optional-channel tolerance)', async () => {
  fileManySupported = false
  delete globalThis.window.todoAPI.deleteTodoFilesMany
  const state = { recycleList: [row('b1')] }
  const r = await todoActions.purgeIds.call({}, mkCtx(state), ['b1'])
  globalThis.window.todoAPI.deleteTodoFilesMany = ids => {
    if (!fileManySupported) return Promise.reject(new Error('no such channel'))
    fileIpcs.push(['many', ids]); return Promise.resolve(ids.length)
  }
  assert.deepEqual(r.done, ['b1'], 'missing optional channel must not fail the purge')
})
