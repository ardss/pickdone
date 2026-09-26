/**
 * round3-stability-finding-8 (2026-09-26): the will-quit chain fire-and-forget stopSyncForQuit()
 * and closed the DB handle in the same tick — the in-flight quit round's peer-watermark
 * persist (which runs after the node settles) hit the closed handle and died as a warn, so
 * quit-time watermark confirmations were lost (data-safe: idempotent re-push next start, but
 * the designed behavior is persist-before-close).
 * The fix: stopSync persists peerWatermarks at its settle point (mirroring the security-ring
 * flush) and stopSyncForQuit returns the promise; index.js flushNow awaits it before dbm.close().
 * Driven through the __test hook with a mock db/node (no electron, no real %APPDATA%).
 * Run directly: node --test pickdone/tests/unit/lan-sync/quit-watermark-flush.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')
const { __test } = bootstrap

const K_PEER_WATERMARKS = 'sync.peerWatermarks.v2'

function setupWithNode (stopDelayMs) {
  const calls = []
  const tracked = new Map([['peer-A', 41]])
  tracked.raw = () => Object.fromEntries(tracked)
  const db = {
    call (op, params) {
      calls.push({ op, params })
      if (op === 'settingsRowsAll') return []
      return null
    }
  }
  let stopped = false
  const node = {
    // in-flight round settling ASYNCHRONOUSLY: the peer ack lands in peerWatermarks only
    // after stop() awaits — exactly the quit-time shape
    stop: async () => {
      await new Promise(r => setTimeout(r, stopDelayMs))
      tracked.set('peer-A', 42)
      stopped = true
    },
    getStatus: () => ({ security: [] })
  }
  __test.setState({
    db,
    node,
    timers: [],
    pendingPair: null,
    peerWatermarks: tracked,
    engine: {},
    applyCache: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    getWindowSenders: () => []
  })
  return {
    calls,
    wasStopped: () => stopped,
    watermarkPuts: () => calls.filter(c => c.op === 'settingsRowPut' && c.params && c.params.key === K_PEER_WATERMARKS)
  }
}

test('THE FIX: stopSync persists the peer watermarks that landed during the in-flight round settle', async () => {
  const t = setupWithNode(25)
  await __test.stopSync()
  assert.ok(t.wasStopped(), 'precondition: node stop resolved')
  const puts = t.watermarkPuts()
  assert.ok(puts.length >= 1, 'watermark persist ran at the settle point (lost pre-fix)')
  assert.equal(JSON.parse(puts[puts.length - 1].params.value)['peer-A'], 42,
    'the advance that landed during settle (41 -> 42) is captured')
})

test('stopSyncForQuit returns a promise that resolves only after the node stopped (awaitable before dbm.close)', async () => {
  const t = setupWithNode(25)
  const p = bootstrap.stopSyncForQuit()
  assert.ok(p && typeof p.then === 'function', 'THE FIX: stopSyncForQuit is awaitable (was fire-and-forget void)')
  assert.equal(t.wasStopped(), false, 'not yet stopped at await time — the quit chain must wait')
  await p
  assert.ok(t.wasStopped(), 'stopped before the promise resolves, so the persist beats dbm.close()')
})

test('stopSyncForQuit with sync never initialized resolves without throwing', async () => {
  __test.setState({ db: { call: () => null }, node: null, timers: [], peerWatermarks: new Map() })
  const p = bootstrap.stopSyncForQuit()
  if (p && typeof p.then === 'function') await p
})
