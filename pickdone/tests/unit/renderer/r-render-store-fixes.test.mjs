/**
 * Agent R (renderer store domain) — regression tests for the 2026-10-09 fix wave.
 *
 * Covers (one test group per fix, symptom → root cause → assertion):
 *   1. undo.js: historyUndoPop now breaks the 400ms chained-merge window (a post-undo edit used
 *      to merge into the WRONG stack top, overwriting the older snapshot and making undo a no-op).
 *   2. tomato.js: giveUp releases its phase claim when booking throws (ledgerWrite quota failure);
 *      completeFocus re-verifies the shared phase for FREE focuses too (check moved out of the
 *      `if (focused && ...)` block).
 *   3. tomatoPendingQueue.js: tomatoAppendMany entries carry an enqueue-time updatedAt stamp so a
 *      replayed append loses the db-layer tombstone arbitration instead of resurrecting deletions.
 *   4. settings.js: initFromDb write-back stamps _savedAt with the LS content's own age (lsAt),
 *      not the stale db._savedAt.
 *   5. habits.js: relayAuxBlob keeps the ping (quarantine path) on a corrupt LS blob; replaceAll
 *      strips the internal `force` flag before persisting.
 *   6. tomato.js: syncFromStorage treats _syncSeq as a per-window key (peer blob cannot regress it).
 *   7. main.js: the CLI tomato `start` handler awaits startFocus/attach before the receipt timer.
 *
 * Run: node --test tests/unit/renderer/r-render-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const LS = globalThis.localStorage

/* ---------------- 1. undo merge-window ---------------- */
const undoMod = await import('../../../renderer/js/store/helpers/undo.js')
const { historyPush, historyBreakMerge, historyUndoPop } = undoMod
const snapOf = rows => JSON.stringify({ todoList: rows, recycleList: [] })
const freshHistState = () => ({ undoStack: [], redoStack: [], _histBytes: 0, _histEpoch: 0, _histLastPushAt: 0 })

test('R1: historyUndoPop breaks the 400ms merge window (post-undo edit starts a fresh step)', () => {
  const s = freshHistState()
  const S1 = snapOf([{ taskId: 'a', v: 1 }])
  historyPush(s, S1)
  historyBreakMerge(s) // discrete op: second push is a fresh entry even inside the window
  historyPush(s, snapOf([{ taskId: 'a', v: 2 }]))
  assert.equal(s.undoStack.length, 2)
  // simulate "undo ran right after the last push": the pre-fix bug is that _histLastPushAt still
  // holds the popped entry's push time
  s._histLastPushAt = Date.now()
  historyUndoPop(s) // undo → the S1 snapshot is now the stack top
  assert.equal(s._histLastPushAt, 0, 'undo must zero the merge-window stamp')
  // immediate edit after the undo
  historyPush(s, snapOf([{ taskId: 'a', v: 3 }]))
  assert.equal(s.undoStack.length, 2, 'the post-undo edit must be a FRESH entry, not a merge into S1')
  assert.deepEqual(JSON.parse(s.undoStack[0]).todoList, [{ taskId: 'a', v: 1 }], 'the revealed S1 snapshot must not be overwritten')
  // second undo lands on the intermediate state (pre-fix the stack was fused and this was a no-op)
  historyUndoPop(s)
  assert.equal(s.undoStack.length, 1)
  assert.deepEqual(JSON.parse(s.undoStack[0]).todoList, [{ taskId: 'a', v: 1 }])
})

/* ---------------- 2. tomato giveUp / completeFocus ---------------- */
const tomato = (await import('../../../renderer/js/store/tomato.js')).default
const queueMod = await import('../../../renderer/js/store/helpers/tomatoPendingQueue.js')
const CLAIM_KEY = 'tomatoLastPhaseDone'
const TOMATO_LS = 'tomatoState'
const tomatoCtx = state => ({
  state,
  commit (type, p) { tomato.mutations[type](state, p) },
  dispatch () { return Promise.resolve() }
})

test('R2a: giveUp releases the phase claim when the ledger booking throws (no phantom succeed)', async () => {
  const startedAt = Date.now() - 61000
  const state = {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, remainSec: 1500,
    attachTodo: null, enableNotification: false, todayTomatoCount: 0,
    tomatoRecordList: [], _countDate: new Date().toISOString().slice(0, 10), phaseTs: startedAt
  }
  LS.removeItem(CLAIM_KEY)
  LS.removeItem(TOMATO_LS)
  const origSetItem = LS.setItem
  LS.setItem = (k, v) => { if (String(k).startsWith('tomatoPendingLedger.')) throw new Error('quota exceeded') ; return origSetItem.call(LS, k, v) }
  try {
    const ctx = tomatoCtx(state)
    await assert.rejects(
      tomato.actions.giveUp.call(ctx, ctx, { record: true, reason: 'test' }),
      /quota exceeded/,
      'the booking failure must surface (loud), not vanish'
    )
    assert.notEqual(LS.getItem(CLAIM_KEY), 'startTomatoTime:' + startedAt, 'the phase claim must be released (30s lease would otherwise book a succeed tomato)')
    assert.ok(!state.tomatoRecordList.some(r => r && r.succeed === true), 'no succeed record may be booked from the failed giveUp')
  } finally {
    LS.setItem = origSetItem
    LS.removeItem(CLAIM_KEY)
    LS.removeItem(TOMATO_LS)
  }
})

test('R2b: completeFocus re-verifies the shared phase for FREE focuses (abort when given up concurrently)', async () => {
  const startedAt = Date.now() - 500
  const state = {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, remainSec: 1500,
    attachTodo: null, enableNotification: false, todayTomatoCount: 0,
    tomatoRecordList: [], _countDate: new Date().toISOString().slice(0, 10), phaseTs: startedAt
  }
  LS.removeItem(CLAIM_KEY)
  // concurrent giveUp(record=false) in another window flipped the shared transient to default —
  // a real give-up goes through persistState, so the blob carries a write stamp DURING our phase
  // (r-fix: the stamp is the evidence; a stale pre-phase mirror without a stamp must not abort)
  LS.setItem(TOMATO_LS, JSON.stringify({ status: 'default', startedAt: 0, tomatoTime: 25, restTime: 5, remainSec: 1500, _persistTs: Date.now() }))
  const ctx = tomatoCtx(state)
  await tomato.actions.completeFocus.call(ctx, ctx)
  assert.ok(!state.tomatoRecordList.some(r => r && r.succeed === true), 'a free focus whose phase was concurrently given up must NOT be booked as succeed')
  assert.notEqual(LS.getItem(CLAIM_KEY), 'startTomatoTime:' + startedAt, 'the claim is released on abort')
  assert.equal(state.status, 'startTomatoTime', 'the aborted completion does not flip the phase (the give-up side owns it)')
})

/* ---------------- 3. pending append enqueue-time stamp ---------------- */
test('R3: tomatoAppendMany entries are stamped with the enqueue-time updatedAt (tombstone arbitration)', () => {
  const state = { tomatoRecordList: [], todayTomatoCount: 0 }
  tomato.mutations.addRecord(state, {
    tomatoId: 'tmt_f_1700000000000_r3', endTime: Date.now(), dateKey: '2026-10-09',
    focus: '', focusTaskId: null, focusDuration: 25, rest: 5, restDuration: 5, succeed: true, status: 'local'
  })
  // the LS mirror entry (what a crash/quit-flush replay round-trips) must carry the stamp
  const keys = []
  for (let i = 0; i < LS.length; i++) { const k = LS.key(i); if (k && k.startsWith('tomatoPendingLedger.')) keys.push(k) }
  const entryKey = keys.find(k => k.includes('-') && JSON.parse(LS.getItem(k)).entry.op === 'tomatoAppendMany' &&
    JSON.parse(LS.getItem(k)).entry.params.tomatoId === 'tmt_f_1700000000000_r3')
  assert.ok(entryKey, 'the append entry was mirrored')
  const packed = JSON.parse(LS.getItem(entryKey)).entry
  assert.equal(packed.params.updatedAt, packed.ts, 'replay carries the ENQUEUE-time stamp, so a tombstone with a later deletedAt wins the arbiter')
  // the db layer's arbiter (`excluded.updatedAt >= deletedAt`) with an OLDER tombstone T:
  //   stamp (= enqueue ts) < T → the update is gated, the deleted record stays deleted.
  const tombstoneAt = Date.now() + 5000
  assert.ok(packed.params.updatedAt < tombstoneAt, 'a peer tombstone newer than the enqueue stamp arbitrates over the replayed append')
  LS.removeItem(entryKey)
})

test('R3b: hydrate stamps legacy append entries that lack updatedAt (restart replay keeps the old stamp)', () => {
  const ts = Date.now() - 5000
  // legacy WHOLE-blob mirror key (pre per-entry format): the one-time migration re-saves each
  // entry through savePendingEntry, so the stamped params are observable in the per-key mirror
  LS.setItem('tomatoPendingLedger', JSON.stringify({
    v: 1,
    entries: [{ op: 'tomatoAppendMany', seq: 1, ts, uid: 'legacy-r3', params: { tomatoId: 'tmt_f_legacy_r3', endTime: ts, dateKey: '2026-10-09', succeed: true } }]
  }))
  queueMod.hydratePendingQueues()
  const packed = JSON.parse(LS.getItem('tomatoPendingLedger.legacy-r3')).entry
  assert.equal(packed.params.updatedAt, ts, 'the revived entry replays with its ORIGINAL authoring stamp, not db-now')
  assert.equal(LS.getItem('tomatoPendingLedger'), null, 'the legacy blob was migrated')
  LS.removeItem('tomatoPendingLedger.legacy-r3')
})

/* ---------------- 4. settings write-back stamp ---------------- */
const settingsMod = (await import('../../../renderer/js/store/settings.js')).default
const dbMirror = await import('../../../renderer/js/utils/dbMirror.js')

test('R4: settings.initFromDb write-back stamps _savedAt with the LS content age (no stale gate)', async () => {
  const KEY = 'db.settingsState'
  LS.removeItem('dbMirror.unflushed.' + KEY)
  const lsAt = Date.now() - 1000
  LS.setItem('settingsMirrorAt', String(lsAt))
  const mirrored = []
  const origApi = globalThis.window.todoAPI
  globalThis.window.todoAPI = {
    dbCall (op, p) {
      if (op === 'getMeta') return Promise.resolve(JSON.stringify({ _savedAt: lsAt - 60000, theme: 'old-db' }))
      if (op === 'setMeta') mirrored.push(p)
      return Promise.resolve('ok')
    }
  }
  const savedTiming = { ...dbMirror._timing }
  dbMirror._timing.debounceMs = 5
  try {
    const state = { theme: 'fresh-ls' }
    const ctx = { state, commit () {}, dispatch () { return Promise.resolve() } }
    await settingsMod.actions.initFromDb.call(ctx, ctx)
    await new Promise(r => setTimeout(r, 40))
    assert.ok(mirrored.length >= 1, 'the write-back branch mirrored the LS content to the DB')
    const blob = JSON.parse(mirrored[0][1])
    assert.equal(blob.theme, 'fresh-ls', 'the write-back carries the newer LS content')
    assert.ok(blob._savedAt >= lsAt, 'content and stamp advance together: _savedAt must be >= the LS snapshot time (a mid-gap peer blob can no longer compress over the local settings)')
    assert.ok(blob._savedAt <= Date.now(), 'and not re-aged beyond the real snapshot (anti-re-age gate semantics preserved)')
  } finally {
    Object.assign(dbMirror._timing, savedTiming)
    globalThis.window.todoAPI = origApi
  }
})

/* ---------------- 5. habits relay / replaceAll ---------------- */
const habits = await import('../../../renderer/js/store/habits.js')
const SYNC_KEY = 'habitsSyncPing'
const HABITS_LS = 'habitsState'

test('R5a: relayAuxBlob KEEPS the ping when the LS blob is corrupt (quarantine, not silent drop)', () => {
  habits.onExternalHabitBlob(null)
  LS.setItem(HABITS_LS, '{"habits": [BROKEN')
  LS.setItem(SYNC_KEY, 'ping-r5a')
  habits._testInternals.relayAuxBlob()
  assert.equal(LS.getItem(SYNC_KEY), 'ping-r5a', 'a corrupt blob must not consume the aux check-in ping')
  // healthy-absent blob: consuming the ping is correct (nothing to relay)
  LS.removeItem(HABITS_LS)
  LS.setItem(SYNC_KEY, 'ping-r5a-2')
  habits._testInternals.relayAuxBlob()
  assert.equal(LS.getItem(SYNC_KEY), null, 'a MISSING blob still consumes the ping (nothing to relay)')
})

test('R5b: replaceAll strips the internal `force` flag from the persisted blob', () => {
  const s = { habits: [], moments: [], savedAt: 0 }
  const origApi = globalThis.window.todoAPI
  globalThis.window.todoAPI = undefined // keep the persist path LS-only and synchronous
  try {
    habits.default.mutations.replaceAll(s, { force: true, savedAt: Date.now(), habits: [{ id: 'h1', name: 'x', records: {} }], moments: [] })
    assert.equal(s.habits.length, 1, 'force still applies the blob to state')
    const persisted = JSON.parse(LS.getItem(HABITS_LS))
    assert.ok(!('force' in persisted), 'the control flag must never reach LS/DB or the sync fan-out')
  } finally {
    globalThis.window.todoAPI = origApi
  }
})

/* ---------------- 6. _syncSeq per-window key ---------------- */
test('R6: syncFromStorage does not let a peer blob regress the local _syncSeq', () => {
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)
  const s = {
    status: 'default', startedAt: 0, remainSec: 1500, phaseTs: now - 600000,
    tomatoTime: 25, restTime: 5, todayTomatoCount: 0, tomatoRecordList: [],
    _countDate: today, _syncSeq: 10
  }
  LS.setItem(TOMATO_LS, JSON.stringify({
    status: 'startTomatoTime', startedAt: now - 5000, tomatoTime: 25, restTime: 5,
    remainSec: 1500, phaseTs: now - 4000, _syncSeq: 3
  }))
  LS.setItem('tomatoSyncPing', 'ping-r6')
  tomato.mutations.syncFromStorage(s)
  assert.equal(s._syncSeq, 10, 'the per-window write counter must not be overwritten by the peer blob')
  assert.equal(s.status, 'startTomatoTime', 'the (non-local) phase fields still sync')
})

/* ---------------- 7. CLI tomato start receipt ---------------- */
test('R7: the CLI `start` handler awaits startFocus/attach so the 150ms receipt reflects the running phase', () => {
  const src = readFileSync(new URL('../../../renderer/js/main.js', import.meta.url), 'utf8')
  assert.match(src, /await store\.dispatch\('tomato\/startFocus'\)/, 'startFocus must be awaited before the receipt timer fires')
  assert.match(src, /if \(cmd\.taskId\) await store\.dispatch\('tomato\/attach', cmd\.taskId\)/, 'attach must be awaited before the receipt timer fires')
})
