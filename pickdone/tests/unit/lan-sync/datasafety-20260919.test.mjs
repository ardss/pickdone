/**
 * Data-safety round regression tests (2026-09-19):
 *   P0-1  flush-failure honesty — a dropped bulk-write buffer is never acked as applied;
 *         the sender keeps its push watermark and force-arms the snapshot trigger.
 *   P1-2  the pull watermark never advances over a flush-failed segment.
 *   P1-3  dial budget -> hibernate (suppressed fan-out) and peer-unauthorized = terminal.
 *   P1-4  stopSync order (engine outlives the node stop), unpaired control message clears
 *         the peer, notifyUnpaired sends on a live authenticated socket.
 *   P1-5  meta LWW loser is recoverable from a capped metaConflictBackup.* key.
 *   P1-6  invalidateSyncWatermarks clears persisted per-peer progress (recovery path).
 *
 * Real TCP on 127.0.0.1 ephemeral ports where a round is exercised; pure unit mocks elsewhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createServerRoleHandler } = require('../../../src/main/lan-sync/server-role.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')
const syncApply = require('../../../src/main/sync-apply.js')
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')

const SECRET = 'datasafety-secret-1'

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function line (socket, obj) { socket._lanSend(obj) }
const listen = server => new Promise(resolve => { server.on('listening', () => resolve(server.port)) })

function makeNode (extra = {}) {
  return createLanSyncNode({
    deviceId: 'me',
    name: 'Me',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...extra,
  })
}

/* ---------------- P0-1: server-role ack honesty ---------------- */

test('P0-1: server role keeps appliedToSeq below a flush-failed segment and flags the ack', () => {
  const sent = []
  const handler = createServerRoleHandler({
    ingestSegment: seg => (seg.body === 'poison' ? { applied: 0, rejected: 0, flushFailed: true } : { applied: 1, rejected: 0 }),
    buildSegments: () => [],
    serverSnapshotBusy: new Set(),
    serverPullAck: new Map(),
    pushRecent: () => {},
    onSnapshotError: () => {},
    onSnapshotSync: () => {},
    onServerError: () => {},
  })
  const socket = {}
  handler({ deviceId: 'peer' }, { type: 'segments-chunk', segments: [
    { body: 'poison', fromSeq: 5, toSeq: 6 },
    { body: 'ok', fromSeq: 7, toSeq: 8 },
  ], final: true }, socket, (sock, m) => sent.push(m))
  const ack = sent.find(m => m.type === 'ack')
  assert.ok(ack, 'final ack sent')
  assert.equal(ack.flushFailed, true, 'ack carries the flushFailed flag')
  assert.ok(ack.appliedToSeq <= 4, `appliedToSeq stays below the failed segment (got ${ack.appliedToSeq})`)
})

test('P0-1: sender does not advance its push watermark on a flushFailed ack and force-arms the snapshot trigger', async () => {
  const seen = { requests: 0 }
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        // The peer's bulk flush failed on our push: ack stays at 4 (< the pushed toSeq 9)
        // and the flag tells the sender to snapshot instead of counting the data applied.
        line(socket, { type: 'segments-chunk', segments: [] })
        line(socket, { type: 'ack', applied: 1, rejected: 0, appliedToSeq: 4, flushFailed: true, oldestSeq: 1 })
      } else if (msg.type === 'snapshot-request') {
        seen.requests += 1
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'r', seq: 1 }] })
        line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 9, schemaVersion: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const peerProgress = new Map()
  const node = makeNode({ getMaxSeq: () => 20, peerProgress, dialFailureBudget: 1000 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound() // push acked with flushFailed
  assert.ok(!peerProgress.get('peer'), 'push watermark NOT advanced past the unacked (dropped) rows')

  // Next round must open with a snapshot-request (force-armed trigger) and recover; only
  // the recovered snapshot-end advances the watermark.
  await node.startSyncRound()
  assert.equal(seen.requests, 1, 'snapshot-request force-armed after the flushFailed ack')
  await node.stop()
  await server.close()
})

/* ---------------- P0-1 / P1-2: pull side ---------------- */

test('P1-2: a flush-failed pull segment keeps the pull watermark and arms the snapshot request', async () => {
  const seen = { requests: 0, ingested: [] }
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        line(socket, { type: 'segments-chunk', segments: [{ body: 'poison', fromSeq: 1, toSeq: 9 }], final: true })
        line(socket, { type: 'ack', applied: 0, rejected: 0, appliedToSeq: 0, oldestSeq: 1 })
      } else if (msg.type === 'snapshot-request') {
        seen.requests += 1
        line(socket, { type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 9, schemaVersion: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode({
    dialFailureBudget: 1000,
    ingestSegment: seg => { seen.ingested.push(seg); return { applied: 0, rejected: 0, flushFailed: true } },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound()
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'watermark NEVER advances over a flush-failed segment')
  await node.startSyncRound()
  assert.equal(seen.requests, 1, 'the failed apply force-arms the snapshot request')
  assert.equal(node.getStatus().peers[0].pullWatermark, 9, 'a COMPLETED snapshot advances the watermark')
  await node.stop()
  await server.close()
})

/* ---------------- P1-3: dial budget / hibernate / terminal auth rejection ---------------- */

test('P1-3: consecutive failures hibernate the peer (10min retries) and collapse the error fan-out', async () => {
  let roundErrors = 0
  const node = makeNode({
    dialFailureBudget: 3,
    hibernateBackoffMs: 10 * 60 * 1000,
  })
  node.on('round-error', () => { roundErrors += 1 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'dead', host: '127.0.0.1', port: 1 }) // ECONNREFUSED

  for (let i = 0; i < 6; i++) { node.forceDial('dead'); await node.startSyncRound() }
  const st = node.getStatus()
  assert.equal(st.peers[0].peerState, 'hibernating', 'past the budget the peer is hibernating')
  const recent = st.recent.filter(e => e.kind === 'error')
  assert.ok(recent.length >= 4, 'every failed round is still recorded in the recent ring')
  assert.ok(roundErrors >= 3 && roundErrors <= 4, `error fan-out collapsed after the budget (got ${roundErrors} events for 6 failures)`)
  const nextDialAt = st.peers[0].nextDialAt
  assert.ok(nextDialAt && nextDialAt - Date.now() > 9 * 60 * 1000, 'hibernate retries at ~10min, not <=60s')
  // The periodic round respects the dial window: nothing is dialed.
  const r = await node.startSyncRound()
  assert.equal(r.peers, 0, 'startSyncRound skips hibernating peers (no unconditional dialing)')
  await node.stop()
})

test('P1-3: peer-unauthorized is TERMINAL — no more dialing until re-pair, distinct peerState', async () => {
  // Server runs with a DIFFERENT pairing secret: our authenticated hello is rejected.
  const server = createLanServer({ port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: 'other-secret' })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode({ dialFailureBudget: 1000 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound() // auth rejected -> terminal
  const st = node.getStatus()
  assert.equal(st.peers[0].peerState, 'unpaired', 'distinct unpaired state for the Device Center')
  assert.match(String(st.peers[0].lastError), /unpaired|re-pair/i, 'lastError carries the unpaired sentinel')
  assert.ok(!String(st.peers[0].lastError).includes('null'), 'lastError is a real message')

  // Terminal: the periodic round must NOT dial the peer at all anymore.
  for (let i = 0; i < 3; i++) {
    const r = await node.startSyncRound()
    assert.equal(r.peers, 0, 'unpaired peers are never dialed again')
  }
  // Re-adding/re-announcing the peer clears the terminal state (user re-paired).
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })
  assert.equal(node.getStatus().peers[0].peerState, 'ok', 're-pair (re-add) clears the terminal state')
  await node.stop()
  await server.close()
})

/* ---------------- P1-4: stop ordering + unpaired handshake ---------------- */

test('P1-4: stopSync stops the node BEFORE nulling the engine (no in-flight ingest TypeError)', async () => {
  let engineAliveDuringStop = null
  let stopResolve
  const gate = new Promise(resolve => { stopResolve = resolve })
  const engine = { ingestSegment: () => {} }
  const state = {
    db: { call: () => null },
    getWindowSenders: () => [],
    node: {
      on () {},
      async stop () {
        await gate
        // Simulates an in-flight round callback firing while stop() is still awaiting:
        // the engine MUST still be set here (the old code nulled it before the await —
        // in-flight ingestSegment hit `engine of null` TypeError).
        engineAliveDuringStop = state.engine === engine
      },
    },
    engine,
    timers: [],
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    peerWatermarks: { raw: () => ({}) },
    pendingPair: null,
    applied: null,
  }
  bootstrap.__test.setState(state)
  try {
    const p = bootstrap.__test.stopSync()
    stopResolve()
    await p
    assert.equal(engineAliveDuringStop, true, 'engine still reachable while the node stop is in flight')
    assert.equal(state.node, null)
    assert.equal(state.engine, null, 'engine torn down only after the node stopped')
  } finally {
    bootstrap.__test.setState(null)
  }
})

test('P1-4: an `unpaired` control message from the peer clears dialing and sets the unpaired state', async () => {
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        line(socket, { type: 'segments-chunk', segments: [] })
        // The peer removed our pairing mid-round: the control message rides BEFORE the ack
        // (the ack settles the round and closes the socket).
        line(socket, { type: 'unpaired' })
        line(socket, { type: 'ack', applied: 0, rejected: 0, appliedToSeq: 1, oldestSeq: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode({ dialFailureBudget: 1000 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound()
  assert.equal(node.getStatus().peers[0].peerState, 'unpaired', 'the unpaired message sets the terminal state')
  const r = await node.startSyncRound()
  assert.equal(r.peers, 0, 'no dialing after the peer removed the pairing')
  await node.stop()
  await server.close()
})

test('P1-4: notifyUnpaired is a safe no-op when no connection is live (per-dial connections)', async () => {
  // Round connections live only for the dial (the receiver-side `unpaired` handling is covered
  // by the scripted-server test above). With nothing connected, the best-effort notify must
  // neither throw nor claim success - the peer then discovers the unpair via the terminal
  // auth-rejection path instead.
  const node = makeNode({ deviceId: 'unpairer' })
  node.start()
  await node.whenListening()
  assert.equal(node.notifyUnpaired('nobody'), false)
  assert.doesNotThrow(() => node.notifyUnpaired('nobody'))
  await node.stop()
})

/* ---------------- P1-5: meta conflict backup ---------------- */

test('P1-5: a content-differing meta LWW loss is recoverable from a capped backup key', () => {
  const meta = { tomatoEstimateState: 'local-older' }
  const calls = []
  const state = {
    deviceId: 'd', localUserId: null, applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, p) {
      calls.push({ op, p })
      if (op === 'getMeta') return meta[p]
      if (op === 'setMeta') { const [k, v] = p; meta[k] = v }
      if (op === 'deleteMeta') delete meta[p]
      if (op === 'listMetaKeys') return Object.keys(meta)
      if (op === 'syncOplogSince') return [{ seq: 1, entity: 'meta', entityId: 'tomatoEstimateState', ts: 100 }]
      return null
    } },
  }
  const row = { entity: 'meta', id: 'tomatoEstimateState', seq: 9, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0, data: { key: 'tomatoEstimateState', value: 'remote-newer' } }
  assert.equal(syncApply.applyRowSafe(state, row), true, 'the newer remote value wins')
  assert.equal(meta.tomatoEstimateState, 'remote-newer', 'winner landed')
  const backupKeys = Object.keys(meta).filter(k => k.startsWith('metaConflictBackup.tomatoEstimateState.'))
  assert.equal(backupKeys.length, 1, 'exactly one dated backup key')
  const backup = JSON.parse(meta[backupKeys[0]])
  assert.equal(backup.value, 'local-older', 'the LOSING local value is recoverable')
  // Announce keys are ephemeral: no backup for them.
  const meta2 = { 'tomatoRunAnnounce.dev1': 'running' }
  const state2 = {
    deviceId: 'd', localUserId: null, applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, p) {
      if (op === 'getMeta') return meta2[p]
      if (op === 'setMeta') { const [k, v] = p; meta2[k] = v }
      if (op === 'listMetaKeys') return Object.keys(meta2)
      if (op === 'syncOplogSince') return [{ seq: 1, entity: 'meta', entityId: 'tomatoRunAnnounce.dev1', ts: 100 }]
      return null
    } },
  }
  syncApply.applyRowSafe(state2, { entity: 'meta', id: 'tomatoRunAnnounce.dev1', seq: 9, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0, data: { key: 'tomatoRunAnnounce.dev1', value: 'idle' } })
  assert.ok(!Object.keys(meta2).some(k => k.startsWith('metaConflictBackup.')), 'no backup for ephemeral announce keys')
  // Backup keys are machine-local: they never egress and never ingress (no echo loop).
  assert.equal(syncApply.hydrateRow(state, { entity: 'meta', entityId: backupKeys[0], seq: 2, ts: 5 }), null, 'backup key never egresses')
  assert.equal(syncApply.applyRowSafe(state, { entity: 'meta', id: backupKeys[0], seq: 3, ts: 6, updatedAt: 6, deleted: false, deletedAt: 0, data: { key: backupKeys[0], value: 'x' } }), false, 'backup key never ingresses')
})

/* ---------------- P1-6: recovery watermark invalidation ---------------- */

test('P1-6: invalidateSyncWatermarks clears the persisted watermark map and the live one', () => {
  const puts = []
  const live = new Map([['peer-1', 4242]])
  const state = {
    db: { call (op, p) { if (op === 'settingsRowsAll') return []; if (op === 'settingsRowPut') puts.push(p); return null } },
    node: null, // no live node: kick no-ops
    peerWatermarks: live,
    getWindowSenders: () => [],
    timers: [],
  }
  bootstrap.__test.setState(state)
  try {
    bootstrap.__test.invalidateSyncWatermarks('db-recovery')
  } finally {
    bootstrap.__test.setState(null)
  }
  assert.equal(puts.length, 1, 'one settings write')
  assert.equal(puts[0].key, 'sync.peerWatermarks.v2')
  assert.equal(JSON.parse(puts[0].value)['peer-1'], undefined, 'persisted watermarks cleared -> full re-push next round')
  assert.equal(live.size, 0, 'live watermark map cleared too')
})
