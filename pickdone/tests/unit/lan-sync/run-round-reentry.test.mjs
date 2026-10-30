/**
 * F4 P3 (2026-10-18) regression tests — runRound reentry guard:
 * the 5-minute interval timer and kickSyncRound could fire while a previous round was still
 * awaiting its sockets, and two concurrent rounds ran syncWithPeer against the SAME peer
 * concurrently (racing writes through both ingest paths). The fix: an async-reentry flag
 * turns an overlapping call into a no-op that latches a follow-up round (run once after the
 * in-flight round settles, so no kick-triggered delta is dropped).
 * Driven through __test.setState with a controllable fake node (makeNode pattern of the
 * existing lan-sync tests). Run: node --test tests/unit/lan-sync/run-round-reentry.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')
const { __test } = bootstrap

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [],
  filterList: () => [],
}

function mockState (startSyncRound) {
  const calls = []
  const db = {
    calls,
    call (op, params) {
      calls.push({ op, params })
      if (EMPTY_TABLES[op]) return EMPTY_TABLES[op]()
      return null
    },
  }
  const node = { startSyncRound }
  const state = {
    db, node,
    getWindowSenders: () => [],
    peerWatermarks: new Map(),
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  }
  __test.setState(state)
  return state
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Absorb any follow-up round timer left over from a previous test (module-level guard state
// is shared across tests in this file) before a test starts counting startSyncRound calls.
const drainStragglers = () => sleep(400)

test('runRound: an overlapping call is a no-op and queues exactly ONE follow-up round', async () => {
  await drainStragglers()
  let started = 0
  let pending = null
  let releaseRound = null
  mockState(() => {
    started++
    if (!pending) pending = new Promise(resolve => { releaseRound = resolve })
    return pending
  })

  const first = __test.runRound()
  assert.ok(first instanceof Promise)
  // the interval/kick fires while round 1 is still awaiting its sockets
  const second = await __test.runRound()
  assert.equal(second, null, 'the overlapping round must be a guarded no-op (not a second concurrent round)')
  assert.equal(started, 1, 'no second concurrent round entered startSyncRound while one was in flight')

  releaseRound({ confirmed: 1, peers: 1 })
  const r = await first
  assert.equal(r && r.confirmed, 1, 'the in-flight round completes normally')

  // the queued follow-up runs shortly after the in-flight round settles (50ms scheduler)
  await sleep(300)
  assert.equal(started, 2, 'exactly ONE follow-up round runs after the in-flight round settles')
})

test('runRound: a failed in-flight round still drains the queued follow-up (finally, not success-only)', async () => {
  await drainStragglers()
  let started = 0
  let rejectFirst = null
  mockState(() => {
    started++
    return started === 1 ? new Promise((_res, rej) => { rejectFirst = rej }) : Promise.resolve({ confirmed: 0, peers: 0 })
  })

  const first = __test.runRound()
  const second = await __test.runRound()
  assert.equal(second, null, 'overlap guarded')
  rejectFirst(new Error('dial failed'))
  await assert.doesNotReject(first, 'a failed round resolves to null, never throws out of runRound')
  await sleep(300)
  assert.equal(started, 2, 'the queued follow-up runs even when the in-flight round failed')
})

test('runRound: back-to-back non-overlapping rounds are never suppressed', async () => {
  await drainStragglers()
  let started = 0
  mockState(() => { started++; return Promise.resolve({ confirmed: 0, peers: 0 }) })

  await __test.runRound()
  await __test.runRound()
  await sleep(200)
  assert.equal(started, 2, 'sequential rounds (interval cadence) are unaffected by the guard')
})
