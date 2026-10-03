/**
 * Unit tests for the renderer corrupt-payload quarantine primitive
 * (renderer/js/utils/corrupt-quarantine.js).
 *
 * Invariants under test (preserveCorrupt):
 *   1. The raw bytes of a corrupt payload are stored BEFORE anything overwrites them.
 *   2. The quarantine is bounded: only the newest CORRUPT_QUARANTINE_CAP (10) entries per scope.
 *   3. A rotten quarantine file itself is preserved as raw bytes under the `.bad` sibling
 *      before the append overwrites it (same invariant, one level down).
 *   4. A NON-ARRAY (but JSON-parseable) quarantine value gets the same .bad treatment.
 *   5. Entries carry scope, key, ts and raw, and preserve the payload verbatim (not parsed).
 *   6. Multiple scopes quarantine independently.
 *
 * The module uses the global localStorage, so the test installs a Map-backed fake and
 * never touches a real profile directory.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { preserveCorrupt } = require('../../../renderer/js/utils/corrupt-quarantine.js')

const QCAP = 10
function qKey (scope) { return 'corruptQuarantine.' + scope }

function installFakeLocalStorage () {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
  }
  return store
}

test('quarantine stores the raw bytes of a corrupt payload before anything overwrites them', () => {
  const store = installFakeLocalStorage()
  const RAW = '{"broken": tru' // truncated JSON — the raw bytes, not a parsed value
  preserveCorrupt('outbox', 'item-1', RAW)

  const parked = JSON.parse(store.get(qKey('outbox')))
  assert.equal(parked.length, 1)
  assert.equal(parked[0].raw, RAW, 'the raw bytes are preserved verbatim (never parsed/repaired)')
  assert.equal(parked[0].scope, 'outbox')
  assert.equal(parked[0].key, 'item-1')
  assert.ok(Number.isFinite(parked[0].ts), 'each entry is timestamped')

  preserveCorrupt('outbox', 'item-2', 'garbage')
  assert.equal(JSON.parse(store.get(qKey('outbox'))).length, 2, 'appends accumulate')
})

test('quarantine is bounded to the newest 10 entries per scope', () => {
  const store = installFakeLocalStorage()
  for (let i = 0; i < 25; i++) preserveCorrupt('scope-a', 'k' + i, 'raw-' + i)

  const parked = JSON.parse(store.get(qKey('scope-a')))
  assert.equal(parked.length, QCAP, 'the quarantine never grows past the cap')
  assert.equal(parked[0].raw, 'raw-15', 'the OLDEST entries are dropped (newest kept)')
  assert.equal(parked[QCAP - 1].raw, 'raw-24', 'the newest entry survives')
})

test('a rotten quarantine file is itself preserved under the .bad sibling', () => {
  const store = installFakeLocalStorage()
  const ROTTEN = '{"entries": [' // undecodable quarantine content
  store.set(qKey('outbox'), ROTTEN)

  preserveCorrupt('outbox', 'new', 'raw-new')

  assert.equal(store.get(qKey('outbox') + '.bad'), ROTTEN, 'the rotten quarantine bytes survive at the .bad sibling')
  const parked = JSON.parse(store.get(qKey('outbox')))
  assert.equal(parked.length, 1, 'the append restarts from empty after preserving the rotten bytes')
  assert.equal(parked[0].raw, 'raw-new')
})

test('a NON-ARRAY quarantine value gets the same .bad treatment and appends restart cleanly', () => {
  const store = installFakeLocalStorage()
  store.set(qKey('outbox'), '"just a string"') // parseable, but not an array

  preserveCorrupt('outbox', 'new', 'raw-new')

  assert.equal(store.get(qKey('outbox') + '.bad'), '"just a string"', 'the non-array value is preserved raw')
  const parked = JSON.parse(store.get(qKey('outbox')))
  assert.equal(parked.length, 1)
  assert.equal(parked[0].raw, 'raw-new')
})

test('a subsequent corrupt append after a .bad preservation overwrites .bad with the latest rot only', () => {
  const store = installFakeLocalStorage()
  // First rot -> .bad preserved; second append works; then rot again -> .bad replaced.
  store.set(qKey('s'), 'ROTTEN-1')
  preserveCorrupt('s', 'a', 'raw-a')
  assert.equal(store.get(qKey('s') + '.bad'), 'ROTTEN-1')
  store.set(qKey('s'), 'ROTTEN-2')
  preserveCorrupt('s', 'b', 'raw-b')
  assert.equal(store.get(qKey('s') + '.bad'), 'ROTTEN-2', 'the .bad slot tracks the most recent rot')
  const parked = JSON.parse(store.get(qKey('s')))
  assert.equal(parked.length, 1)
  assert.equal(parked[0].raw, 'raw-b')
})

test('scopes quarantine independently', () => {
  const store = installFakeLocalStorage()
  preserveCorrupt('scope-1', 'k', 'raw-1')
  preserveCorrupt('scope-2', 'k', 'raw-2')

  assert.equal(JSON.parse(store.get(qKey('scope-1')))[0].raw, 'raw-1')
  assert.equal(JSON.parse(store.get(qKey('scope-2')))[0].raw, 'raw-2')
  assert.equal(store.get(qKey('scope-1') + '.bad') ?? null, null, 'no .bad sibling is written on the healthy path')
})
