/**
 * Unit tests for the extracted server-role handler (src/main/lan-sync/server-role.js):
 *   - the pull response is incremental: the peer's acks (appliedToSeq, OUR seq space) feed
 *     buildSegments(fromSeq) on the NEXT round instead of re-sending the full window;
 *   - snapshot transfer ceilings: more than maxSnapshotChunks chunks or more than
 *     maxSnapshotRows rows answers snapshot-error {reason:'too-large'}.
 * The handler is driven directly with stub deps + a fake socket (no TCP needed).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createServerRoleHandler } = require('../../../src/main/lan-sync/server-role.js')

function fakeSocket() {
  const sent = []
  return {
    sent,
    _lanSend: (msg) => sent.push(msg),
  }
}

function stubDeps(extra = {}) {
  const calls = { buildSegmentsFrom: [], ingested: [], ackedSeqs: [] }
  const deps = {
    ingestSegment: (seg) => { calls.ingested.push(seg); return { applied: 1, rejected: 0 } },
    buildSegments: (since) => { calls.buildSegmentsFrom.push(since); return [] },
    buildSnapshotRows: () => [],
    getMaxSeq: () => 100,
    getOldestSeq: () => 10,
    serverSnapshotBusy: new Set(),
    serverPullAck: new Map(),
    maxSnapshotChunks: 512,
    snapshotSchemaVersion: 1,
    pushRecent: () => {},
    onSnapshotError: () => {},
    onSnapshotSync: () => {},
    onServerError: () => {},
    ...extra,
  }
  return { deps, calls }
}

const peer = { deviceId: 'peer-1' }

test('server-role: pull response is incremental — the peer ack advances the next pull cursor', () => {
  const { deps, calls } = stubDeps()
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()

  // Round 1: the peer pushes rows (seq up to 3, SENDER's space); no ack for OUR rows yet.
  handle(peer, { type: 'segments-chunk', segments: [{ fromSeq: 1, toSeq: 3, rows: [{ id: 'a', seq: 3 }] }], final: true }, socket, (s, m) => socket._lanSend(m))
  assert.deepEqual(calls.buildSegmentsFrom, [undefined], 'round 1 pull covers the FULL window (unknown peer)')
  const ack1 = socket.sent.find((m) => m.type === 'ack')
  assert.equal(ack1.appliedToSeq, 3, 'ack reports the max seq among the SENDER\'s pushed rows')

  // The peer acks OUR push through seq 42 (OUR seq space).
  handle(peer, { type: 'ack', applied: 1, rejected: 0, appliedToSeq: 42 }, socket, (s, m) => socket._lanSend(m))
  assert.equal(deps.serverPullAck.get(peer.deviceId), 42, 'the ack is recorded per peer')

  // Round 2: the pull response starts PAST what the peer already has.
  handle(peer, { type: 'segments-chunk', segments: [], final: true }, socket, (s, m) => socket._lanSend(m))
  assert.deepEqual(calls.buildSegmentsFrom, [undefined, 42], 'round 2 pull starts past the acked seq')
})

test('server-role: pull cursor is clamped to our own max seq (a lying peer must not skip fresh rows)', () => {
  const { deps, calls } = stubDeps({ getMaxSeq: () => 30 })
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'ack', applied: 1, rejected: 0, appliedToSeq: 999 }, socket, (s, m) => socket._lanSend(m))
  handle(peer, { type: 'segments-chunk', segments: [], final: true }, socket, (s, m) => socket._lanSend(m))
  assert.deepEqual(calls.buildSegmentsFrom, [30], 'the pull cursor never exceeds our own max oplog seq')
})

test('server-role: snapshot with more than maxSnapshotRows rows answers too-large', () => {
  const { deps } = stubDeps({
    maxSnapshotRows: 2,
    buildSnapshotRows: () => [{ entity: 'todo', id: 'a' }, { entity: 'todo', id: 'b' }, { entity: 'todo', id: 'c' }],
  })
  const errors = []
  deps.onSnapshotError = (info) => errors.push(info)
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'snapshot-request' }, socket, (s, m) => socket._lanSend(m))
  const err = socket.sent.find((m) => m.type === 'snapshot-error')
  assert.ok(err, 'snapshot-error was sent')
  assert.equal(err.reason, 'too-large')
  assert.equal(errors[0] && errors[0].reason, 'too-large', 'the error is surfaced to the node')
  assert.ok(!socket.sent.some((m) => m.type === 'snapshot-end'), 'no snapshot-end follows a refused transfer')
  assert.ok(!deps.serverSnapshotBusy.has(peer.deviceId), 'the busy invariant is released')
})

test('server-role: snapshot that would exceed maxSnapshotChunks answers too-large', () => {
  // Three rows just under the 1MB chunk budget -> rowChunks yields 3 chunks; the ceiling is 2.
  const rows = [
    { entity: 'todo', id: 'a', data: 'x'.repeat(1024 * 1024 - 100) },
    { entity: 'todo', id: 'b', data: 'x'.repeat(1024 * 1024 - 100) },
    { entity: 'todo', id: 'c', data: 'x'.repeat(1024 * 1024 - 100) },
  ]
  const { deps } = stubDeps({ maxSnapshotChunks: 2, buildSnapshotRows: () => rows })
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'snapshot-request' }, socket, (s, m) => socket._lanSend(m))
  const err = socket.sent.find((m) => m.type === 'snapshot-error')
  assert.ok(err, 'snapshot-error was sent mid-stream')
  assert.equal(err.reason, 'too-large')
})

test('server-role: a snapshot-request while busy answers snapshot-busy and serves nothing', () => {
  const { deps } = stubDeps({ buildSnapshotRows: () => [{ entity: 'todo', id: 'a' }] })
  deps.serverSnapshotBusy.add(peer.deviceId)
  const handle = createServerRoleHandler(deps)
  const socket = fakeSocket()
  handle(peer, { type: 'snapshot-request' }, socket, (s, m) => socket._lanSend(m))
  assert.equal(socket.sent.length, 1)
  assert.equal(socket.sent[0].type, 'snapshot-busy')
})
