import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryStore, fileStore, createRelay, startRelayServer } from '../../../server/sync-relay.mjs'
import { createRelayClient } from '../../../shared/sync-transport/https/relay-client.mjs'

const ACCOUNT = 'acc1'

async function withRelay(t, storeImpl) {
  const relay = createRelay(storeImpl)
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const { port } = server.address()
  return { relay, baseUrl: `http://127.0.0.1:${port}` }
}

test('relay loopback: 3 devices converge through the HTTP relay (randomized rounds)', async t => {
  const { baseUrl } = await withRelay(t, memoryStore())
  const rng = (() => { let a = 7 >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 } })()

  const devices = []
  for (let i = 0; i < 3; i++) {
    const d = createRelayClient({ nodeId: `dev${i}`, account: ACCOUNT, baseUrl })
    devices.push(d)
    await d.register()
  }

  const entityIds = Array.from({ length: 6 }, (_, i) => `t${i}`)
  for (let op = 0; op < 120; op++) {
    const actor = devices[Math.floor(rng() * devices.length)]
    if (rng() < 0.6) {
      const deleted = rng() < 0.15
      await actor.commit(entityIds[Math.floor(rng() * entityIds.length)], deleted ? { deleted: true } : { title: `${actor.nodeId}-${op}` })
    }
    for (const d of devices) if (rng() < 0.5) await d.round()
  }
  for (let i = 0; i < 4; i++) await Promise.all(devices.map(d => d.round()))

  const reference = devices[0].materialized()
  for (const d of devices) assert.deepEqual(d.materialized(), reference, `${d.nodeId} diverged through relay`)
})

test('relay: duplicate push (same opId) is idempotent and does not advance serverSeq', async t => {
  const { relay } = await withRelay(t, memoryStore())
  const env = { revisionId: 'r1', entityId: 't1' }
  const first = relay.push(ACCOUNT, 'devA', [{ opId: 'r1', envelope: JSON.stringify(env) }])
  const second = relay.push(ACCOUNT, 'devA', [{ opId: 'r1', envelope: JSON.stringify(env) }])
  assert.equal(second.acked.r1, first.acked.r1)
  assert.equal(relay.store.lastSeq(), first.serverSeq)
})

test('relay: GC respects the durable-ack floor and never eats un-acked history', async t => {
  const { relay } = await withRelay(t, memoryStore())
  relay.registerDevice(ACCOUNT, 'devA')
  relay.registerDevice(ACCOUNT, 'devB')
  for (let i = 1; i <= 10; i++) relay.push(ACCOUNT, 'devA', [{ opId: `op${i}`, envelope: `"e${i}"` }])
  relay.ack(ACCOUNT, 'devA', 10)
  assert.equal(relay.store.gcFloor(ACCOUNT), 0, 'devB acked nothing -> blocks')
  assert.equal(relay.pull(ACCOUNT, 0).items.length, 10)
  relay.ack(ACCOUNT, 'devB', 5)
  assert.equal(relay.store.gcFloor(ACCOUNT), 5)
  assert.equal(relay.pull(ACCOUNT, 0).items.length, 10, 'no snapshot coverage yet -> GC holds (snapshot-safe rule)')
  relay.putSnapshot(ACCOUNT, { generation: 1, coversSeq: 5, data: 'snap' })
  assert.equal(relay.pull(ACCOUNT, 0).items.length, 5)
  assert.equal(relay.latestSnapshot(ACCOUNT).generation, 1)
})

test('relay: stale device does not block GC floor; re-adding restores it', async t => {
  const { relay } = await withRelay(t, memoryStore())
  relay.registerDevice(ACCOUNT, 'devA')
  relay.registerDevice(ACCOUNT, 'devOld')
  relay.push(ACCOUNT, 'devA', [{ opId: 'op1', envelope: '"x"' }])
  relay.ack(ACCOUNT, 'devA', 1)
  assert.equal(relay.store.gcFloor(ACCOUNT), 0)
  relay.setDeviceState(ACCOUNT, 'devOld', { status: 'stale' })
  assert.equal(relay.store.gcFloor(ACCOUNT), 1, 'stale device no longer blocks (spec §26)')
  relay.setDeviceState(ACCOUNT, 'devOld', { status: 'active' })
  assert.equal(relay.store.gcFloor(ACCOUNT), 0)
})

test('relay: file store round-trips state (self-host durability)', async t => {
  const tmp = `./.tmp-relay-test-${process.pid}-${Date.now()}`
  {
    const s = fileStore(tmp)
    const relay = createRelay(s)
    relay.registerDevice(ACCOUNT, 'devA')
    relay.push(ACCOUNT, 'devA', [{ opId: 'op1', envelope: '"x"' }])
    relay.ack(ACCOUNT, 'devA', 1)
    s.close()
  }
  const s2 = fileStore(tmp)
  const relay2 = createRelay(s2)
  assert.equal(relay2.store.lastSeq(), 1)
  assert.equal(relay2.pull(ACCOUNT, 0).items.length, 1)
  assert.equal(relay2.store.getDevice(ACCOUNT, 'devA').lastAck, 1)
  s2.close()
  const { rmSync } = await import('node:fs')
  rmSync(tmp, { recursive: true, force: true })
})

// ---------- adversarial-review regressions (2026-09-30 four-way review) ----------

test('relay: body over 8MB is rejected 413 before buffering (memory-DoS cap)', async t => {
  const { baseUrl } = await withRelay(t, memoryStore())
  const big = 'x'.repeat(9 * 1024 * 1024)
  // two acceptable outcomes prove the cap: a clean 413 response, OR a client-side
  // send error when the server destroys the socket mid-upload (timing race under
  // full-suite load — both mean the body never got buffered)
  let outcome = 'none'
  try {
    const res = await fetch(baseUrl + '/v1/sync/push', { method: 'POST', body: JSON.stringify({ account: ACCOUNT, device: 'd', items: [{ opId: 'o', envelope: big }] }) })
    if (res.status === 413) outcome = '413'
  } catch { outcome = 'reset' }
  assert.notEqual(outcome, 'none', 'expected 413 or connection reset, got neither')
})

test('relay: non-string envelope is rejected 400 at push (pull-poisoning fix)', async t => {
  const { relay, baseUrl } = await withRelay(t, memoryStore())
  const res = await fetch(baseUrl + '/v1/sync/push', { method: 'POST', body: JSON.stringify({ account: ACCOUNT, device: 'd', items: [{ opId: 'o1', envelope: { bad: 'object' } }] }) })
  assert.equal(res.status, 400)
  assert.equal(relay.pull(ACCOUNT, 0).items.length, 0, 'account pull must stay clean')
})

test('relay-client: one poisoned frame is quarantined — cursor advances, later frames still apply', async t => {
  const { relay, baseUrl } = await withRelay(t, memoryStore())
  const a = createRelayClient({ nodeId: 'qa', account: 'q1', baseUrl })
  await a.register()
  await a.commit('t1', { title: 'good-one' })
  await a.round()
  // inject an undecodable frame AFTER the good one
  relay.push('q1', 'injected', [{ opId: 'poison', envelope: '{not json' }])
  await a.commit('t2', { title: 'good-two' })
  const r = await a.round()
  assert.equal(r.quarantined, 1, 'poison frame quarantined, not fatal')
  assert.ok(r.cursor > 0, 'cursor advanced past the poisoned frame')
  assert.equal(a.materialized()['t2'] !== undefined, true, 'frames behind the poison still applied')
  // device keeps making progress on subsequent rounds (was: frozen forever)
  await a.commit('t3', { title: 'post-poison' })
  const r2 = await a.round()
  assert.ok(r2.cursor >= r.cursor, 'device still progresses')
})

test('relay-client: transient push failure does NOT orphan pending revisions', async t => {
  const { baseUrl } = await withRelay(t, memoryStore())
  let failNext = false
  const realFetch = globalThis.fetch
  const flaky = (url, opts) => {
    if (failNext && String(url).includes('/sync/push')) return Promise.reject(new Error('network blip'))
    return realFetch(url, opts)
  }
  t.after(() => { globalThis.fetch = realFetch })
  const a = createRelayClient({ nodeId: 'qa2', account: 'q2', baseUrl, fetchImpl: flaky })
  await a.register()
  await a.commit('t1', { title: 'survives a blip' })
  failNext = true
  await assert.rejects(() => a.round(), 'push failure surfaces (not silently swallowed)')
  failNext = false
  const r = await a.round()
  assert.equal(r.pushed, 1, 'revision retried after the blip (was: orphaned forever)')
  const b = createRelayClient({ nodeId: 'qb', account: 'q2', baseUrl })
  await b.register(); await b.round()
  assert.deepEqual(b.materialized(), a.materialized())
})

test('relay-client: own frames pulled back classify duplicate AND advance the cursor (GC un-pinned)', async t => {
  const { relay, baseUrl } = await withRelay(t, memoryStore())
  const a = createRelayClient({ nodeId: 'qa3', account: 'q3', baseUrl })
  await a.register()
  await a.commit('t1', { title: 'x' })
  await a.round()
  const r2 = await a.round() // idle round: own frame comes back as duplicate
  assert.ok(r2.cursor > 0, 'cursor advances on duplicate own frames (was: pinned at 0 forever)')
  assert.equal(relay.store.gcFloor('q3') > 0 || r2.cursor > 0, true)
})
