/* W20 P3 regression (2026-10-30): transport pair flow — requester socket early close must
 * invoke finish(false), not just clear confirmTimer. Pre-fix the close handler only cleared
 * the timer, so finish() never ran: the bootstrap respond wrapper (state.pendingPair cleanup,
 * lan-sync-bootstrap.js pair-request handler) never fired and the pending pair hung forever
 * with no TTL self-heal. Post-fix, close → finish(false); the settled guard keeps it
 * idempotent against the confirm timeout and against the bootstrap-side respond wrapper
 * (which keys on record identity).
 *
 * Driven through the exported wireConnection with an EventEmitter mock socket (on a real
 * socket the reject frame is unobservable at 'close' — the fd is already dead — so the mock
 * is the honest way to assert finish(false) ran): close must produce exactly one pair-reject
 * frame attempt, before the (long) confirm window, with no double-fire.
 * Run: node --test tests/unit/main/w20-pair-close-finish.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { wireConnection, PAIR_FLUSH_CAP_MS } = require('../../../src/main/lan-sync/transport.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')

function mockSocket () {
  const s = new EventEmitter()
  s.remoteAddress = '127.0.0.1:55555'
  s.writable = true
  s.destroyed = false
  s.writes = []
  s.write = line => { s.writes.push(String(line)); return true }
  s.end = () => {}
  s.destroy = () => { s.destroyed = true }
  s.setTimeout = () => s
  s.setEncoding = () => s
  return s
}

const REQUEST_LINE = () => {
  const eph = cipher.createPairEphemeral()
  return JSON.stringify({ type: 'pair-request', deviceId: 'client-w20', deviceName: 'W20', nonce: cipher.randomToken(), pub: eph.pub }) + '\n'
}

const baseOpts = () => ({
  deviceId: 'dev-w20', pairingSecret: 's3cret', secretFor: () => 's3cret', getHandler: () => {},
  pairConfirmTimeoutMs: 10 * 60 * 1000, // far beyond the test — only close can resolve
  preAuthIdleMs: 10 * 60 * 1000,
})

test('W20 P3: mock-socket close mid-confirm-window runs finish(false) — exactly one pair-reject attempt', async () => {
  const requests = []
  const socket = mockSocket()
  wireConnection(socket, { ...baseOpts(), onPairRequest: info => requests.push(info) })

  socket.emit('data', REQUEST_LINE())
  await new Promise(r => setImmediate(r))
  assert.equal(requests.length, 1, 'pair-request surfaced')
  assert.equal(typeof requests[0].respond, 'function')

  // Pre-fix: the close handler only cleared confirmTimer — no reject write, no destroy, and
  // (at the bootstrap layer) no respond closure → state.pendingPair hung. Post-fix: the
  // close path calls finish(false) which attempts the reject frame.
  socket.emit('close')
  const rejects = socket.writes.filter(w => w.includes('"pair-reject"'))
  assert.equal(rejects.length, 1, 'finish(false) ran exactly once on close')
  assert.equal(rejects[0].includes('"rejected"'), true, 'the reject reason is the auto-reject')
  // flushThenDestroy tears the (mock) socket down after the flush cap; the reject already went out.
  await new Promise(r => setTimeout(r, PAIR_FLUSH_CAP_MS + 150))
  assert.equal(socket.destroyed, true, 'the flow is settled — socket torn down')

  // Idempotence: a second close (error-then-close etc.) must not re-fire.
  socket.destroyed = false // simulate a rude mock; the settled guard must still hold
  socket.emit('close')
  assert.equal(socket.writes.filter(w => w.includes('"pair-reject"')).length, 1, 'settled guard keeps finish idempotent')
})

test('W20 P3: human respond after a close is a no-op (close wins, no double settle)', async () => {
  const requests = []
  const socket = mockSocket()
  wireConnection(socket, { ...baseOpts(), onPairRequest: info => requests.push(info) })

  socket.emit('data', REQUEST_LINE())
  await new Promise(r => setImmediate(r))
  assert.equal(requests.length, 1)

  socket.emit('close')
  assert.equal(socket.writes.filter(w => w.includes('"pair-reject"')).length, 1)
  // The renderer answers afterwards (stale dialog / slow human): the settled guard must keep
  // it from re-writing a reject onto a dead socket.
  requests[0].respond(true)
  assert.equal(socket.writes.filter(w => w.includes('"pair-reject"')).length, 1, 'late respond does not re-fire')
  assert.equal(socket.writes.some(w => w.includes('"pair-accept"')), false, 'late accept never goes out after close')
})
