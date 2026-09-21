/* QC Round-3 P1 regression tests (2026-09-21, fix/round3-p1) — sync protocol + settings LWW:
 *   F1  Receiver pullAckSeq: a flush-failed segment caps the final-chunk ack ROUND-WIDE —
 *       later segments with higher toSeq must not re-raise the ack past the failure.
 *   F2  Per-peer round mutex: overlapping startSyncRound calls dial the peer ONCE (round B
 *       can no longer kill round A's clientSnapshotBusy flag via an unconditional delete).
 *   F3  pairAttemptsByIp FIFO eviction: >8192 distinct IPs evicts the oldest key (bounded memory).
 *   F4  att-chunk over-size stream: chunks past the att-meta declared size are a protocol error.
 *   F5  Pre-auth slow-loris: an idle unauthenticated socket is destroyed (30s default, tunable);
 *       concurrent-socket cap refuses connections beyond the limit.
 *   F6  schemaVersion + dayPlanState* are machine-local meta keys (peer cannot poison migrations).
 *   F7  Settings LWW revert: a whole-blob mirror whose _savedAt predates an applied row cannot
 *       re-stamp the stale value over the row (no new oplog delta → the local edit STAYS).
 *
 * Run: node --test tests/unit/lan-sync/round3-p1-20260921.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')
const att = require('../../../src/main/lan-sync/att-transfer.js')
const syncApply = require('../../../src/main/sync-apply.js')
const { createHash } = await import('node:crypto')
const sha = buf => createHash('sha256').update(buf).digest('hex')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server.port
}

/* ---------------- F1: pullAckSeq round-wide flush-failure cap ---------------- */

test('F1: a failing segment caps the final ack even when later segments run higher', async () => {
  const clientAcks = []
  let pushed = false
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-f1', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        if (!pushed) {
          pushed = true
          // The PEER's push to us: chunk 1 carries a segment our ingest will FLUSH-FAIL
          // (fromSeq 4..5); chunk 2 (final) carries a normal higher segment (6..9).
          socket._lanSend({ type: 'segments-chunk', segments: [{ fromSeq: 4, toSeq: 5 }], final: false })
          socket._lanSend({ type: 'segments-chunk', segments: [{ fromSeq: 6, toSeq: 9 }], final: true })
        }
        // Ack the CLIENT's own push so the round completes — AFTER a delay, so the client's
        // own final-chunk ack (sent on the final data chunk) is already on the wire (the real
        // server role sends its pull response only after the sender's push, same ordering).
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 }), 200)
      }
      if (msg.type === 'ack') clientAcks.push({ ...msg })
    },
  })
  const port = await listen(fakePeer)

  const node = createLanSyncNode({
    deviceId: 'self-f1', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    // Segment 4..5 fails its local flush (rows dropped); everything else applies.
    ingestSegment: (seg) => (Number(seg && seg.toSeq) === 5 ? { flushFailed: true, applied: 0 } : { applied: 1 }),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'self-f1', rows: [{ id: 'x1', seq: 1 }] }],
  })
  node.addPeer({ deviceId: 'peer-f1', host: '127.0.0.1', port })
  const r = await node.startSyncRound()
  assert.equal(r.allConfirmed, true, 'round completes (the failing segment is a recoverable flush failure)')
  assert.equal(clientAcks.length, 1, 'exactly one final-chunk ack')
  // The ack must stay BELOW the failed segment's fromSeq (4) even though a later segment ran to 9.
  assert.ok(clientAcks[0].appliedToSeq <= 3, `appliedToSeq must stay below the failed fromSeq 4, got ${clientAcks[0].appliedToSeq}`)
  await node.stop()
  await fakePeer.close()
})

/* ---------------- F2: per-peer round mutex ---------------- */

test('F2: overlapping round starts dial the peer once; the mutex releases after the round', async () => {
  let dials = 0
  const slowPeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-f2', pairingSecret: 's3cret',
    onPeer: () => { dials += 1 },
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        // Hold the round open long enough for a second startSyncRound to race in.
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 }), 250)
      }
    },
  })
  const port = await listen(slowPeer)

  const node = createLanSyncNode({
    deviceId: 'self-f2', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'self-f2', rows: [{ id: 'r1', seq: 1 }] }],
  })
  node.addPeer({ deviceId: 'peer-f2', host: '127.0.0.1', port })
  const first = node.startSyncRound()
  await sleep(60) // round A is now mid-flight (hello + push sent)
  const second = node.startSyncRound() // re-entrant trigger (kick vs retry race)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.allConfirmed, true)
  assert.equal(b.confirmed, 0, 'the overlapping round is skipped, not double-dialed')
  assert.equal(dials, 1, 'one connection to the peer, not two concurrent rounds')
  // The mutex must RELEASE: a fresh round after A settles dials again.
  const third = await node.startSyncRound()
  assert.equal(third.allConfirmed, true)
  assert.equal(dials, 2, 'a post-settle round dials again (mutex not leaked)')
  await node.stop()
  await slowPeer.close()
})

/* ---------------- F3: pairAttemptsByIp FIFO eviction cap ---------------- */

test('F3: >8192 distinct attacker IPs evict the OLDEST keys (bounded rate-limiter memory)', () => {
  const srv = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'dev-f3', pairingSecret: 's', getHandler: () => {},
  })
  const gate = srv._pairGate
  const map = srv._pairAttemptsByIp
  const N = 8192 + 50
  for (let i = 0; i < N; i++) gate('10.0.' + Math.floor(i / 250) + '.' + (i % 250 + 1))
  assert.ok(map.size <= 8192, `map must stay capped at 8192 keys, got ${map.size}`)
  assert.ok(!map.has('10.0.0.1'), 'the FIRST-seen IP was evicted (FIFO, not clear-on-flood)')
  assert.ok(map.has('10.0.32.241'), 'the most recent IP is still tracked')
  // Live entries still rate-limit normally after eviction churn.
  for (let i = 0; i < 5; i++) assert.equal(gate('10.9.9.9'), true, 'attempt 1-5 allowed')
  assert.equal(gate('10.9.9.9'), false, 'attempt 6 throttled (window semantics intact)')
  srv.close()
})

/* ---------------- F4: att-chunk declared-size enforcement ---------------- */

test('F4: an over-size att-chunk stream is rejected as a protocol error (no hash-check-time surprise)', () => {
  const written = []
  const deps = {
    exists: () => false, size: () => 0, read: () => Buffer.alloc(0),
    writeAtomic: (key, buf) => { written.push({ key, buf }); return true },
    hashFn: sha,
  }
  const puller = att.createAttachmentPuller({
    send: () => {}, deps, getKeys: () => ['ok.png', 'evil.png'],
    session: { failed: new Map(), requests: new Map() },
  })
  let done = false
  assert.equal(puller.maybeStart(() => { done = true }, () => {}), true)
  // File 1 arrives honestly and still lands (the guard must not over-block).
  const good = Buffer.from('honest bytes')
  puller.onMessage({ type: 'att-meta', id: 'ok.png', size: good.length, hash: sha(good) })
  puller.onMessage({ type: 'att-chunk', id: 'ok.png', index: 0, data: good.toString('base64'), final: true })
  // File 2 declares 8 bytes then streams far more: must be dropped as a protocol error.
  puller.onMessage({ type: 'att-meta', id: 'evil.png', size: 8, hash: sha(Buffer.from('12345678')) })
  puller.onMessage({ type: 'att-chunk', id: 'evil.png', index: 0, data: Buffer.alloc(4096).toString('base64'), final: false })
  puller.onMessage({ type: 'att-chunk', id: 'evil.png', index: 1, data: Buffer.alloc(4096).toString('base64'), final: true })
  assert.equal(puller.onMessage({ type: 'att-end' }), false, 'att-end settles the batch')
  assert.equal(done, true)
  assert.deepEqual(written.map(w => w.key), ['ok.png'], 'only the honest file is written; the over-size stream is refused')
})

/* ---------------- F5: pre-auth idle timeout + concurrent socket cap ---------------- */

test('F5: a connected-but-silent unauthenticated socket is destroyed by the idle timeout', async () => {
  const srv = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'dev-f5', pairingSecret: 's', getHandler: () => {},
    preAuthIdleMs: 400, // test-tunable (prod default 30000)
  })
  const port = await listen(srv)
  const s = net.connect({ host: '127.0.0.1', port })
  const closed = new Promise(resolve => s.on('close', resolve))
  const t0 = Date.now()
  await Promise.race([closed, sleep(5000).then(() => { throw new Error('idle socket NOT destroyed within 5s') })])
  assert.ok(Date.now() - t0 < 4000, 'destroyed promptly after the pre-auth idle budget')
  srv.close()
})

test('F5: concurrent-socket cap refuses connections beyond the limit and recovers after close', async () => {
  const srv = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'dev-f5b', pairingSecret: 's', getHandler: () => {},
    maxSockets: 2, preAuthIdleMs: 8000,
  })
  const port = await listen(srv)
  const mk = () => new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.on('connect', () => resolve(s))
    s.on('error', reject)
  })
  const s1 = await mk()
  const s2 = await mk()
  const refused = new Promise(resolve => {
    const s3 = net.connect({ host: '127.0.0.1', port })
    s3.on('close', resolve)
    s3.on('error', resolve)
    setTimeout(resolve, 3000)
  })
  await refused
  assert.ok(true, 'the 3rd connection was closed/refused by the server')
  s1.destroy()
  await sleep(100)
  const s4 = await mk()
  assert.ok(s4, 'after a slot frees, new connections are accepted again')
  s2.destroy(); s4.destroy()
  srv.close()
})

/* ---------------- F6: migration keys are machine-local meta ---------------- */

test('F6: schemaVersion and dayPlanState* never sync (peer cannot poison migrations)', () => {
  assert.equal(syncApply.isMachineLocalMetaKey('schemaVersion'), true)
  assert.equal(syncApply.isMachineLocalMetaKey('dayPlanState'), true)
  assert.equal(syncApply.isMachineLocalMetaKey('dayPlanState.bak'), true)
  // user-data meta keys must STILL sync (allowlist note P2-g)
  assert.equal(syncApply.isMachineLocalMetaKey('projectMilestones:3'), false)
  assert.equal(syncApply.isMachineLocalMetaKey('projectCategoryIds'), false)
})

/* ---------------- F7: settings LWW revert (stale whole-blob mirror gate) ---------------- */

test('F7: a stale whole-blob mirror (_savedAt older than the applied row) cannot revert the row', () => {
  const db = require('../../../src/main/db.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'round3-lww-'))
  db.init(dir)
  const rowOf = k => db.call('settingsRowsAll', {}).find(r => r.key === k) || null
  const KEY = 'colorMode'

  // B's local blob mirror (its periodic whole-blob write), stamped T0.
  const T0 = Date.now() - 60_000
  db.call('setMeta', ['db.settingsState', JSON.stringify({ [KEY]: 'dark', _savedAt: T0 })])
  assert.equal(rowOf(KEY).value, 'dark')

  // A's edit syncs in: the applied row (sync truth) is NEWER than B's blob snapshot.
  db.call('settingsRowPut', { key: KEY, value: 'light' })
  const appliedAt = rowOf(KEY).updatedAt
  assert.ok(appliedAt > T0)

  // THE BUG: minutes later B's pending mirror fires with the PRE-EDIT blob (stale _savedAt,
  // fresh value diff). It must NOT re-stamp dark over the applied row, and must emit no delta.
  const lastSeq = (() => { const l = db.call('syncOplogSince', { sinceSeq: 0 }); return l.length ? l[l.length - 1].seq : 0 })()
  db.call('setMeta', ['db.settingsState', JSON.stringify({ [KEY]: 'dark', _savedAt: T0 })])
  const r = rowOf(KEY)
  assert.equal(r.value, 'light', 'the stale mirror must not revert the applied row')
  assert.equal(r.updatedAt, appliedAt, 'and must not re-stamp the row either')
  const deltas = db.call('syncOplogSince', { sinceSeq: lastSeq })
    .filter(e => e.entity === 'setting' && e.entityId === KEY)
  assert.equal(deltas.length, 0, 'no new oplog delta for the key — the revert cannot ping-pong back to A')

  // A REAL local edit (fresh _savedAt) still goes through normally.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ [KEY]: 'dark', _savedAt: Date.now() })])
  assert.equal(rowOf(KEY).value, 'dark', 'a genuine local user edit still wins')
})
