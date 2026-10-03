/* D15 domain-1 regressions: renderer todo pending-write queue + existence authority + purge/undo invariant.
 * [TL-1] terminal-vs-transient replay classification: a stale-batch entry and a UNIQUE-loser entry
 *        reach a terminal state on replay (the queue empties instead of looping forever).
 * [TL-2] queue durability: a queued entry survives a simulated renderer restart (localStorage
 *        mirror + boot hydration) and is replayed by the boot drain.
 * [TL-4] replay freshness gate: a queued entry whose rows are strictly older than the durable
 *        store's stamps is not re-dispatched verbatim.
 * [TL-5] durable-store existence authority: updateTodoFields resolves a memory-miss row via
 *        getById and lands the edit; a DB-absent taskId yields a structured not-found.
 * [TL-6] purge/undo invariant: undo across a purge never durably writes a purged id, the purged
 *        row leaves the restored in-memory table, and a purge installs a historyBarrier (not a
 *        whole-stack historyClear).
 * Run: node --test tests/unit/renderer/todoPendingUpserts.test.js
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const QKEY = 'todoPendingUpserts'

test('[TL-1a] a stale-batch queue entry reaches a terminal state on replay (no doom loop)', async () => {
  localStorage.removeItem(QKEY)
  let dispatches = 0
  globalThis.window.todoAPI = {
    dbCall: async (op) => {
      if (op === 'getAll') return [] // freshness gate: no stamps known
      dispatches++
      throw new Error('commitSyncBatch: version 5 < current todosVersion 6 — stale batch rejected')
    },
    onAppQuittingFlush () {}
  }
  const m = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js?tl1a')
  m.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [{ taskId: 'x1', updateTime: 1 }], version: 5 } })
  await m.flushPendingUpserts()
  await sleep(10)
  assert.equal(dispatches, 1, 'the doomed batch was attempted once')
  assert.equal(m.pendingUpserts().length, 0, 'the stale-batch entry was dropped (terminal), not kept')
  await m.flushPendingUpserts()
  await sleep(10)
  assert.equal(dispatches, 1, 'the second flush does not re-dispatch the terminal entry (queue is empty, not looping)')
})

test('[TL-1b] a UNIQUE-loser entry converts to the winner row on replay instead of looping', async () => {
  localStorage.removeItem(QKEY)
  let loserAttempts = 0
  let winnerWrites = 0
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'getAll') return []
      if (op === 'queryTodos') return [{ taskId: 'winner-1', repeatId: 'r1', updateTime: 9 }]
      if (op === 'upsert' && p.taskId === 'loser-1') { loserAttempts++; throw new Error('UNIQUE constraint failed: todos.index_todos_repeat_day') }
      if (op === 'upsert' && p.taskId === 'winner-1') winnerWrites++
      return 'ok'
    },
    onAppQuittingFlush () {}
  }
  const m = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js?tl1b')
  // The loser carries its OWN distinct taskId, so supersedePendingRow can never match it — exactly
  // the todo.js renewal race shape.
  m.queuePendingUpsert({ op: 'upsert', params: { taskId: 'loser-1', repeatId: 'r1', dayStart: 123, updateTime: 1 } })
  await m.flushPendingUpserts()
  await sleep(10)
  assert.equal(loserAttempts, 1, 'the loser was attempted once')
  assert.equal(winnerWrites, 1, 'the durably-present winner row was adopted and written')
  assert.equal(m.pendingUpserts().length, 0, 'queue drained to terminal state')
  await m.flushPendingUpserts()
  await sleep(10)
  assert.equal(loserAttempts, 1, 'no replay loop: the loser never re-dispatches')
})

test('[TL-2] a queued entry survives a simulated renderer restart and is replayed at boot drain', async () => {
  localStorage.removeItem(QKEY)
  globalThis.window.todoAPI = {
    dbCall: async () => { throw new Error('db down at enqueue time') },
    onAppQuittingFlush () {}
  }
  const m1 = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js?tl2a')
  m1.safeUpsert({ taskId: 'tl2_1', taskContent: 'survives the crash', updateTime: 1 })
  await sleep(10)
  const blob = JSON.parse(localStorage.getItem(QKEY))
  assert.ok(blob && Array.isArray(blob.entries), 'queue mirrored to localStorage')
  assert.ok(blob.entries.some(e => e.params && e.params.taskId === 'tl2_1'), 'the failed write is in the persisted queue')

  // Simulated restart: fresh module instance hydrates; the DB is healthy again. The boot drain
  // (flushPendingUpserts right after todo/init — see main.js) is the primary recovery path.
  const seen = []
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => { seen.push([op, p]); if (op === 'getAll') return []; return 'ok' },
    onAppQuittingFlush () {}
  }
  const m2 = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js?tl2b')
  assert.notEqual(m1, m2, 'sanity: distinct module instance = restart')
  assert.ok(m2.pendingUpserts().some(e => e.params && e.params.taskId === 'tl2_1'), 'the pre-crash entry hydrated into the fresh instance')
  await m2.flushPendingUpserts()
  await sleep(10)
  assert.ok(seen.some(([op, p]) => op === 'upsert' && p.taskId === 'tl2_1'), 'the pre-crash entry is replayed by the boot drain')
  const after = JSON.parse(localStorage.getItem(QKEY))
  assert.ok(!after.entries.some(e => e.params && e.params.taskId === 'tl2_1'), 'the LS mirror drops the entry after successful replay')
})

test('[TL-4] the replay freshness gate skips rows the durable store already supersedes', async () => {
  localStorage.removeItem(QKEY)
  const dispatched = []
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'getAll') return [{ taskId: 'tl4_stale', updateTime: 500 }, { taskId: 'tl4_fresh', updateTime: 1 }]
      dispatched.push([op, p])
      return 'ok'
    },
    onAppQuittingFlush () {}
  }
  const m = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js?tl4')
  // Queued frozen copy: row 1 is strictly older than the DB (a peer edit landed via upsertMany
  // ingress, which never advances todosVersion, so the batch-version fence cannot catch this).
  m.queuePendingUpsert({ op: 'commitSyncBatch', params: { rows: [
    { taskId: 'tl4_stale', updateTime: 100 },
    { taskId: 'tl4_fresh', updateTime: 100 }
  ], version: 7 } })
  await m.flushPendingUpserts()
  await sleep(10)
  const batches = dispatched.filter(([op]) => op === 'commitSyncBatch')
  assert.equal(batches.length, 1, 'the batch was dispatched once')
  assert.deepEqual(batches[0][1].rows.map(r => r.taskId), ['tl4_fresh'],
    'the strictly-older row was gated out; the tie row dispatched (newest-version-wins, ties pass)')
  assert.equal(m.pendingUpserts().length, 0, 'queue drained')

  // Fully-stale entry: removed without any dispatch at all.
  const dispatched2 = []
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'getAll') return [{ taskId: 'tl4_all', updateTime: 999 }]
      dispatched2.push([op, p])
      return 'ok'
    },
    onAppQuittingFlush () {}
  }
  m.queuePendingUpsert({ op: 'upsert', params: { taskId: 'tl4_all', updateTime: 5 } })
  await m.flushPendingUpserts()
  await sleep(10)
  assert.equal(dispatched2.filter(([op]) => op === 'upsert').length, 0, 'a fully superseded entry is not re-dispatched verbatim')
  assert.equal(m.pendingUpserts().length, 0)
})

test('[TL-5] updateTodoFields resolves a memory-miss row from the durable store; a DB-absent id is a structured not-found', async () => {
  const { default: todo } = await import('../../../renderer/js/store/todo.js?tl5')
  const state = todo.state()
  state.todoList = []
  state.recycleList = []
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'getById' && p === 'peer_1') return { taskId: 'peer_1', taskContent: 'peer row', delete: false, updateTime: 5, dayStart: 0 }
      if (op === 'getById' && p === 'ghost') return undefined
      return 'ok' // upsert etc.
    }
  }
  const fakeThis = { _viewsDebounceTimer: 0, state: { todo: state } }
  const ctx = {
    state,
    commit: (m, p) => { if (todo.mutations[m]) todo.mutations[m](state, p) },
    dispatch: () => Promise.resolve()
  }
  // Memory miss + DB hit: the edit must LAND (was: silent undefined — fake success).
  const res = await todo.actions.updateTodoFields.call(fakeThis, ctx, { taskId: 'peer_1', patch: { taskContent: 'edited via durable resolve' } })
  assert.ok(res && !res.notFound, 'the action reports success, not a silent miss')
  assert.equal(res.taskContent, 'edited via durable resolve', 'the patch landed on the resolved row')
  assert.equal(state.todoList[0].taskContent, 'edited via durable resolve', 'the DB row was adopted into local state and edited')
  // Memory miss + DB miss: structured not-found instead of a fake success.
  const res2 = await todo.actions.updateTodoFields.call(fakeThis, ctx, { taskId: 'ghost', patch: { taskContent: 'x' } })
  assert.ok(res2 && res2.notFound === true && res2.taskId === 'ghost', 'DB-absent taskId yields the structured not-found')
})

test('[TL-6a] undo across a purge never durably writes a purged id and drops it from restored memory', async () => {
  const undo = await import('../../../renderer/js/store/helpers/undo.js?tl6a')
  const commits = []
  const writes = []
  globalThis.window.todoAPI = {
    dbCall: async (op) => op === 'getAll' ? [{ taskId: 'live_1', updateTime: 2 }] : 'ok'
  }
  // from = current table (purged row was edited after the snapshot), to = restored snapshot — the
  // diff marks the purged row changed, so the old code would safeUpsert it back from the dead.
  const from = { todoList: [{ taskId: 'live_1', updateTime: 1, dayStart: 0 }, { taskId: 'purged_1', updateTime: 5, dayStart: 0 }], recycleList: [] }
  const to = { todoList: [{ taskId: 'live_1', updateTime: 2, dayStart: 0 }, { taskId: 'purged_1', updateTime: 1, dayStart: 0 }], recycleList: [] }
  const changed = await undo.persistSnapshotDiffCore(
    { commit: (m, p) => commits.push([m, p]) },
    { from, to, allowDeletes: true },
    r => writes.push(r)
  )
  assert.ok(writes.some(r => r.taskId === 'live_1'), 'the live changed row is still upserted (rest of the undo stays functional)')
  assert.ok(!writes.some(r => r.taskId === 'purged_1'), 'INVARIANT: the purged-generation id is never durably written')
  assert.ok(commits.some(([m, p]) => m === 'removeLocal' && p === 'purged_1'), 'the purged row is dropped from the restored in-memory table (memory/DB converge in the same step)')
  assert.ok(!commits.some(([m, p]) => m === 'upsertLocal' && p && p.taskId === 'purged_1'))
  assert.equal(changed.length, 1, 'only the existing row counts as changed')
})

test('[TL-6b] a purge installs a historyBarrier (targeted re-baseline), not a whole-stack historyClear', async () => {
  const { default: todo } = await import('../../../renderer/js/store/todo.js?tl6b')
  const state = todo.state()
  state.todoList = []
  state.recycleList = [{ taskId: 'p_1', taskContent: 'old trash', delete: true, categoryId: 3, updateTime: 1, deletedAt: 1 }]
  const commits = []
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      if (op === 'hardDeleteMany') return (p && p.length ? p : (Array.isArray(p) ? p : []))
      if (op === 'getMeta' || op === 'getAll') return op === 'getAll' ? [] : null
      return 'ok'
    }
  }
  const ctx = {
    state,
    rootState: { tomato: null, settings: { recycleBinAutoDeleteDays: 30 } },
    commit: (m, p) => commits.push([m, p]),
    dispatch: (path) => {
      if (path === 'writeEventBackup') return Promise.resolve(true) // snapshot succeeded
      return Promise.resolve()
    }
  }
  const res = await todo.actions.purgeIds.call({ state: { todo: state } }, ctx, ['p_1'])
  assert.deepEqual(res.done, ['p_1'], 'the purge itself still completes')
  assert.ok(commits.some(([m]) => m === 'historyBarrier'), 'the purge re-baselines history with a barrier')
  assert.ok(!commits.some(([m]) => m === 'historyClear'), 'INVARIANT: the purge no longer wipes the whole undo/redo stack')
})
