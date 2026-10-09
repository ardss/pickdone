/*
 * 2026-10-09 relay hardening round (4 fixes, all in server/sync-relay.mjs):
 *   F1 (P1) ack clamp — /v1/sync/ack used to accept ANY integer ackSeq; lastAck = max(prev, ackSeq)
 *       then drove gcCutFloor (ackFloor - GC_ACK_ALONE_MARGIN), so a hostile/buggy ackSeq = 1e12 made
 *       gc() delete EVERY envelope with seq <= that for the whole account (cross-device data loss,
 *       logged as success). ackSeq is now clamped to [0, store.lastSeq()] — the same gate the snapshot
 *       coversSeq route already had (shared root cause: a client may only reference issued seqs).
 *   F2 (P2) device-status whitelist — /v1/device/state persisted any caller-sent status string; a
 *       non-'active' status permanently excluded the device from the gc floor (floor pinned to 0 →
 *       unbounded envelope growth). Only 'active' | 'retired' are accepted now (400 otherwise).
 *   F3 (P2) registerHits FIFO cap — the register rate-limit IP map grew forever on one-time/spoofed
 *       IPs; now capped (REGISTER_IP_CAP, oldest-inserted evicted first, mirroring the transport.js
 *       PAIR_IP_KEY_CAP pattern) via the exported, unit-testable createRegisterLimiter().
 *   F4 (P2) connection budget — server.maxConnections = 64 in startRelayServer().
 *
 * Run: node --test tests/unit/lan-sync/fix-20261009-relay-ack-clamp-hardening.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const relayUrl = pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')).href
const { memoryStore, createRelay, startRelayServer, createRegisterLimiter, REGISTER_IP_CAP } = await import(relayUrl)

async function post (url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test('F1: a huge ackSeq cannot raise lastAck above lastSeq and gc keeps the envelopes', async () => {
  const store = memoryStore()
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const reg = await post(url + '/v1/device/register', { account: 'acc-ack', device: 'dev-1' })
    assert.equal(reg.status, 200)
    const secret = reg.json.device.deviceSecret
    const auth = { authorization: `Bearer ${secret}` }

    // three real envelopes on the account
    for (let i = 1; i <= 3; i++) {
      const r = await post(url + '/v1/sync/push', { account: 'acc-ack', device: 'dev-1', items: [{ opId: `op-${i}`, envelope: JSON.stringify({ v: i }) }] }, auth)
      assert.equal(r.status, 200)
    }
    assert.equal(store.lastSeq(), 3)

    // hostile/buggy ack: ackSeq way beyond relay history. Pre-fix this set lastAck = 1e12 and
    // gc() wiped seq 1..(1e12 - 100000) — i.e. everything.
    const bad = await post(url + '/v1/sync/ack', { account: 'acc-ack', device: 'dev-1', ackSeq: 1e12 }, auth)
    assert.equal(bad.status, 400, 'oversized ackSeq is rejected with a coded 4xx')
    assert.equal(store.getDevice('acc-ack', 'dev-1').lastAck, 0, 'lastAck did not move')
    assert.equal(store.gcFloor('acc-ack'), 0)
    const since = store.getSince('acc-ack', 0, 1000)
    assert.equal(since.length, 3, 'gc kept every envelope (pre-fix: all deleted, silent data loss)')

    // a legitimate ack still works
    const ok = await post(url + '/v1/sync/ack', { account: 'acc-ack', device: 'dev-1', ackSeq: 2 }, auth)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.acked, 2)
    // direct createRelay callers get the same clamp (root-cause fix, not just the route)
    assert.equal(relay.ack('acc-ack', 'dev-1', 1e9).acked, 3, 'clamped to lastSeq')
  } finally {
    server.close()
  }
})

test('F2: /v1/device/state whitelists statuses; unknown statuses are rejected and never persisted', async () => {
  const store = memoryStore()
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const reg = await post(url + '/v1/device/register', { account: 'acc-st', device: 'dev-1' })
    const auth = { authorization: `Bearer ${reg.json.device.deviceSecret}` }

    const bad = await post(url + '/v1/device/state', { account: 'acc-st', device: 'dev-1', status: 'zombie' }, auth)
    assert.equal(bad.status, 400, 'unknown status rejected with a coded 4xx')
    assert.equal(store.getDevice('acc-st', 'dev-1').status, 'active', 'row still counts toward the gc floor')

    for (const status of ['active', 'retired']) {
      const r = await post(url + '/v1/device/state', { account: 'acc-st', device: 'dev-1', status }, auth)
      assert.equal(r.status, 200, `status ${status} accepted`)
      assert.equal(store.getDevice('acc-st', 'dev-1').status, status)
    }
    // back to active: the floor is live again
    assert.equal(store.gcFloor('acc-st'), 0)
  } finally {
    server.close()
  }
})

test('F3: the register rate-limiter caps tracked IPs FIFO (oldest evicted first)', () => {
  const limiter = createRegisterLimiter({ cap: 5, limit: 10, windowMs: 60_000 })
  for (let i = 0; i < 5; i++) assert.equal(limiter.allow(`10.0.0.${i}`), true)
  assert.equal(limiter.size(), 5)
  limiter.allow('10.0.0.99') // 6th distinct IP: cap exceeded -> oldest (10.0.0.0) evicted
  assert.equal(limiter.size(), 5, 'map stays at the cap')
  assert.equal(limiter.allow('10.0.0.0'), true, 'the evicted oldest IP was dropped (fresh entry, limit reset)')
  assert.equal(limiter.allow('10.0.0.1'), true)
  const realCap = createRegisterLimiter({ limit: 10, windowMs: 60_000 })
  for (let i = 0; i < REGISTER_IP_CAP + 50; i++) realCap.allow(`10.1.${i}.1`)
  assert.equal(realCap.size(), REGISTER_IP_CAP, 'default cap holds (8192) even under a spoofed-IP flood')
})

test('F4: the relay server sets a connection budget', async () => {
  const server = await startRelayServer(createRelay(memoryStore()), { port: 0, host: '127.0.0.1' })
  try {
    assert.equal(server.maxConnections, 64, 'maxConnections caps concurrent sockets')
  } finally {
    server.close()
  }
})

test('sanity: the touched files still parse (guards against a broken intermediate edit)', () => {
  for (const f of ['server/sync-relay-sqlite.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.ok(src.includes('gcCutFloor'), `${f} intact`)
  }
})
