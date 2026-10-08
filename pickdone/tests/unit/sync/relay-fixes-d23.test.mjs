// Fix-round d23 (2026-10-06): regression tests for sync-relay.mjs robustness/security fixes.
// Covers: device re-register proof requirement (409 without proof, rotation with proof),
// coded EADDRINUSE listen failure, per-entry dump validation (quarantine), paged pull byte
// budget, and the snapshot-less GC ack-alone floor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryStore, fileStore, createRelay, startRelayServer } from '../../../server/sync-relay.mjs'

test('registerDevice: first registration is open, re-register requires proof', () => {
  const relay = createRelay(memoryStore())
  const first = relay.registerDevice('acct', 'dev1')
  assert.ok(first.deviceSecret && first.deviceSecret.length === 64)
  // No proof -> 409, and the OLD secret must remain valid (victim keeps access)
  assert.throws(() => relay.registerDevice('acct', 'dev1'), e => e.status === 409)
  relay.authorize('acct', 'dev1', 'Bearer ' + first.deviceSecret) // must not throw
  // Wrong proof -> 409
  assert.throws(() => relay.registerDevice('acct', 'dev1', { bodySecret: 'deadbeef' }), e => e.status === 409)
  // Correct body proof -> rotation works and the new secret is authoritative
  const rotated = relay.registerDevice('acct', 'dev1', { bodySecret: first.deviceSecret })
  assert.notEqual(rotated.deviceSecret, first.deviceSecret)
  relay.authorize('acct', 'dev1', 'Bearer ' + rotated.deviceSecret)
  assert.throws(() => relay.authorize('acct', 'dev1', 'Bearer ' + first.deviceSecret), e => e.status === 401)
  // Bearer proof also rotates
  const rotated2 = relay.registerDevice('acct', 'dev1', { bearerSecret: rotated.deviceSecret })
  assert.ok(rotated2.deviceSecret)
})

test('route /v1/device/register: 409 error reaches the HTTP surface without bearer', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const reg = await fetch(base + '/v1/device/register', { method: 'POST', body: JSON.stringify({ account: 'a', device: 'd' }) })
    const { device: { deviceSecret } } = await reg.json()
    assert.ok(deviceSecret)
    // Re-register WITHOUT proof -> 409 coded error
    const re = await fetch(base + '/v1/device/register', { method: 'POST', body: JSON.stringify({ account: 'a', device: 'd' }) })
    assert.equal(re.status, 409)
    const reBody = await re.json()
    assert.match(reBody.error, /device already registered/)
    // Victim's secret still works (protected route accepts it)
    const pull = await fetch(base + '/v1/sync/pull', { method: 'POST', headers: { authorization: 'Bearer ' + deviceSecret }, body: JSON.stringify({ account: 'a' }) })
    assert.equal(pull.status, 200)
    // Re-register WITH proof rotates
    const rot = await fetch(base + '/v1/device/register', { method: 'POST', headers: { authorization: 'Bearer ' + deviceSecret }, body: JSON.stringify({ account: 'a', device: 'd' }) })
    assert.equal(rot.status, 200)
  } finally { server.close() }
})

test('startRelayServer: double bind rejects with a coded EADDRINUSE error', async () => {
  const relay = createRelay(memoryStore())
  const s1 = await startRelayServer(relay, { port: 0 })
  const port = s1.address().port
  try {
    await assert.rejects(
      () => startRelayServer(relay, { port, host: '127.0.0.1' }),
      e => e.status === 503 && /EADDRINUSE/.test(e.message)
    )
  } finally { s1.close() }
})

test('413 handler does not double-write headers when a buffered chunk re-enters', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  try {
    // Oversized body (>8MB): the response must be exactly one 413, and the server must not crash
    const big = 'x'.repeat(9 * 1024 * 1024)
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/sync/pull`, { method: 'POST', body: big })
    assert.equal(res.status, 413)
    const body = await res.json()
    assert.match(body.error, /too large/)
  } finally { server.close() }
})

test('fileStore: dump with a malformed envelope entry is quarantined at boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-d23-'))
  try {
    const file = join(dir, 'relay-state.json')
    // One valid entry + one missing serverSeq: previously collapsed onto undefined key and
    // re-persisted; now the whole file must be quarantined and state start fresh.
    writeFileSync(file, JSON.stringify({
      seq: 2,
      envelopes: [
        { serverSeq: 1, account: 'a', opId: 'o1', envelopeJson: '{}' },
        { account: 'a', opId: 'o2', envelopeJson: '{}' },
      ],
      devices: [{ account: 'a', deviceId: 'd', deviceSecret: 's', lastAck: 0, lastSeen: 0, status: 'active' }],
      snapshots: [],
    }))
    const store = fileStore(dir)
    assert.equal(store.kind, 'file')
    assert.equal(store.lastSeq(), 0) // fresh state
    assert.ok(!store.getDevice('a', 'd')) // devices not loaded
    assert.ok(existsSync(file + '.bad'), 'corrupt dump quarantined to .bad')
    // The quarantined copy still holds the original content (forensics)
    const bad = JSON.parse(readFileSync(file + '.bad', 'utf8'))
    assert.equal(bad.envelopes.length, 2)
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('pull: small maxBytes only pages the head of a long history', () => {
  const store = memoryStore()
  const relay = createRelay(store)
  const items = []
  for (let i = 0; i < 1200; i++) {
    items.push({ opId: 'op-' + i, envelope: JSON.stringify({ i, pad: 'p'.repeat(100) }) })
  }
  relay.push('acct', 'dev', items)
  // Track getSince page sizes via a proxy store: the first page (500) must be enough to
  // satisfy a tiny byte budget — getSince must never be asked for 100000 rows.
  let maxLimitSeen = 0
  const paged = {
    ...store,
    getSince: (acct, after, limit) => { maxLimitSeen = Math.max(maxLimitSeen, limit); return store.getSince(acct, after, limit) },
  }
  const relay2 = createRelay(paged)
  const out = relay2.pull('acct', 0, 2000)
  assert.ok(out.items.length > 0 && out.items.length < 1200, 'byte clamp stops early')
  assert.ok(out.items.length <= 500, 'at most one page materialized')
  assert.ok(maxLimitSeen <= 500, 'paging caps getSince limit (saw ' + maxLimitSeen + ')')
  // Full pull (default budget) still returns everything across pages
  const all = relay2.pull('acct', 0, 32 * 1024 * 1024)
  assert.equal(all.items.length, 1200)
  assert.equal(all.toSeq, 1200)
})

test('gc: snapshot-less deployment with a high ack floor still collects (ack-alone floor)', () => {
  const store = memoryStore()
  // Inject a 100.5k-envelope history + an acked active device via __load (pushing one-by-one
  // is O(n^2) in the dedup scan — far too slow for a unit test).
  const envelopes = []
  for (let i = 1; i <= 100500; i++) {
    envelopes.push({ serverSeq: i, account: 'acct', opId: 'op-' + i, envelopeJson: '"' + i + '"' })
  }
  store.__load({
    seq: 100500,
    envelopes,
    devices: [{ account: 'acct', deviceId: 'dev', deviceSecret: 's', lastAck: 100500, lastSeen: 0, status: 'active' }],
    snapshots: [],
  })
  const removed = store.gc('acct')
  // Ack-alone floor = 100500 - 100000 margin = 500: the first 500 envelopes are collected
  // even though no snapshot exists yet (previously removed = 0 forever).
  assert.equal(removed, 500)
  assert.equal(store.getSince('acct', 0, 100000).length, 100000)
  // A small ack floor keeps everything (margin intact)
  const store2 = memoryStore()
  const relayB = createRelay(store2)
  relayB.push('acct', 'dev', [{ opId: 'x', envelope: '"x"' }])
  relayB.ack('acct', 'dev', 1)
  assert.equal(store2.gc('acct'), 0)
})
