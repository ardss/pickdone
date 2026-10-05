/**
 * D22 (P2 2026-10-02) — client-side dead-peer abort on a failed send().
 *
 * Red before the fix: client-round's segment push discarded transport.send()'s boolean report
 * (the D19 abort contract was applied SERVER-side only, server-role.js emit()). A dead socket
 * silently dropped every push frame while the round "ran" until the 120s deadline.
 *
 * Behavioral here: createClientRound is driven with a FAKE transport (Module._load intercept of
 * './transport' for the client-round module only) whose send() reports false exactly like
 * transport.send() does for a destroyed/non-writable socket. The interceptor is installed ONCE
 * at module load (client-round binds its './transport' at require time) and each test resets the
 * shared `state.failOn` list.
 * Run: node --test tests/unit/lan-sync/d22-client-round-send-abort.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Module, createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)

// One shared fake transport for the whole file (installed before client-round is required).
const state = { failOn: [], closed: [] }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === './transport' && parent && /client-round\.js$/.test(String(parent.filename))) {
    return { connect: () => {
      const c = new EventEmitter()
      c.sent = []
      // D22: the raw socket twin (client-round inspects it to tell a DEAD socket from ordinary
      // kernel-buffer backpressure — send() reports false for both).
      c._socket = { destroyed: false, writable: true }
      c.send = msg => {
        if (state.failOn.includes(msg.type)) return false
        c.sent.push(msg)
        return true
      }
      c.close = () => { state.closed.push(true) }
      return c
    } }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const { createClientRound } = require('../../../src/main/lan-sync/client-round.js')

function makeCtx (extra = {}) {
  const noop = () => {}
  return {
    opts: {},
    deviceId: 'self-dev',
    pairingSecret: 'pair-secret',
    em: new EventEmitter(),
    secretFor: () => 'pair-secret',
    retryTimers: new Map(), lastRoundBy: new Map(), failStreakBy: new Map(),
    oversizedSegmentBy: new Set(), unpairedBy: new Set(), activeClients: new Set(),
    needSnapshot: new Set(), needSnapshotForce: new Set(), clientSnapshotBusy: new Set(),
    pullWatermarkBy: new Map(), snapshotFatalCount: new Map(),
    snapshotErrorCooldown: new Map(), flushStallBy: new Map(),
    errorBy: new Map(), attSession: { requests: new Map() }, peerProgress: new Map(),
    DIAL_FAILURE_BUDGET: 5, maxSnapshotChunks: 512,
    buildSegments: () => [], ingestSegment: () => ({ applied: 0, fromSeq: null, toSeq: null }),
    ingestSnapshot: () => {}, ingestSnapshotChunk: () => {},
    getMaxSeq: () => 0, currentMaxSeq: () => 0,
    getStopped: () => false, bumpRounds: noop, setLastRoundAt: () => 0, setLastError: noop,
    getListenPort: () => null,
    pushRecent: noop, refreshOnline: noop, scheduleRetry: noop, resetBackoff: noop,
    tryRefixAddress: () => false, forgetPeer: noop,
    sendVia: () => true,
    ...extra,
  }
}

const peer = { deviceId: 'peer-1', host: '127.0.0.1', port: 58480 }
const tick = () => new Promise(r => setImmediate(r))

test('D22: a segments-chunk send reporting false fails the round promptly', async () => {
  state.failOn = ['segments-chunk']
  state.closed = []
  const errors = []
  const ctx = makeCtx({ buildSegments: () => [{ body: 'x', fromSeq: 1, toSeq: 1 }] })
  ctx.em.on('round-error', e => errors.push(e))
  const round = createClientRound(ctx)
  const p = round.syncWithPeer(peer)
  await tick() // let the fake dial land
  const client = [...ctx.activeClients][0]
  assert.ok(client, 'the fake client is registered as active')
  client._socket = { destroyed: true, writable: false } // dead socket: the failed push aborts
  client.emit('ready')
  const ok = await p
  assert.equal(ok, false, 'the round reports failure, not silent success')
  assert.equal(client.sent.length, 0, 'the failed frame did NOT count as delivered')
  assert.ok(errors[0] && /socket dead/.test(String(errors[0].error && errors[0].error.message)),
    'round-error carries the send-failure diagnostic')
  assert.ok(state.closed.length >= 1, 'the round closed the connection')
})

test('D22: send() false on a LIVE socket is backpressure, not death — the round continues', async () => {
  // transport.send() returns socket.write() !== false: a live socket with a full kernel buffer
  // (e.g. a >32MB segments backlog pushed in a tight loop) reports false while the frame is
  // still queued and will be delivered. Aborting the round on that broke the oversized-backlog
  // push (segments-chunk.test.mjs). Only a dead socket (destroyed / not writable) aborts.
  state.failOn = ['segments-chunk']
  state.closed = []
  const ctx = makeCtx({ buildSegments: () => [{ body: 'x', fromSeq: 1, toSeq: 1 }] })
  const errors = []
  ctx.em.on('round-error', e => errors.push(e))
  const round = createClientRound(ctx)
  const p = round.syncWithPeer(peer)
  await tick()
  const client = [...ctx.activeClients][0]
  client.emit('ready')
  await tick()
  assert.equal(errors.length, 0, 'no round error on live-socket backpressure')
  assert.equal(state.closed.length, 0, 'the connection was NOT torn down')
  // The push "failed" (frame rejected by the fake) but the round moved on to its ack wait.
  client.emit('message', { type: 'ack', applied: 0, rejected: 0 })
  const ok = await p
  assert.equal(ok, true, 'the round completes once the peer acks')
})

test('D22: send() false on a DESTROYED socket still aborts the round promptly', async () => {
  state.failOn = ['segments-chunk']
  state.closed = []
  const errors = []
  const ctx = makeCtx({ buildSegments: () => [{ body: 'x', fromSeq: 1, toSeq: 1 }] })
  ctx.em.on('round-error', e => errors.push(e))
  const round = createClientRound(ctx)
  const p = round.syncWithPeer(peer)
  await tick()
  const client = [...ctx.activeClients][0]
  client._socket = { destroyed: true, writable: false } // dead socket: abort is correct
  client.emit('ready')
  const ok = await p
  assert.equal(ok, false, 'a dead-socket send failure fails the round')
  assert.ok(errors[0] && /socket dead/.test(String(errors[0].error && errors[0].error.message)))
  assert.ok(state.closed.length >= 1, 'the round closed the connection')
})

test('D22: a snapshot-request send reporting false fails the round (trigger re-arms)', async () => {
  state.failOn = ['snapshot-request']
  const errors = []
  const ctx = makeCtx()
  ctx.needSnapshot.add('peer-1')
  ctx.em.on('round-error', e => errors.push(e))
  const round = createClientRound(ctx)
  const p = round.syncWithPeer(peer)
  await tick()
  const client = [...ctx.activeClients][0]
  client._socket = { destroyed: true, writable: false } // dead socket: the failed request aborts
  client.emit('ready')
  await p
  assert.equal(client.sent[0] && client.sent[0].type, 'segments-chunk', 'the push chunk went out fine')
  assert.ok(errors[0] && /snapshot-request send failed/.test(String(errors[0].error.message)))
  // finish()'s awaitingSnapshot failure path re-arms the deterministic snapshot trigger.
  assert.ok(ctx.needSnapshot.has('peer-1'), 'the snapshot trigger is re-armed for the retry')
})

test('D22: a healthy send keeps the round alive (no regression to abort-on-success)', async () => {
  state.failOn = []
  const ctx = makeCtx()
  const round = createClientRound(ctx)
  const p = round.syncWithPeer(peer)
  await tick()
  const client = [...ctx.activeClients][0]
  client.emit('ready')
  await tick()
  assert.equal(client.sent.filter(m => m.type === 'segments-chunk').length, 1,
    'the empty-backlog final chunk was delivered and the round did not abort')
  // End the round cleanly the way the peer's ack would.
  client.emit('message', { type: 'ack', applied: 0, rejected: 0 })
  const ok = await p
  assert.equal(ok, true)
})
