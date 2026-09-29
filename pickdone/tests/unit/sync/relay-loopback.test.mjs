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
