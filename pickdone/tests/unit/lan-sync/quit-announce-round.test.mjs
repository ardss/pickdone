/* R7-B P2 regression (2026-09-21): quit-time idle announce must ship with an IMMEDIATE round.
 * Old order: announce written -> stopSyncForQuit killed the node before the debounced kick
 * fired -> peers showed a "running" tomato ghost until TTL. shipQuitRound bypasses the debounce;
 * stopSyncForQuit moved into the will-quit flush window (index.js flushNow, before db close).
 *
 * Run: node --test tests/unit/lan-sync/quit-announce-round.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const bootstrap = require_('../../../src/main/lan-sync-bootstrap.js')

test('shipQuitRound without an initialized sync node is a safe no-op (false)', () => {
  bootstrap.__test.setState(null)
  assert.equal(bootstrap.shipQuitRound(), false)
})

test('shipQuitRound with a live node starts a round IMMEDIATELY (debounce bypassed)', async () => {
  let started = 0
  bootstrap.__test.setState({
    deviceId: 'devQ',
    node: { startSyncRound: async () => { started++; return { confirmed: 0, peers: 0 } } },
    getWindowSenders: () => [],
  })
  // The round must be kicked synchronously — a debounced timer here is exactly the bug
  // (stopSyncForQuit used to kill the node before the timer fired).
  const shipped = bootstrap.shipQuitRound()
  assert.equal(shipped, true, 'live node -> round shipped')
  assert.equal(started, 1, 'runRound started synchronously, not on a debounce timer')
  await new Promise(r => setTimeout(r, 20))
})
