/**
 * D20-DOM-A regression tests for transport.js:
 *   C1  — with preAuthIdleMs: 0 the auth-phase 'timeout' listener must STILL exist: an
 *         authenticated peer that goes silent must be destroyed after authIdleMs (the old code
 *         attached the destroy-on-fire handler only under preAuthIdleMs > 0, so with the
 *         pre-auth budget disabled a dead peer held its maxSockets slot forever).
 *   C13 — flushThenDestroy accepts a per-call cap: pair accept/reject teardown uses 250ms
 *         instead of the 1s data-path default (a stalled peer must not hold the pairing flow).
 * Run: node --test tests/unit/lan-sync/d20-doma-transport-timeout-flush.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const transport = require('../../../src/main/lan-sync/transport.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')

const SECRET = 'd20-secret-1'

test('C1: authenticated silent peer is destroyed after authIdleMs even with preAuthIdleMs: 0', async () => {
  const server = transport.createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'd20-srv', pairingSecret: SECRET,
    preAuthIdleMs: 0, // the DISABLED branch: pre-fix, no 'timeout' listener existed at all
    authIdleMs: 250,
  })
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const port = server.port
  let sawAck = false
  let closed = false
  const client = net.connect(port, '127.0.0.1')
  client.setEncoding('utf8')
  client.on('connect', () => {
    client.write(JSON.stringify({
      type: 'hello', deviceId: 'd20-client', protoVer: transport.PROTO_VER,
      authCode: deriveAuthCode(SECRET, 'd20-client'), enc: 1, salt: cipher.randomToken(),
    }) + '\n')
  })
  client.on('data', (d) => { if (String(d).includes('"ok":true')) sawAck = true })
  client.on('close', () => { closed = true })
  // The server must tear the silent authenticated socket down (authIdleMs 250ms + slack).
  const deadline = Date.now() + 5000
  while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  client.destroy()
  await server.close()
  assert.ok(sawAck, 'the peer authenticated (precondition)')
  assert.ok(closed, 'red before the fix: the auth-phase timeout had NO listener with preAuthIdleMs 0 — the zombie socket held its slot forever')
})

/** Socket double for flushThenDestroy: never closes on its own (simulates a stalled peer). */
function stalledSocket () {
  const s = new EventEmitter()
  s.destroyed = false
  s.writable = true
  s.end = () => { s.writable = false; return s } // never emits 'close'
  s.destroy = () => { s.destroyed = true; s.emit('close') }
  return s
}

test('C13: flushThenDestroy honors a short per-call cap (pair-control 250ms window)', async () => {
  const a = stalledSocket()
  transport.flushThenDestroy(a, 250)
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(a.destroyed, true, 'the 250ms pair-control cap fires well inside the old 1s window')

  const b = stalledSocket()
  transport.flushThenDestroy(b) // default data-path cap: 1000ms
  await new Promise((r) => setTimeout(r, 600))
  assert.equal(b.destroyed, false, 'the default 1s cap is untouched (no early destroy of data paths)')
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(b.destroyed, true, 'the default cap still fires at 1s')
})
