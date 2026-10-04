/**
 * D20-DOM-A regressions in server-role.js (driven directly with stub deps + fake sockets):
 *   C6 — the 'snapshot-error too-large' refusal (row ceiling) goes through the abort-aware
 *        emit() wrapper, NOT the throwing sendVia: a dead socket must not throw into the outer
 *        catch (onServerError fan-out) and the refusal bookkeeping is skipped when undeliverable.
 *   C7 — the per-socket _segPush accumulator is keyed per PUSH GENERATION (pushId): a push whose
 *        final chunk never arrived no longer blends its count into the next push's ack. Same
 *        pushId still accumulates across chunks (multi-chunk pushes stay intact).
 * Run: node --test tests/unit/lan-sync/d20-doma-server-role-push-gen.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createServerRoleHandler } = require('../../../src/main/lan-sync/server-role.js')

function fakeSocket ({ dead = false } = {}) {
  return { dead, sent: [], _lanSend (msg) { this.sent.push(msg) } }
}

function stubDeps (extra = {}) {
  const calls = { ingested: 0, snapshotErrors: 0, serverErrors: 0 }
  const deps = {
    ingestSegment: (seg) => {
      calls.ingested++
      const rows = (seg && seg.rows) || []
      return { applied: rows.length, rejected: 0, fromSeq: rows.length ? rows[0].seq : null, toSeq: rows.length ? rows[rows.length - 1].seq : null }
    },
    buildSegments: () => [],
    buildSnapshotRows: () => [],
    serverSnapshotBusy: new Set(),
    serverPullAck: new Map(),
    maxSnapshotChunks: 512,
    maxSnapshotRows: 5,
    snapshotSchemaVersion: 1,
    pushRecent: () => {},
    onSnapshotError: () => { calls.snapshotErrors++ },
    onSnapshotSync: () => {},
    onServerError: () => { calls.serverErrors++ },
    ...extra,
  }
  return { deps, calls }
}

const peer = { deviceId: 'd20-peer' }
const sendVia = (socket, msg) => {
  if (socket.dead) throw new Error('simulated dead socket (sendVia throws)')
  socket._lanSend(msg)
  return true
}

test('C6: too-large refusal on a DEAD socket does not throw and skips the fan-out bookkeeping', () => {
  const { deps, calls } = stubDeps({ buildSnapshotRows: () => Array.from({ length: 8 }, (_, i) => ({ id: 'r' + i })) })
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket({ dead: true })
  assert.doesNotThrow(() => handle(peer, { type: 'snapshot-request' }, socket, sendVia),
    'red before the fix: the throwing sendVia propagated into the outer catch')
  assert.equal(calls.serverErrors, 0, 'no onServerError fan-out for an undeliverable refusal')
  assert.equal(calls.snapshotErrors, 0, 'refusal bookkeeping skipped when the frame never left')
  assert.equal(deps.serverSnapshotBusy.has(peer.deviceId), false, 'the busy invariant is still released')
})

test('C6: a deliverable too-large refusal still reports normally', () => {
  const { deps, calls } = stubDeps({ buildSnapshotRows: () => Array.from({ length: 8 }, (_, i) => ({ id: 'r' + i })) })
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'snapshot-request' }, socket, sendVia)
  assert.equal(calls.snapshotErrors, 1, 'deliverable refusal reports onSnapshotError as before')
  const err = socket.sent.find((m) => m.type === 'snapshot-error')
  assert.ok(err && err.reason === 'too-large', 'the refusal frame went out')
})

test('C7: a new pushId on the same connection starts a FRESH accumulator (no blended ack)', () => {
  const { deps } = stubDeps()
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  // Push generation 1: unterminated (its final chunk never arrived).
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'a', seq: 5 }] }], final: false, pushId: 'gen-1' }, socket, sendVia)
  // Push generation 2 on the SAME connection: one non-final chunk, then final.
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'b', seq: 9 }] }], final: false, pushId: 'gen-2' }, socket, sendVia)
  handle(peer, { type: 'segments-chunk', segments: [], final: true, pushId: 'gen-2' }, socket, sendVia)
  const ack = socket.sent.find((m) => m.type === 'ack')
  assert.ok(ack, 'the final chunk acked')
  assert.equal(ack.applied, 1, 'red before the fix: the ack blended gen-1 into gen-2 (applied: 2)')
  assert.equal(ack.appliedToSeq, 9, 'acked seq comes from the live generation only')
})

test('C7: chunks sharing a pushId still accumulate (multi-chunk pushes intact)', () => {
  const { deps } = stubDeps()
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'a', seq: 3 }] }], final: false, pushId: 'same' }, socket, sendVia)
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'b', seq: 7 }] }], final: true, pushId: 'same' }, socket, sendVia)
  const ack = socket.sent.find((m) => m.type === 'ack')
  assert.equal(ack.applied, 2, 'same-generation chunks accumulate into one ack')
  assert.equal(ack.appliedToSeq, 7, 'the acked span covers all chunks of the push')
})

test('C7: legacy senders without pushId keep the historical single-accumulator behavior', () => {
  const { deps } = stubDeps()
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'a', seq: 3 }] }], final: false }, socket, sendVia)
  handle(peer, { type: 'segments-chunk', segments: [{ rows: [{ id: 'b', seq: 7 }] }], final: true }, socket, sendVia)
  const ack = socket.sent.find((m) => m.type === 'ack')
  assert.equal(ack.applied, 2, 'no pushId: unchanged legacy accumulation')
})
