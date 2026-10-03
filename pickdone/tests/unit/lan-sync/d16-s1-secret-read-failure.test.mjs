/**
 * S1 regression (2026-10-03): the paired-peer secret resolver must keep the read-failure vs
 * record-absent taxonomy that paired-peers.js (D15 C1) established for the same settings table.
 *
 * Violated invariant: a TRANSIENT settings read failure inside secretFor is not "never paired" —
 * it must never classify the peer as unauthorized/unpaired on either side of the handshake, and
 * the dialer must retry. Before the fix both consumers collapsed the failure to null, fell back
 * to the global pairing secret, and (server side) ran verifyAuthCode against the wrong secret ->
 * onUnauthorized + security 'auth-rejected' + the dialer's TERMINAL unpaired state whose only
 * documented exit is user re-pair or restart.
 *
 * Both tests are full two-node TCP loops (real hello/hello-ack wire), so the classification is
 * asserted at the actual boundary, not against internals.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const GLOBAL_SECRET = 's1-global-secret'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

test('S1: server-side secretFor read failure answers secret-unavailable — never unauthorized/unpaired, dialer retries', async () => {
  let serverUnauthorized = 0
  let clientAuthFailureInfo = null
  const nodeB = createLanSyncNode({
    deviceId: 's1-server', name: 'S1 Server', pairingSecret: GLOBAL_SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    // The paired-peer table read THROWS (transient settings failure, D15 C1 contract).
    secretFor: () => { throw new Error('settings_rows unreadable (simulated transient failure)') },
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  nodeB.on('peer-unauthorized', () => { serverUnauthorized++ })
  const nodeA = createLanSyncNode({
    deviceId: 's1-client', name: 'S1 Client',
    // Auth code derived from a secret that matches NEITHER the (unreadable) per-pair record nor
    // the global: pre-fix the server verified against the global secret, the verify failed, and
    // this client landed in the terminal unpaired state.
    pairingSecret: 's1-client-different-secret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  nodeA.on('peer-unauthorized', info => { clientAuthFailureInfo = info })
  nodeA.start(); nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 's1-server', host: '127.0.0.1', port: portB, name: 'S1 Server' })

  const r = await nodeA.startSyncRound()
  assert.equal(r.confirmed, 0, 'the round must fail while the server cannot read its secret table')
  // The invariant: the failure is classified as a DISTINCT receiver-side class on the wire, not
  // as an auth failure. Pre-fix the throwing resolver destroyed the socket inside the line
  // reader (silent) or verified against the global secret ('auth failed' -> terminal unpaired);
  // neither carries the secret-unavailable class.
  assert.ok(clientAuthFailureInfo && clientAuthFailureInfo.error === 'secret-unavailable',
    'hello-ack must answer the distinct secret-unavailable class (got ' + JSON.stringify(clientAuthFailureInfo) + ')')
  assert.equal(serverUnauthorized, 0, 'the server must NOT classify the peer as unauthorized on a settings read failure')
  assert.equal(nodeB.getStatus().security.filter(e => e.reason === 'auth-rejected').length, 0,
    'a read failure must not enter the auth-rejected security ring (it is not an auth failure)')
  const st = nodeA.getStatus().peers.find(p => p.deviceId === 's1-server')
  assert.ok(st, 'peer entry still present')
  assert.notEqual(st.peerState, 'unpaired', 'a transient server-side read failure must not reach the TERMINAL unpaired state')
  assert.ok(st.nextDialAt != null, 'the dialer must have a retry scheduled (retryable, not terminal)')
  await nodeA.stop(); await nodeB.stop()
})

test('S1: dial-side secretFor read failure aborts the round retryable — no global-secret fallback dial', async () => {
  const nodeB = createLanSyncNode({
    deviceId: 's1b-server', name: 'S1b Server', pairingSecret: GLOBAL_SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  const nodeA = createLanSyncNode({
    deviceId: 's1b-client', name: 'S1b Client', pairingSecret: GLOBAL_SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    // Dialer's paired-peer table read THROWS. Pre-fix the dial fell back to the global secret,
    // which this server ACCEPTS (same global) — so the round confirmed on a transient failure.
    secretFor: () => { throw new Error('settings_rows unreadable (simulated transient failure)') },
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  nodeA.start(); nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 's1b-server', host: '127.0.0.1', port: portB, name: 'S1b Server' })

  const r = await nodeA.startSyncRound()
  assert.equal(r.confirmed, 0, 'the round must NOT confirm by silently dialing with the global secret while the per-pair table is unreadable')
  const st = nodeA.getStatus()
  assert.match(st.lastError || '', /secret lookup failed/, 'the round failure must name the secret lookup as the cause')
  const peer = st.peers.find(p => p.deviceId === 's1b-server')
  assert.notEqual(peer.peerState, 'unpaired', 'a transient local read failure must not reach the TERMINAL unpaired state')
  assert.ok(peer.nextDialAt != null, 'the dialer must retry')
  assert.equal(nodeB.getStatus().security.filter(e => e.reason === 'auth-rejected').length, 0,
    'no auth rejection may be recorded on the peer for a local read failure')
  await nodeA.stop(); await nodeB.stop()
})
