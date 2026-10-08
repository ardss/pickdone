/* Tombstone-vs-live silent resurrection fix (2026-10-08): an inbound LIVE todo edit with a
 * strictly newer updatedAt that overwrites a local TOMBSTONE used to resurrect the row with NO
 * trace of the user's deletion (live drill: 10/10 deterministic). LWW winner adjudication is
 * by-design; the fix preserves the deleted row's last content as a terminal recycle-bin
 * conflict copy and counts it in the applied round (conflicts[] → UI toast), via the same
 * minting path as the live-vs-live loser.
 * Executing test over the real applyRowSafe/applyRowInner pipeline (mock hydration cache, same
 * harness shape as fix-20260928-dup-conflict-copy.test.mjs).
 * Run: node --test tests/unit/lan-sync/tomb-copy.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

function tombstoneState () {
  const state = {
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op) { return op === 'getAll' ? [] : null } }
  }
  // The local row is a TOMBSTONE (delete:1) whose last content was 'Deleted while peer edited'
  const local = {
    taskId: 'tid_tomb_1', taskContent: 'Deleted while peer edited', updateTime: 1000,
    delete: 1, deletedAt: 1200, deleted: 1
  }
  const todoMap = new Map([['tid_tomb_1', local]])
  state.applyCache = { todo: id => todoMap.get(String(id)) }
  return state
}

const newerLive = {
  entity: 'todo',
  id: 'tid_tomb_1',
  seq: 9,
  ts: 5000,
  updatedAt: 5000,
  deleted: false,
  deletedAt: 0,
  data: { taskId: 'tid_tomb_1', taskContent: 'Peer edit wins', updateTime: 5000, delete: 0 }
}

test('inbound newer live row over a local tombstone: winner lands AND a tombstoned conflict copy of the old content is minted', () => {
  const state = tombstoneState()
  assert.equal(syncApply.applyRowSafe(state, newerLive), true, 'the strictly newer live row applies (LWW untouched)')
  const copy = state.pendingWrites.todos.find(t => String(t.taskId || '').includes('-conflict-'))
  assert.ok(copy, 'a conflict copy was minted')
  assert.equal(copy.taskContent, 'Deleted while peer edited', 'copy preserves the tombstone last content')
  assert.equal(copy.delete, 1, 'copy is tombstoned (recycle bin, delete-wins keeps it out of the live list)')
  assert.notEqual(copy.taskId, 'tid_tomb_1', 'copy id cannot clobber the winning row')
})

test('the resurrection conflict is counted in the applied round for the UI toast', () => {
  const state = tombstoneState()
  syncApply.applyRowSafe(state, newerLive)
  const round = syncApply.consumeAppliedRound(state)
  assert.ok(round, 'a round summary was produced')
  const conflict = (round.conflicts || []).find(c => c.entity === 'todo')
  assert.ok(conflict, 'round summary reports the todo conflict')
})

test('idempotent: re-applying the same inbound row mints no second copy', () => {
  const state = tombstoneState()
  syncApply.applyRowSafe(state, newerLive)
  state.pendingWrites.todos.splice(0).forEach(t => { state.dbCallFlushed = state.dbCallFlushed || []; state.dbCallFlushed.push(t) })
  const flushed = state.dbCallFlushed
  const origCall = state.db.call.bind(state.db)
  state.db.call = op => (op === 'getAll' ? flushed : origCall(op))
  syncApply.applyRowSafe(state, newerLive)
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 0, 'equivalent committed copy suppresses a second mint')
})

test('identical-content edge: an inbound live row byte-identical to the deleted content spawns no copy', () => {
  const state = tombstoneState()
  const sameContent = {
    ...newerLive,
    data: { taskId: 'tid_tomb_1', taskContent: 'Deleted while peer edited', updateTime: 5000, delete: 0 }
  }
  syncApply.applyRowSafe(state, sameContent)
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 0, 'nothing was lost, no copy')
})

/* ---------- plan/filter twin (2026-10-08): keep the tombstone when the delete is fresher ----------
 * plan/filter tombstones hydrate with data:null (no content to copy into a recycle-bin row), so
 * the todo-style conflict-copy bridge cannot apply. Without the guard, a peer live row that won
 * LWW against the tombstone's (possibly stale) updatedAt resurrected the deleted chip/filter via
 * planAddMany's `ON CONFLICT ... SET deleted=0` — the deletion was lost on BOTH ends. When the
 * local delete is FRESHER than the inbound live edit (deletedAt > updatedAt — the peer authored
 * its edit before our deletion and simply had not seen it), delete-wins keeps the tombstone. */

function planTombstoneState (tombRow) {
  const state = {
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call () { return null } }
  }
  const tombMap = new Map([['pl_tomb_1', tombRow]])
  state.applyCache = { plan: () => null, planTomb: id => tombMap.get(String(id)) }
  return state
}

test('plan chip: a live edit OLDER than the local delete does not resurrect the tombstone (delete-wins)', () => {
  // tombstone carries a stale updatedAt (legacy delete bumped deletedAt but not updatedAt):
  // plain LWW on updatedAt would hand the win to the inbound live row (1100 > 1000)
  const state = planTombstoneState({ id: 'pl_tomb_1', updatedAt: 1000, deletedAt: 1200 })
  const peerEdit = {
    entity: 'plan', id: 'pl_tomb_1', seq: 9, ts: 5000, updatedAt: 1100,
    deleted: false, deletedAt: 0, data: { id: 'pl_tomb_1', taskId: 't1', day: '2026-10-08', mm: 540, updatedAt: 1100 }
  }
  assert.equal(syncApply.applyRowSafe(state, peerEdit), false, 'the tombstone stands (deletion never silently lost)')
  assert.equal(state.pendingWrites.plans.length, 0, 'no resurrecting planAddMany row is buffered')
})

test('plan chip: a strictly NEWER peer live edit still applies (LWW untouched when the delete is older)', () => {
  const state = planTombstoneState({ id: 'pl_tomb_1', updatedAt: 1000, deletedAt: 1200 })
  const peerEdit = {
    entity: 'plan', id: 'pl_tomb_1', seq: 9, ts: 5000, updatedAt: 5000,
    deleted: false, deletedAt: 0, data: { id: 'pl_tomb_1', taskId: 't1', day: '2026-10-08', mm: 540, updatedAt: 5000 }
  }
  assert.equal(syncApply.applyRowSafe(state, peerEdit), true, 'a genuinely newer live edit wins over the older deletion')
  assert.equal(state.pendingWrites.plans.length, 1, 'the winner lands through the bulk buffer')
})

test('filter: same delete-wins shape over a live edit older than the local delete', () => {
  const state = planTombstoneState(null)
  const tombMap = new Map([['7', { id: 7, updatedAt: 1000, deletedAt: 1200 }]])
  state.applyCache = { filter: () => null, filterTomb: id => tombMap.get(String(id)) }
  const peerEdit = {
    entity: 'filter', id: '7', seq: 9, ts: 5000, updatedAt: 1100,
    deleted: false, deletedAt: 0, data: { id: 7, name: 'peer edit', updatedAt: 1100 }
  }
  assert.equal(syncApply.applyRowSafe(state, peerEdit), false, 'the filter tombstone stands')
  assert.equal(state.pendingWrites.filters.length, 0, 'no resurrecting filterPutMany row is buffered')
})
