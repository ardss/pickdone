/*
 * 2026-10-09 — relay-client push chunking (P1).
 *
 * relay-client round() used to push EVERY unpushed revision in ONE POST /v1/sync/push. The relay
 * rejects bodies over its 8MB cap with 413 — and because the oversized batch was never marked
 * pushed, the SAME batch rebuilt identically on every round: a permanent sync break (413 forever).
 *
 * Fix: chunkPushItems() (pure, exported for tests) splits items into consecutive chunks under a
 * ~4MB serialized-byte budget (PUSH_CHUNK_BYTES), and round() POSTs one chunk at a time, marking
 * each chunk's ids into the pushed-set ONLY after that chunk's 200 (same per-chunk invariant as
 * the old whole-batch invariant: a failed chunk's revisions re-push next round).
 *
 * Run: node --test tests/unit/lan-sync/fix-20261009-relay-client-push-chunking.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const mod = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))
const { chunkPushItems, PUSH_CHUNK_BYTES, createRelayClient } = mod

const item = (n, size) => ({ opId: `op-${n}`, envelope: 'x'.repeat(size) })

test('chunkPushItems: consecutive items tile into chunks under the byte budget', () => {
  const KB = 1024
  const items = [item(1, 3 * 1024), item(2, 2 * 1024), item(3, 2 * 1024), item(4, 1024)]
  const chunks = chunkPushItems(items, 4 * KB)
  assert.deepEqual(chunks.map(c => c.ids), [['op-1'], ['op-2', 'op-3'], ['op-4']],
    'greedy packing: each chunk stays <= budget, order preserved')
  assert.deepEqual(chunks.map(c => c.items.map(i => i.opId)), chunks.map(c => c.ids),
    'items mirror ids (the wire payload per chunk)')
  for (const c of chunks) assert.ok(c.bytes <= 4 * KB, `chunk bytes ${c.bytes} within budget`)
  assert.deepEqual(chunks.flatMap(c => c.ids), ['op-1', 'op-2', 'op-3', 'op-4'], 'no item lost or duplicated')
})

test('chunkPushItems: a single item over the budget still gets its own chunk (never dropped)', () => {
  const KB = 1024
  const chunks = chunkPushItems([item(1, 5 * KB), item(2, KB), item(3, 6 * KB)], 4 * KB)
  assert.deepEqual(chunks.map(c => c.ids), [['op-1'], ['op-2'], ['op-3']],
    'oversize items are sent ALONE (relay per-item oversize handling is the only failure mode)')
})

test('chunkPushItems: empty input -> no chunks; default budget is the exported PUSH_CHUNK_BYTES', () => {
  assert.deepEqual(chunkPushItems([]), [])
  const one = chunkPushItems([item(1, 10)])
  assert.deepEqual(one.map(c => c.ids), [['op-1']])
  assert.equal(one[0].bytes, 10)
  assert.equal(PUSH_CHUNK_BYTES, 4 * 1024 * 1024, '~4MB per POST, under the relay 8MB body cap')
})

test('round() pushes in multiple POSTs under a tight relay cap and marks pushed per chunk', async () => {
  const MB = 1024 * 1024
  const RELAY_CAP = 5 * MB // a (hostile) relay that 413s bodies over 5MB — the old single POST was 6MB
  const pushes = [] // recorded opId lists per push POST
  const fetchImpl = async (url, opts = {}) => {
    const p = new URL(url).pathname
    const body = JSON.parse(opts.body || '{}')
    const json = obj => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }))
    if (p === '/v1/device/register') return json({ device: { deviceSecret: 's' } })
    if (p === '/v1/sync/push') {
      if (Buffer.byteLength(opts.body || '') > RELAY_CAP) return new Response(JSON.stringify({ error: 'request body too large' }), { status: 413 })
      pushes.push(body.items.map(i => i.opId))
      return json({ acked: {}, serverSeq: 100 })
    }
    if (p === '/v1/sync/pull') return json({ fromSeq: 1, toSeq: 0, headSeq: 100, items: [], skipped: [] })
    if (p === '/v1/sync/ack') return json({ acked: body.ackSeq, gcRemoved: 0 })
    return json({})
  }

  const client = createRelayClient({ nodeId: 'dev-c', account: 'acc-chunk', baseUrl: 'http://relay.test', fetchImpl })
  await client.register()
  // two 3MB envelopes: single-POST push = 6MB body -> 413 forever; chunked = two 3MB POSTs
  await client.commit('t1', { blob: 'a'.repeat(3 * MB) })
  await client.commit('t2', { blob: 'b'.repeat(3 * MB) })

  const r1 = await client.round()
  assert.equal(r1.pushed, 2, 'both revisions reported pushed')
  assert.equal(pushes.length, 2, 'the push left the wire as TWO POSTs (pre-fix: one 6MB POST, 413)')
  assert.deepEqual(pushes.map(ids => ids.length), [1, 1], 'one revision per chunk at these sizes')

  // per-chunk marking: everything accepted is marked, so the next round re-pushes nothing
  await client.round()
  assert.equal(pushes.length, 2, 'no re-push after full acceptance (pushed-set intact)')
})

test('round(): a mid-chunk failure marks ONLY the accepted chunk — the rest re-pushes next round', async () => {
  const pushes = []
  let failOnChunk = -1 // index of the push chunk to reject (per round)
  const fetchImpl = async (url, opts = {}) => {
    const p = new URL(url).pathname
    const body = JSON.parse(opts.body || '{}')
    const json = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }))
    if (p === '/v1/device/register') return json({ device: { deviceSecret: 's' } })
    if (p === '/v1/sync/push') {
      const idx = pushes.length
      pushes.push(body.items) // full items — markerOf reads the payload markers
      if (idx === failOnChunk) return json({ error: 'nope' }, 500)
      return json({ acked: {}, serverSeq: 10 })
    }
    if (p === '/v1/sync/pull') return json({ fromSeq: 1, toSeq: 0, headSeq: 10, items: [], skipped: [] })
    if (p === '/v1/sync/ack') return json({ acked: body.ackSeq, gcRemoved: 0 })
    return json({})
  }
  // small budget is not injectable through the client (PUSH_CHUNK_BYTES is the policy), so use
  // envelopes that each exceed the real 4MB budget -> each is its own chunk
  // opIds are HLC revisionIds (not the entity ids), so identify revisions by a marker char in
  // their payload — each envelope is 5MB > the 4MB budget, so each is its own chunk.
  const markerOf = (items) => {
    const raw = JSON.stringify(items)
    for (const ch of ['a', 'b', 'c']) if (raw.includes(`"${ch}${ch}${ch}`)) return ch
    return '?'
  }
  const client = createRelayClient({ nodeId: 'dev-c2', account: 'acc-chunk2', baseUrl: 'http://relay.test', fetchImpl })
  await client.register()
  for (const ch of ['a', 'b', 'c']) await client.commit(`t-${ch}`, { blob: ch.repeat(5 * 1024 * 1024) })

  failOnChunk = 1 // chunk 0 (a) accepted, chunk 1 (b) rejected -> round() throws before chunk 2
  await assert.rejects(() => client.round(), /500/, 'the failed chunk propagates the error')
  assert.deepEqual(pushes.map(markerOf), ['a', 'b'], 'chunks pushed in order until the failure')

  // round 2: only the FAILED chunk's revisions re-push; accepted ones stay marked
  failOnChunk = -1
  await client.round()
  const round2Pushes = pushes.slice(2)
  assert.equal(round2Pushes.length, 2, 'remaining revisions (b retried + c) push in round 2')
  assert.deepEqual(round2Pushes.map(markerOf), ['b', 'c'],
    'ONLY the unmarked revisions re-push — accepted chunk stays marked (per-chunk marking)')
})
