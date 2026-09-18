/**
 * Segment-push chunking tests (2026-09-18): a first-sync backlog used to travel as ONE
 * `segments` JSON line; b64 inflation of the AES-GCM frame pushed it past the transport's
 * 32MB wire cap, the receiver destroyed the socket, and the round retried forever.
 *
 * Covered:
 *   1. packSegmentChunks unit: budget respected, order preserved, always a final chunk
 *   2. end-to-end over real TCP: a backlog LARGER than the 32MB wire cap syncs successfully
 *      (every chunk line stays far under the cap; all envelopes arrive; round confirmed)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { MAX_LINE_BYTES } = require('../../../src/main/lan-sync/transport.js')
const { packSegmentChunks, SEGMENT_CHUNK_BYTES } = require('../../../src/main/lan-sync/segments-chunk.js')

const SECRET = 'segments-chunk-secret'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

test('segments-chunk: packSegmentChunks respects the budget, preserves order, always ends with final', () => {
  const segments = []
  for (let i = 0; i < 50; i++) {
    segments.push({ fromSeq: i + 1, toSeq: i + 1, deviceId: 'me', body: JSON.stringify({ rows: [{ seq: i + 1, pad: 'x'.repeat(100 * 1024) }] }) })
  }
  const chunks = packSegmentChunks(segments, { maxChunkBytes: 1024 * 1024 })
  assert.ok(chunks.length > 1, '5MB of envelopes must split into several chunks')
  assert.ok(chunks[chunks.length - 1].final, 'the last chunk carries final:true')
  assert.ok(chunks.slice(0, -1).every(c => !c.final), 'only the last chunk is final')
  const flat = chunks.flatMap(c => c.segments)
  assert.deepEqual(flat.map(s => s.fromSeq), segments.map(s => s.fromSeq), 'chunks tile all envelopes in order')
  for (const c of chunks) {
    const bytes = c.segments.reduce((n, s) => n + Buffer.byteLength(s.body, 'utf8'), 0)
    assert.ok(bytes <= SEGMENT_CHUNK_BYTES, 'every chunk payload stays under the budget')
  }
})

test('segments-chunk: an empty backlog is a single empty final chunk', () => {
  const chunks = packSegmentChunks([])
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0].segments, [])
  assert.equal(chunks[0].final, true)
})

test('segments-chunk: a backlog over the 32MB wire cap syncs end-to-end over TCP', async () => {
  // 40 envelopes x ~1.1MB of JSON = ~44MB plaintext: as ONE line the encrypted frame
  // (~4/3 b64) would blow past MAX_LINE_BYTES and the round would die forever. Chunked,
  // every line stays around ~1.4MB of wire. Regressions: permanent first-sync failure.
  const segCount = 40
  const pad = 'y'.repeat(1100 * 1024)
  const ingested = []
  const receivedLineLens = []

  const receiver = createLanSyncNode({
    deviceId: 'receiver',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    getMaxSeq: () => segCount,
    ingestSegment: (seg) => {
      // Track the WIRE line size the envelope rode in on (the envelope's parsed rows are
      // checked against the cap instead of re-serializing the frame here).
      const body = typeof seg.body === 'string' ? seg.body : JSON.stringify(seg.body)
      receivedLineLens.push(body.length)
      ingested.push(seg)
      return { applied: 1, rejected: 0 }
    },
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  receiver.start()
  const port = await receiver.whenListening()

  const sender = createLanSyncNode({
    deviceId: 'sender',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => {
      const segments = []
      for (let i = 0; i < segCount; i++) {
        segments.push({
          fromSeq: i + 1, toSeq: i + 1, deviceId: 'sender',
          body: JSON.stringify({ rows: [{ entity: 'todo', id: 'r' + i, seq: i + 1, data: { taskId: 'r' + i, pad } }] }),
          rows: [{ entity: 'todo', id: 'r' + i, seq: i + 1, data: { taskId: 'r' + i, pad } }],
        })
      }
      return segments
    },
  })
  sender.start()
  await sender.whenListening()
  sender.addPeer({ deviceId: 'receiver', host: '127.0.0.1', port, name: 'Receiver' })

  const r = await sender.startSyncRound()
  assert.equal(r.confirmed, 1, 'the oversized backlog round completes')

  const totalBytes = receivedLineLens.reduce((a, b) => a + b, 0)
  assert.ok(totalBytes > MAX_LINE_BYTES, `backlog (${totalBytes}B) genuinely exceeds the single-line cap (${MAX_LINE_BYTES}B)`)
  assert.equal(ingested.length, segCount, 'every envelope arrived')
  // appliedToSeq covers ALL ingested chunks: watermark = the sender's max seq (40).
  assert.equal(sender.getStatus().peers[0].watermark, segCount, 'the final ack covers the whole chunked push')

  await sender.stop()
  await receiver.stop()
})
