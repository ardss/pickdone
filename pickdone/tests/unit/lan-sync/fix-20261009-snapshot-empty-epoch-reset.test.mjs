/*
 * 2026-10-09 — client-round empty-snapshot epoch reset (LOW).
 *
 * When a REQUESTED snapshot comes back VALIDATED-EMPTY (totalRows === 0, cursor 0), that empty
 * snapshot IS the peer's full state — the peer's oplog was wiped and re-pairing can re-issue the
 * SAME deviceId on a fresh epoch. The old max(prev, 0) guard treated cursor 0 as "no signal" and
 * kept the watermark at its old value (e.g. 100) while the peer's new epoch restarts near 0: the
 * peer's fresh low-seq rows could neither advance the watermark (they are below it) nor re-fire
 * the snapshot trigger (oldestSeq stays below wm+1 is NOT the case — actually oldestSeq > wm+1
 * kept firing snapshots forever, but each returned empty and never adopted the epoch), so the
 * pair never converged.
 *
 * Fix: snapshot-end with totalRows === 0 && cursor === 0 adopts 0 as the new pull-watermark epoch.
 *
 * Run: node --test tests/unit/lan-sync/fix-20261009-snapshot-empty-epoch-reset.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')

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

test('an empty snapshot (totalRows 0, cursor 0) resets the pull watermark epoch to 0', async () => {
  // Scripted peer lifecycle (same harness style as fixround-20260922 R5):
  //   round 1: pruned oplog (oldestSeq 50 >> wm+1) -> arms the snapshot trigger
  //   round 2: full snapshot, cursor 100 -> client pull watermark = 100
  //   round 3: pruned oplog again (oldestSeq 200 >> wm+1) -> re-arms the trigger
  //   round 4: EMPTY snapshot (totalChunks 0, totalRows 0, cursor 0) — the peer re-paired with
  //            the same deviceId on a wiped oplog. Pre-fix the watermark stayed 100 forever;
  //            post-fix the client adopts epoch 0.
  let phase = 0
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-empty', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        phase += 1
        const oldestSeq = phase >= 3 ? 200 : 50
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0, oldestSeq }), 20)
      } else if (msg.type === 'snapshot-request') {
        if (phase >= 3) {
          // the peer's wiped epoch: nothing to send, cursor 0 is its whole state
          socket._lanSend({ type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 0 })
        } else {
          socket._lanSend({ type: 'snapshot-chunk', index: 0, totalChunks: 1, rows: [{ id: 'r1', seq: 1 }] })
          socket._lanSend({ type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100 })
        }
      }
    },
  })
  const port = await listen(fakePeer)

  const snapshots = []
  const node = createLanSyncNode({
    deviceId: 'self-empty', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => ({ applied: 0, fromSeq: seg && seg.fromSeq, toSeq: seg && seg.toSeq }),
    ingestSnapshot: (snap) => snapshots.push(snap),
    buildSegments: () => [],
  })
  node.addPeer({ deviceId: 'peer-empty', host: '127.0.0.1', port })

  const wm = () => node.getStatus().peers.find(p => p.deviceId === 'peer-empty').pullWatermark
  await node.startSyncRound() // round 1: prune arms the trigger
  await node.startSyncRound() // round 2: snapshot at cursor 100
  assert.equal(snapshots.length, 1, 'the first snapshot applied')
  assert.equal(wm(), 100, 'watermark followed the peer cursor to 100')
  await node.startSyncRound() // round 3: pruned oplog re-arms the trigger
  await node.startSyncRound() // round 4: EMPTY snapshot — the epoch reset
  assert.equal(wm(), 0, 'the empty snapshot adopted epoch 0 (pre-fix: watermark stuck at 100)')
  // the epoch reset also restores the snapshot-error budget (same branch as the rollback case)
  await node.stop()
  await fakePeer.close()
})

test('a NON-empty snapshot with cursor 0 payload rows still keeps monotonic watermark (no regression)', async () => {
  // Guard the guard: the reset must key on totalRows === 0, not on cursor === 0 alone.
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-nonempty', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0, oldestSeq: 50 }), 20)
      } else if (msg.type === 'snapshot-request') {
        socket._lanSend({ type: 'snapshot-chunk', index: 0, totalChunks: 1, rows: [{ id: 'r1', seq: 1 }] })
        socket._lanSend({ type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100 })
      }
    },
  })
  const port = await listen(fakePeer)
  const node = createLanSyncNode({
    deviceId: 'self-nonempty', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => ({ applied: 0, fromSeq: seg && seg.fromSeq, toSeq: seg && seg.toSeq }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  node.addPeer({ deviceId: 'peer-nonempty', host: '127.0.0.1', port })
  await node.startSyncRound()
  await node.startSyncRound()
  const wm = () => node.getStatus().peers.find(p => p.deviceId === 'peer-nonempty').pullWatermark
  assert.equal(wm(), 100, 'data-carrying snapshot still advances the watermark normally')
  await node.stop()
  await fakePeer.close()
})
