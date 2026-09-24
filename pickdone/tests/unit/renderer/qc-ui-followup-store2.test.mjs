/**
 * QC follow-up round 2 (renderer store/utils) — behavior regression guards.
 * Fixes covered:
 *   [U-3] lazy estimate migration keeps the legacy blob when a per-task write fails
 *   [U-6] ensureEstimate fetch resolution notifies views listeners (difficulty sort invalidation)
 *   [U-7] trimToCapacity deletes the evicted ids' per-task meta keys
 *   [U-9] redo stack enforces the same HISTORY_BYTES budget as the undo stack
 *   [U-10] habits aux-relay writes DB meta only when applyExternal accepted the blob
 *   [U-11] completeFocus retry does not double-bump todayTomatoCount (idempotent per startedAt)
 * Run: node --test tests/unit/renderer/qc-ui-followup-store2.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const dbCalls = []
const metaStore = new Map()
let failSetMetaFor = null // key-prefix predicate → force setMeta failure

globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') {
      if (failSetMetaFor && failSetMetaFor(params[0])) throw new Error('forced setMeta failure: ' + params[0])
      metaStore.set(params[0], params[1]); return 'ok'
    }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    return 'ok'
  },
  notification: () => {}
}
const callsOf = op => dbCalls.filter(([o]) => o === op).map(([, p]) => p)
const resetCalls = () => { dbCalls.length = 0 }

const tomatoEstimate = await import('../../../renderer/js/utils/tomatoEstimate.js')
const undo = await import('../../../renderer/js/store/helpers/undo.js')
const habits = await import('../../../renderer/js/store/habits.js')

/* ---------- [U-3] legacy blob kept when fan-out fails ---------- */

test('[U-3] initFromDb migration: one failed per-task write keeps the legacy blob (retry next boot)', async () => {
  const stamp = String(Date.now() + 99999)
  metaStore.set('tomatoEstimateState', JSON.stringify({ t3a: 3, t3b: 5 }))
  metaStore.set('tomatoEstimateStateAt', stamp)
  failSetMetaFor = k => k === 'tomatoEstimateState:t3b'
  resetCalls()
  try {
    await tomatoEstimate.initFromDb(['t3a', 't3b'])
    await new Promise(r => setTimeout(r, 20))
    assert.ok(metaStore.has('tomatoEstimateState'), 'legacy blob kept when a fan-out write failed')
    assert.ok(metaStore.has('tomatoEstimateStateAt'), 'legacy timestamp kept alongside the blob')
    assert.equal(metaStore.get('tomatoEstimateState:t3a'), '3', 'the successful key still migrated')
  } finally {
    failSetMetaFor = null
  }
  // all writes succeed → blob is deleted
  resetCalls()
  metaStore.set('tomatoEstimateState', JSON.stringify({ t3c: 2 }))
  metaStore.set('tomatoEstimateStateAt', stamp)
  await tomatoEstimate.initFromDb(['t3c'])
  await new Promise(r => setTimeout(r, 20))
  assert.equal(metaStore.has('tomatoEstimateState'), false, 'legacy blob deleted once every write succeeded')
  assert.equal(metaStore.get('tomatoEstimateState:t3c'), '2', 'per-task key landed before the delete')
})

/* ---------- [U-6] lazy fetch invalidates views (listener notified) ---------- */

test('[U-6] ensureEstimate resolution notifies the views-dirty listener once the value lands', async () => {
  metaStore.set('tomatoEstimateState:u6a', '7')
  const seen = []
  const off = tomatoEstimate.onEstimateFetched((id, n) => seen.push([id, n]))
  tomatoEstimate.ensureEstimate('u6a')
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(seen, [['u6a', 7]], 'listener fires with the fetched value (computeViews trigger wiring)')
  off()
  tomatoEstimate.ensureEstimate('u6b')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(seen.length, 1, 'unsubscribed listener no longer fires')
})

/* ---------- [U-7] trimToCapacity deletes evicted meta keys ---------- */

test('[U-7] capacity trim deletes the per-task meta keys of evicted entries', async () => {
  const { state, MAX_KEYS } = tomatoEstimate._testInternals
  const base = 'u7-' + Date.now() + '-'
  // fill over capacity with plain objects in state, oldest first
  for (let i = 0; i <= MAX_KEYS; i++) state[base + i] = 1
  metaStore.set('tomatoEstimateState:' + base + '0', '1')
  metaStore.set('tomatoEstimateState:' + base + String(MAX_KEYS), '1')
  resetCalls()
  tomatoEstimate.setEstimate(base + 'new', 4) // triggers trim
  assert.equal(state[base + '0'], undefined, 'oldest entry evicted from the mirror')
  assert.equal(metaStore.get('tomatoEstimateState:' + base + '0'), undefined, 'evicted id meta key deleted')
  assert.equal(metaStore.get('tomatoEstimateState:' + base + String(MAX_KEYS)), '1', 'kept id keeps its meta key')
  assert.equal(state[base + 'new'], 4, 'fresh entry stored')
})

/* ---------- [U-9] redo stack byte budget ---------- */

test('[U-9] historyRedoPush evicts redo entries over the byte budget; pop keeps accounting aligned', () => {
  const s = { undoStack: [], redoStack: [], _histBytes: 0, _histRedoBytes: 0 }
  const small = 'x'.repeat(10)
  const big = 'y'.repeat(undo.HISTORY_BYTES) // a single snapshot over the whole budget
  undo.historyRedoPush(s, small)
  undo.historyRedoPush(s, small)
  assert.equal(s.redoStack.length, 2, 'small entries coexist')
  undo.historyRedoPush(s, big)
  assert.equal(s.redoStack.length, 1, 'budget overflow evicted the older redo entries')
  assert.equal(s.redoStack[0], big, 'the newest entry survives')
  assert.equal(s._histRedoBytes, undo.HISTORY_BYTES, 'byte accounting matches the surviving entry')
  undo.historyRedoPop(s)
  assert.equal(s._histRedoBytes, 0, 'pop decrements the accounting')
})

/* ---------- [U-10] aux relay writes DB only for accepted blobs ---------- */

test('[U-10] relayAuxBlob skips the DB meta write when the applier rejects the blob', async () => {
  const blob = { schemaV: 1, habits: [{ id: 'h1', name: 'N', records: {} }], moments: [], savedAt: 5000 }
  // the module reads the bare `localStorage` global (setup.mjs shim), not window.localStorage
  globalThis.localStorage.setItem('habitsState', JSON.stringify(blob))
  resetCalls()
  // applier rejects (stale savedAt)
  habits.onExternalHabitBlob(() => false)
  habits._testInternals.relayAuxBlob()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(callsOf('setMeta').length, 0, 'rejected blob is NOT written to the DB')
  // applier accepts
  habits.onExternalHabitBlob(() => true)
  resetCalls()
  habits._testInternals.relayAuxBlob()
  await new Promise(r => setTimeout(r, 20))
  const metas = callsOf('setMeta')
  assert.equal(metas.length, 1, 'accepted blob is relayed to the DB exactly once')
  assert.equal(metas[0][0], 'db.habitsState', 'durable key used')
  assert.ok(metas[0][1].includes('"savedAt":5000'), 'the accepted blob itself was written (not a stale copy)')
})

const tomatoModule = await import('../../../renderer/js/store/tomato.js')

test('[U-11] todayCountPatch is idempotent per startedAt (retry path counts the focus once)', () => {
  const { todayCountPatch } = tomatoModule
  const s = { todayTomatoCount: 2, _countedFocus: 0 }
  const endTs = Date.now()
  const p1 = todayCountPatch(s, 111, endTs)
  assert.ok(p1, 'first completion of the focus produces a patch')
  assert.equal(p1.todayTomatoCount, 3, 'counter bumped once')
  // simulate the commit landing (patch updates reactive state), then a mid-way failure + retry
  Object.assign(s, p1)
  const p2 = todayCountPatch(s, 111, endTs)
  assert.equal(p2, null, 'retry of the SAME focus (same startedAt) produces no patch — no double bump')
  const p3 = todayCountPatch(s, 222, endTs)
  assert.ok(p3 && p3.todayTomatoCount === 4, 'a NEW focus counts again')
})
