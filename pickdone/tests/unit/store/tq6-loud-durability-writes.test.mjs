/** TQ-6 (2026-10-03) — durability writes are loud at the single write seam.
 *
 * Invariants under test:
 *  [a] a ledger entry whose quarantine write throws is NOT retired — "no entry retired until it
 *      exists durably somewhere" is structural (the quarantine runs BEFORE the splice);
 *  [b] a failed persistState blob write latches the observable degraded flag instead of dying
 *      silently (the transient blob is loud-degradation, not fail-silent).
 *
 * Run: node --test tests/unit/store/tq6-loud-durability-writes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = globalThis.localStorage
const LEDGER_PREFIX = 'tomatoPendingLedger.'
const REJECTED_KEY = 'tomatoRejectedLedgerRows'

function mirrorCount () {
  let n = 0
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.indexOf(LEDGER_PREFIX) === 0 && k !== LEDGER_PREFIX + 'corrupt') n += 1
  }
  return n
}

test('tq6[a]: a throwing quarantine write keeps the ledger entry pending (retire-only-if-durable)', async () => {
  for (const k of Array.from({ length: LS.length }, (_, i) => LS.key(i)).filter(Boolean)) LS.removeItem(k)
  let failQuarantine = false
  const origSetItem = LS.setItem
  LS.setItem = (k, v) => {
    if (failQuarantine && k === REJECTED_KEY) throw new Error('quota exceeded')
    return origSetItem.call(LS, k, v)
  }
  try {
    // the db reports the row as REJECTED (structurally unacceptable) — settleLedgerEntry
    // quarantines it BEFORE splicing; with the quarantine write failing, the entry must stay.
    failQuarantine = true
    globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 0, rejected: [{ index: 0, reason: 'bad endTime' }] }) }
    const { default: tomato, tomatoMirrorDegraded } = await import('../../../renderer/js/store/tomato.js?tq6-quarantine')
    tomato.mutations.addRecord({ tomatoRecordList: [], todayTomatoCount: 0 }, { tomatoId: 'tmt_tq6_rej', endTime: 0, dateKey: '2026-09-28', succeed: true })
    await new Promise(r => setTimeout(r, 20))
    let quarantined = []
    try { quarantined = JSON.parse(LS.getItem(REJECTED_KEY)) || [] } catch (e) { /* empty */ }
    assert.equal(quarantined.length, 0, 'the quarantine write failed loudly — nothing pretending to be parked')
    assert.equal(mirrorCount(), 1, 'THE INVARIANT: the entry is NOT retired — it stays pending with its LS mirror (pre-fix it existed nowhere)')

    // recovery: quarantine writes work again → the next write replays and settles normally
    failQuarantine = false
    globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
    tomato.mutations.addRecord({ tomatoRecordList: [], todayTomatoCount: 0 }, { tomatoId: 'tmt_tq6_ok', endTime: 2, dateKey: '2026-09-28', succeed: true })
    await new Promise(r => setTimeout(r, 20))
    assert.equal(mirrorCount(), 0, 'after recovery the queue drains (the previously stuck entry replays and retires)')
  } finally {
    LS.setItem = origSetItem
  }
})

test('tq6[b]: a failed persistState blob write latches the observable degraded flag', async () => {
  for (const k of Array.from({ length: LS.length }, (_, i) => LS.key(i)).filter(Boolean)) LS.removeItem(k)
  const origSetItem = LS.setItem
  let failBlob = false
  LS.setItem = (k, v) => {
    if (failBlob && k === 'tomatoState') throw new Error('quota exceeded')
    return origSetItem.call(LS, k, v)
  }
  try {
    const { default: tomato, tomatoMirrorDegraded } = await import('../../../renderer/js/store/tomato.js?tq6-persist')
    assert.equal(tomatoMirrorDegraded(), false, 'healthy at import')
    failBlob = true
    const errs = []
    const origErr = console.error
    console.error = (...a) => { errs.push(a.join(' ')) }
    try {
      tomato.mutations.patch({ status: 'default' }, { remainSec: 123 }) // persistState throws pre-fix / fails silently via safeSet
    } finally {
      console.error = origErr
    }
    assert.equal(tomatoMirrorDegraded(), true, 'THE INVARIANT: the unhealthy mirror is observable (latched degraded flag)')
    assert.ok(errs.some(t => t.includes('degraded')), 'the degradation is loud, not a swallowed boolean')
  } finally {
    LS.setItem = origSetItem
  }
})
