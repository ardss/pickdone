/** TQ-5 (2026-10-03) — corrupt pending-queue payloads are quarantined, not destroyed.
 *
 * Invariant under test: a durable queue must not destroy its payload on a parse failure —
 * degradation may stop replay but must preserve the raw bytes (the codebase's own
 * quarantine-first contract: config-store's config.json.bad rename, the sync layer's
 * sync.flushQuarantine.<op> per-op cap). Pre-fix, hydratePendingQueue logged-and-dropped the
 * corrupt blob and the next write's mirror overwrite destroyed the only copy permanently.
 *
 * Run: node --test tests/unit/store/tq5-corrupt-blob-quarantine.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = globalThis.localStorage
const CORRUPT_KEY = 'tomatoPendingLedger.corrupt'

function clearMirror () {
  const keys = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && (k.indexOf('tomatoPendingLedger') === 0 || k.indexOf('tomatoPendingSnow') === 0)) keys.push(k)
  }
  for (const k of keys) LS.removeItem(k)
}

test('tq5: a corrupt per-entry blob is quarantined with its raw bytes and survives later mirror writes', async () => {
  clearMirror()
  const corruptRaw = '{"v":1,"entry":{"seq":7,"op":"tomatoAppendMany","params":{"tomatoId":"tmt_precious"'
  LS.setItem('tomatoPendingLedger.broken-uid', corruptRaw)
  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  try {
    globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
    const { default: tomato } = await import('../../../renderer/js/store/tomato.js?tq5-corrupt')
    // a later enqueue rewrites the mirror — the quarantined bytes must NOT be part of any overwrite
    tomato.mutations.addRecord({ tomatoRecordList: [] }, { tomatoId: 'tmt_tq5', endTime: 1, dateKey: '2026-09-28', focusDuration: 1 })
    await new Promise(r => setTimeout(r, 10))
  } finally {
    console.error = origErr
  }
  assert.equal(LS.getItem('tomatoPendingLedger.broken-uid'), null, 'the corrupt key is dropped from the live mirror')
  let quarantined = []
  try { quarantined = JSON.parse(LS.getItem(CORRUPT_KEY)) || [] } catch (e) { /* empty */ }
  assert.ok(Array.isArray(quarantined) && quarantined.length === 1, 'the corrupt blob is preserved in a quarantine key after hydrate AND after a subsequent mirror write')
  assert.equal(quarantined[0].raw, corruptRaw, 'the RAW bytes outlive the parse failure (manual recovery possible)')
  assert.equal(quarantined[0].key, 'tomatoPendingLedger.broken-uid')
  assert.ok(quarantined[0].ts > 0, 'quarantine carries a timestamp')
  assert.ok(errs.some(t => t.includes('corrupt')), 'the degradation is still logged')
})

test('tq5[b]: the quarantine is capped (newest kept) — it cannot become a quota-abuse vector', async () => {
  clearMirror()
  const items = []
  for (let i = 0; i < 14; i++) items.push({ key: 'k' + i, ts: i, raw: 'blob-' + i })
  LS.setItem(CORRUPT_KEY, JSON.stringify(items))
  LS.setItem('tomatoPendingLedger.broken', '{oops') // a corrupt LEDGER entry appends into its cap
  globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
  await import('../../../renderer/js/store/tomato.js?tq5-cap')
  const quarantined = JSON.parse(LS.getItem(CORRUPT_KEY))
  assert.equal(quarantined.length, 10, 'capped at 10 quarantined blobs (14 seeded + 1 appended → oldest dropped)')
  assert.equal(quarantined[quarantined.length - 1].raw, '{oops', 'the newest entry is kept')
})

test('tq5[c]: a corrupt LEGACY whole-blob key is quarantined the same way (single shared parse site covers both)', async () => {
  clearMirror()
  const legacyRaw = '{"v":1,"entries":[{"seq":3,' // truncated
  LS.setItem('tomatoPendingLedger', legacyRaw)
  const errs = []
  const origErr = console.error
  console.error = (...a) => { errs.push(a.join(' ')) }
  try {
    globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
    await import('../../../renderer/js/store/tomato.js?tq5-legacy')
  } finally {
    console.error = origErr
  }
  const quarantined = JSON.parse(LS.getItem(CORRUPT_KEY))
  assert.ok(quarantined.some(q => q.raw === legacyRaw), 'the corrupt legacy blob\'s bytes are preserved')
  assert.equal(LS.getItem('tomatoPendingLedger'), null, 'the legacy key is retired after quarantine')
})

test('tq5[d]: the quarantine itself honors the invariant — a rotted quarantine file keeps its bytes (quarantine-of-quarantine)', async () => {
  clearMirror()
  for (const k of ['corruptQuarantine.tomato.quarantine', 'corruptQuarantine.tomato.quarantine.bad']) LS.removeItem(k)
  // pre-fix behavior: quarantineAppend's `catch { parked = [] }` on a rotted quarantine file
  // destroyed the previously quarantined payloads with a setItem overwrite.
  LS.setItem(CORRUPT_KEY, '{rotted-quarantine')
  LS.setItem('corruptQuarantine.tomato.quarantine', '{rotted-quarantine-of-quarantine')
  LS.setItem('tomatoPendingLedger.broken2', '{also-broken')
  globalThis.window.todoAPI = { dbCall: async () => ({ accepted: 1, rejected: [] }) }
  await import('../../../renderer/js/store/tomato.js?tq5-selfrot')
  assert.equal(LS.getItem('corruptQuarantine.tomato.quarantine.bad'), '{rotted-quarantine-of-quarantine',
    'the rotted quarantine-of-quarantine file keeps its RAW bytes under the .bad sibling instead of being discarded')
  const q2 = JSON.parse(LS.getItem('corruptQuarantine.tomato.quarantine'))
  assert.ok(Array.isArray(q2) && q2.some(e => e.raw === '{rotted-quarantine'),
    'the rotted quarantine file keeps its own raw bytes in the shared quarantine')
  const fresh = JSON.parse(LS.getItem(CORRUPT_KEY))
  assert.ok(Array.isArray(fresh) && fresh.length === 1, 'a fresh readable quarantine started')
  assert.equal(fresh[0].raw, '{also-broken', 'the new corrupt entry still landed after the self-rot quarantine')
})
