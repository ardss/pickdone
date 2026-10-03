/** TQ-2 (2026-10-03) — per-entry LS mirror keys replace the last-writer-wins whole blobs.
 *
 * Invariant under test: the crash-proof mirror tracks EVERY window's memory, not just the last
 * writer's. The store module loads in two same-origin renderer processes (main window + float
 * window) sharing localStorage; the old savePendingQueues rewrote the ENTIRE blob from the
 * calling process's private array, so B's enqueue/settle erased A's pending entry and A's crash
 * lost the earned record permanently. Per-entry keys (`<prefix><uid>`, uid = random, NOT the
 * process-local seq) make writes put-own-key and settlements delete-own-key.
 *
 * Run: node --test tests/unit/store/tq2-pending-mirror-per-entry.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LEDGER_PREFIX = 'tomatoPendingLedger.'
const LS = globalThis.localStorage

function clearMirror () {
  const keys = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && (k.indexOf(LEDGER_PREFIX) === 0 || k === 'tomatoPendingLedger')) keys.push(k)
  }
  for (const k of keys) LS.removeItem(k)
}

function mirrorEntries (prefix) {
  const out = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.indexOf(prefix) === 0) { try { out.push(JSON.parse(LS.getItem(k)).entry) } catch (e) { /* skip */ } }
  }
  return out
}

test('tq2: a peer window settling its own queue can no longer erase this window\'s pending entry', async () => {
  clearMirror()
  // The defect's exact topology: BOTH windows hydrate (empty) BEFORE A's entry exists; A's db is
  // unreachable for its write, B's is fine. No re-sync after hydrate — each instance only knows
  // its own array.
  const dbDown = new Set(['tmt_tq2_A'])
  globalThis.window.todoAPI = { dbCall: async (op, p) => {
    if (p && dbDown.has(p.tomatoId)) throw new Error('A: db down')
    return { accepted: 1, rejected: [] }
  } }

  // Window A: enqueue a ledger entry that stays pending (db unreachable for it).
  const modA = await import('../../../renderer/js/store/tomato.js?tq2-winA')
  modA.default.mutations.addRecord({ tomatoRecordList: [] }, { tomatoId: 'tmt_tq2_A', endTime: 1, dateKey: '2026-09-28', focusDuration: 25 })
  await new Promise(r => setTimeout(r, 10))

  // Window B: an independent module instance (hydrated empty, separate private array, SAME LS).
  const modB = await import('../../../renderer/js/store/tomato.js?tq2-winB')
  modB.default.mutations.addRecord({ tomatoRecordList: [] }, { tomatoId: 'tmt_tq2_B', endTime: 2, dateKey: '2026-09-28', focusDuration: 5 })
  await new Promise(r => setTimeout(r, 10)) // B's entry settles (db ok) and retires via delete-own-key

  // THE INVARIANT (fails pre-fix: B's whole-blob save rewrote the blob from B's array, dropping A):
  const surviving = mirrorEntries(LEDGER_PREFIX).map(e => e.params && e.params.tomatoId)
  assert.deepEqual(surviving, ['tmt_tq2_A'], 'A\'s pending entry survives B\'s enqueue+settle (put-own-key / delete-own-key)')

  // A "crashes" (process dies without any further writes) → rehydrate in a fresh instance:
  const seen = []
  globalThis.window.todoAPI = { dbCall: async (op, p) => { seen.push(p && p.tomatoId); return { accepted: 1, rejected: [] } } }
  const modC = await import('../../../renderer/js/store/tomato.js?tq2-restart')
  modC.default.mutations.addRecord({ tomatoRecordList: [] }, { tomatoId: 'tmt_tq2_trigger', endTime: 3, dateKey: '2026-09-28', focusDuration: 1 })
  await new Promise(r => setTimeout(r, 20))
  assert.ok(seen.includes('tmt_tq2_A'), 'the survived entry replays into the db after the crash (the earned record is not lost)')
  assert.equal(mirrorEntries(LEDGER_PREFIX).length, 0, 'the queue drains after a full replay')
})

test('tq2[b]: the legacy whole-blob mirror is migrated once into per-entry keys', async () => {
  clearMirror()
  LS.setItem('tomatoPendingLedger', JSON.stringify({ v: 1, entries: [
    { seq: 9, ts: Date.now(), op: 'tomatoAppendMany', params: { tomatoId: 'tmt_tq2_legacy', endTime: 4, dateKey: '2026-09-28', succeed: true } }
  ] }))
  globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
  await import('../../../renderer/js/store/tomato.js?tq2-legacy')
  assert.equal(LS.getItem('tomatoPendingLedger'), null, 'the legacy blob key is retired after migration')
  const migrated = mirrorEntries(LEDGER_PREFIX)
  assert.equal(migrated.length, 1, 'the legacy entry now lives under its own key')
  assert.equal(migrated[0].params.tomatoId, 'tmt_tq2_legacy')
  assert.ok(migrated[0].uid, 'the migrated entry carries a random uid (not a process-local seq)')
})
