/*
 * Sync v2 acceptance — relay ack / GC / payload limits on a loopback relay (2026-10-10).
 *
 * Same loopback relay-server shape as fix-20261009-relay-ack-clamp-hardening.test.mjs:
 * a REAL relay server (server/sync-relay.mjs) on 127.0.0.1 with an ephemeral port and an
 * in-memory store. No production network, no real accounts.
 *
 * v2-critical scenarios pinned here:
 *   R1 multi-device GC floor — one device acking ahead must NOT gc envelopes another
 *      device still needs (the floor is the MIN across active devices)
 *   R2 restricted / oversize payload — a push over the serialized budget gets a coded
 *      rejection, never a silent drop, and small pushes keep flowing after it
 *   R3 pull resume — pull with an old cursor replays the full retained history,
 *      duplicated pull is idempotent client-side by opId (relay keeps envelopes)
 *   R4 register → push → ack → status lifecycle round-trip on one account, two devices
 *
 * Run: node --test tests/unit/lan-sync/v2-acceptance-relay.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const relayUrl = pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')).href
const { memoryStore, createRelay, startRelayServer } = await import(relayUrl)

async function post (url, body, headers = {}) {
  // connection:close — same undici keep-alive teardown abort as the ack-clamp suite.
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function boot () {
  const store = memoryStore()
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  const reg = async (account, device) => {
    const r = await post(url + '/v1/device/register', { account, device })
    assert.equal(r.status, 200, 'register ok')
    return { authorization: `Bearer ${r.json.device.deviceSecret}` }
  }
  return { store, relay, server, url, reg, close: () => server.close() }
}

test('R1 GC floor: a fast device acking ahead never gc-es envelopes a slower device still needs', async () => {
  const r = await boot()
  try {
    const auth1 = await r.reg('acc-r1', 'dev-fast')
    const auth2 = await r.reg('acc-r1', 'dev-slow')
    for (let i = 1; i <= 10; i++) {
      const p = await post(r.url + '/v1/sync/push', { account: 'acc-r1', device: 'dev-fast', items: [{ opId: `op-${i}`, envelope: JSON.stringify({ v: i }) }] }, auth1)
      assert.equal(p.status, 200)
    }
    assert.equal(r.store.lastSeq(), 10)
    // fast device acks everything
    const ack = await post(r.url + '/v1/sync/ack', { account: 'acc-r1', device: 'dev-fast', ackSeq: 10 }, auth1)
    assert.equal(ack.status, 200)
    // slow device has acked nothing: gc floor must stay at 0, all 10 envelopes retained
    assert.equal(r.store.gcFloor('acc-r1'), 0, 'floor = min across active devices, not max')
    const since = r.store.getSince('acc-r1', 0, 1000)
    assert.equal(since.length, 10, 'slow device can still replay the full history')
    assert.ok(r.store.getSince('acc-r1', 4, 1000).length >= 6, 'everything after the slow ack survives')
    const ack2 = await post(r.url + '/v1/sync/ack', { account: 'acc-r1', device: 'dev-slow', ackSeq: 4 }, auth2)
    assert.equal(ack2.status, 200)
    const floor = r.store.gcFloor('acc-r1')
    assert.ok(floor <= 4, `floor (${floor}) never exceeds the slowest active device ack (4)`)
    assert.ok(r.store.getSince('acc-r1', 4, 1000).length >= 6, 'everything after the slow ack survives')
  } finally { r.close() }
})

test('R2 oversize push: coded rejection, no silent drop, small pushes still flow after it', async () => {
  const r = await boot()
  try {
    const auth = await r.reg('acc-r2', 'dev-1')
    const small = await post(r.url + '/v1/sync/push', { account: 'acc-r2', device: 'dev-1', items: [{ opId: 'ok-1', envelope: JSON.stringify({ v: 1 }) }] }, auth)
    assert.equal(small.status, 200)
    // build a single item far over any plausible serialized budget (fill until ~9MB)
    const big = 'x'.repeat(9 * 1024 * 1024)
    const oversize = await post(r.url + '/v1/sync/push', { account: 'acc-r2', device: 'dev-1', items: [{ opId: 'big-1', envelope: JSON.stringify({ blob: big }) }] }, auth)
    assert.ok(oversize.status >= 400 && oversize.status < 500 && oversize.status !== 404,
      `oversize push rejected with a coded 4xx (got ${oversize.status}); a silent 200 or a 5xx hang are both findings`)
    // the relay is still healthy for normal traffic after the rejection
    const after = await post(r.url + '/v1/sync/push', { account: 'acc-r2', device: 'dev-1', items: [{ opId: 'ok-2', envelope: JSON.stringify({ v: 2 }) }] }, auth)
    assert.equal(after.status, 200, 'small push flows after oversize rejection')
    assert.ok(r.store.getSince('acc-r2', 0, 1000).some(e => JSON.parse(e.envelopeJson).v === 2), 'ok-2 retained')
  } finally { r.close() }
})

test('R3 pull with an old cursor replays the full retained history; duplicate pulls are idempotent by opId', async () => {
  const r = await boot()
  try {
    const auth = await r.reg('acc-r3', 'dev-1')
    for (let i = 1; i <= 6; i++) {
      await post(r.url + '/v1/sync/push', { account: 'acc-r3', device: 'dev-1', items: [{ opId: `op-${i}`, envelope: JSON.stringify({ v: i }) }] }, auth)
    }
    // relay HTTP pull contract (server/sync-relay.mjs route): the cursor is
    // `afterSeq` and the budget is `maxBytes` (bytes), NOT the local-db oplog
    // params (sinceSeq/limit). SinceSeq/limit are silently ignored by the relay
    // route, which would default afterSeq to 0 and replay the whole history.
    const first = await post(r.url + '/v1/sync/pull', { account: 'acc-r3', device: 'dev-1', afterSeq: 0 }, auth)
    assert.equal(first.status, 200)
    const replay = await post(r.url + '/v1/sync/pull', { account: 'acc-r3', device: 'dev-1', afterSeq: 0 }, auth)
    assert.equal(replay.status, 200)
    const a = first.json.items ?? first.json.rows ?? []
    const b = replay.json.items ?? replay.json.rows ?? []
    assert.equal(a.length, 6, 'full history on cursor 0')
    assert.deepEqual(b, a, 'identical replay: relay is stateless per pull, dedupe is client-side by opId')
    // mid-cursor pull returns only the tail
    const tail = await post(r.url + '/v1/sync/pull', { account: 'acc-r3', device: 'dev-1', afterSeq: 4 }, auth)
    const t = tail.json.items ?? []
    assert.ok(t.length >= 1 && t.every(e => e.serverSeq > 4), 'tail pull returns only serverSeq > afterSeq')
  } finally { r.close() }
})

test('R4 lifecycle: register → push → ack → state(retired) round-trips for two devices on one account', async () => {
  const r = await boot()
  try {
    const auth1 = await r.reg('acc-r4', 'dev-a')
    const auth2 = await r.reg('acc-r4', 'dev-b')
    assert.notEqual(auth1.authorization, auth2.authorization, 'per-device secrets')
    await post(r.url + '/v1/sync/push', { account: 'acc-r4', device: 'dev-a', items: [{ opId: 'x1', envelope: '{}' }] }, auth1)
    const ack = await post(r.url + '/v1/sync/ack', { account: 'acc-r4', device: 'dev-a', ackSeq: 1 }, auth1)
    assert.equal(ack.status, 200)
    const retire = await post(r.url + '/v1/device/state', { account: 'acc-r4', device: 'dev-b', status: 'retired' }, auth2)
    assert.equal(retire.status, 200)
    assert.equal(r.store.getDevice('acc-r4', 'dev-b').status, 'retired')
    assert.equal(r.store.getDevice('acc-r4', 'dev-a').status, 'active')
    // retired device no longer pins the gc floor; active device's ack drives it
    await post(r.url + '/v1/sync/ack', { account: 'acc-r4', device: 'dev-a', ackSeq: 1 }, auth1)
    assert.ok(r.store.gcFloor('acc-r4') >= 1, 'floor advances off the retired device')
  } finally { r.close() }
})
