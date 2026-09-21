/**
 * Round-5 P0 regression: undo/redo across a preserveHistory reload (inbound LAN-sync round) must not
 * tombstone peer-created tasks. The undo/redo stacks survive the reload (preserveHistory:true) but used
 * to hold whole-table snapshots taken BEFORE the peer's rows arrived; persistSnapshotDiffCore then wrote
 * delete:true rows for ids present in the DB but absent from the stale snapshot baseline — and the next
 * sync round propagated the deletion to the peer. Cross-device data loss.
 * Fix: reload-epoch tagging (`_e`) + a BARRIER snapshot pushed after the reload; the from-only delete
 * loop runs only when the popped entry's epoch matches the current reload epoch.
 * Run: node --test tests/unit/store/round5-p0-undo-reload-epoch.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  historyPush, historyBarrierCore, historyUndoPop, historyRedoPush,
  persistSnapshotDiffCore, undoStep
} from '../../../renderer/js/store/undo.js'

const snapOf = s => JSON.stringify({ todoList: s.todoList, recycleList: s.recycleList })

function makeState (rows) {
  return {
    todoList: rows, recycleList: [],
    undoStack: [], redoStack: [],
    _histBytes: 0, _histRedoBytes: 0, _histLastPushAt: 0, _histEpoch: 0
  }
}

/** Wire undoStep to a real (pure-function) state object with a persist collector — no Vuex. */
function makeCtx (s, persisted) {
  return {
    state: s,
    commit (m, p) {
      if (m === 'historyUndoPop') historyUndoPop(s)
      else if (m === 'historyRedoPush') historyRedoPush(s, p)
      else if (m === 'historyRestore') { s.todoList = p.todoList; s.recycleList = p.recycleList }
      else if (m === 'historyPushKeepRedo') { s.undoStack.push(p) } // length bookkeeping not needed here
    },
    dispatch (action, payload) {
      if (action === 'persistSnapshotDiff') {
        return persistSnapshotDiffCore({ commit: () => {} }, payload, row => persisted.push(row))
      }
      return Promise.resolve()
    }
  }
}

test('R5-P0: undo across a preserveHistory reload does NOT tombstone the peer-created task', async () => {
  const A1 = { taskId: 'A', taskContent: 'a v1', updateTime: 1000, version: 1, delete: false }
  const s = makeState([JSON.parse(JSON.stringify(A1))])
  // 1. Local edit history BEFORE the inbound sync: snapshot taken of A-only table (stale baseline)
  historyPush(s, snapOf(s))
  assert.equal(s.undoStack.length, 1)

  // 2. Peer creates task B; LAN-sync applies it and reloads with preserveHistory → barrier
  const B = { taskId: 'B', taskContent: 'peer task', updateTime: 2000, version: 3, delete: false }
  s.todoList = [JSON.parse(JSON.stringify(A1)), B]
  historyBarrierCore(s)
  assert.equal(s._histEpoch, 1, 'barrier bumps the reload epoch')
  assert.equal(s.redoStack.length, 0, 'barrier clears the (meaningless) redo stack')
  assert.equal(JSON.parse(s.undoStack.at(-1))._e, 1, 'barrier entry is tagged with the new epoch')

  // 3. User edits A locally after the reload (snapshot pushed BEFORE the edit, like subscribeAction), then hits undo twice
  const A2 = { ...A1, taskContent: 'a v2', updateTime: 3000, version: 2 }
  historyPush(s, snapOf(s)) // pre-edit snapshot
  s.todoList = [A2, JSON.parse(JSON.stringify(B))]
  assert.equal(JSON.parse(s.undoStack.at(-1))._e, 1, 'post-barrier pushes carry the current epoch')

  const persisted = []
  const ctx = makeCtx(s, persisted)

  // First undo: pops the post-barrier entry → restores A v1; B untouched, no deletes at all
  const r1 = await undoStep(ctx, ctx)
  assert.ok(r1 && r1.ok)
  assert.equal(s.todoList.some(t => t.taskId === 'B'), true, 'B still live in the table after first undo')
  assert.ok(!persisted.some(r => r.taskId === 'B'), 'B never persisted')
  assert.ok(persisted.some(r => r.taskId === 'A' && !r.delete), 'local edit A still undoable (A restored)')

  // Second undo: pops the STALE pre-sync entry (epoch 0 ≠ 1). B must NOT be tombstoned.
  persisted.length = 0
  const r2 = await undoStep(ctx, ctx)
  assert.ok(r2 && r2.ok)
  assert.equal(s.todoList.some(t => t.taskId === 'B'), true, 'B still live in the table after stale undo')
  const bRow = persisted.find(r => r.taskId === 'B')
  assert.equal(bRow, undefined,
    'stale-epoch baseline must not emit a delete:true tombstone for the peer-created id')
})

test('R5-P0: plain offline undo-of-create still soft-deletes (no barrier in session)', async () => {
  const s = makeState([])
  const C = { taskId: 'C', taskContent: 'created', updateTime: 10, version: 0, delete: false }
  // Snapshot taken before the create (untagged → epoch 0 = current, no barrier ever happened)
  historyPush(s, snapOf(s))
  s.todoList = [JSON.parse(JSON.stringify(C))]
  const persisted = []
  const ctx = makeCtx(s, persisted)
  await undoStep(ctx, ctx)
  const del = persisted.find(r => r.taskId === 'C')
  assert.ok(del && del.delete === true && del.version === 0,
    'offline undo-of-create keeps its propagating soft delete (G1 semantics intact)')
})

test('R5-P0: redo stack entries never survive a barrier into a stale epoch', async () => {
  const s = makeState([{ taskId: 'X', taskContent: 'x', updateTime: 1, version: 1, delete: false }])
  historyPush(s, snapOf(s))
  historyRedoPush(s, snapOf(s)) // simulate a leftover redo entry
  s.todoList = [] // peer deleted X; reload
  historyBarrierCore(s)
  assert.equal(s.redoStack.length, 0, 'redo across an inbound sync is voided at the barrier')
})
