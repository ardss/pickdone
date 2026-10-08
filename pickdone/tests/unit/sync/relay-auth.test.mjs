import test from 'node:test'
import assert from 'node:assert/strict'

// Regression for sec-relay-unauthenticated-routes (P1): every relay data route
// requires `Authorization: Bearer <deviceSecret>`; the secret is minted at
// register and shown exactly once. The verified destroy primitive was an
// unauthenticated ack(ackSeq>=1) + snapshot/put{coversSeq>=ackSeq}, which GC'd
// every envelope. All probes use raw HTTP against startRelayServer on
// 127.0.0.1:0 with the in-memory store (no app data dirs touched).

async function withRelay(t) {
  const { memoryStore, createRelay, startRelayServer } = await import('../../../server/sync-relay.mjs')
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  t.after(() => new Promise(r => server.close(r)))
  return { relay, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

const post = (baseUrl, path, body, authz) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(authz ? { authorization: authz } : {}) },
  body: JSON.stringify(body),
})

async function register(baseUrl, account, device) {
  const res = await post(baseUrl, '/v1/device/register', { account, device })
  assert.equal(res.status, 200)
  const j = await res.json()
  assert.equal(typeof j.device.deviceSecret, 'string')
  assert.ok(j.device.deviceSecret.length >= 64, 'secret is 32 random bytes hex')
  return j.device.deviceSecret
}

test('P1: pull with wrong/missing bearer secret is rejected with 401 and zero envelopes', async t => {
  const { baseUrl } = await withRelay(t)
  const secret = await register(baseUrl, 'acc-a', 'dev-a')
  // seed one envelope with the legit secret
  const push = await post(baseUrl, '/v1/sync/push',
    { account: 'acc-a', device: 'dev-a', items: [{ opId: 'op1', envelope: '{"e":1}' }] },
    `Bearer ${secret}`)
  assert.equal(push.status, 200)
  for (const authz of [undefined, 'Bearer deadbeef', `Bearer ${secret}x`, 'Basic abc']) {
    const res = await post(baseUrl, '/v1/sync/pull', { account: 'acc-a', afterSeq: 0 }, authz)
    assert.equal(res.status, 401, `authz=${authz}`)
    const j = await res.json()
    assert.equal(j.items, undefined, 'no envelope data leaks on 401')
  }
  // the legit secret still works
  const ok = await post(baseUrl, '/v1/sync/pull', { account: 'acc-a', afterSeq: 0 }, `Bearer ${secret}`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).items.length, 1)
})

test('P1: register -> push with secret -> pull with secret returns the envelope', async t => {
  const { baseUrl } = await withRelay(t)
  const secret = await register(baseUrl, 'acc-b', 'dev-b')
  const push = await post(baseUrl, '/v1/sync/push',
    { account: 'acc-b', device: 'dev-b', items: [{ opId: 'op-b1', envelope: '{"rev":"b1"}' }] },
    `Bearer ${secret}`)
  assert.equal(push.status, 200)
  const pull = await post(baseUrl, '/v1/sync/pull', { account: 'acc-b', afterSeq: 0 }, `Bearer ${secret}`)
  assert.equal(pull.status, 200)
  const items = (await pull.json()).items
  assert.equal(items.length, 1)
  assert.equal(items[0].envelope, '{"rev":"b1"}')
})

test('P1: unauthenticated ack + snapshot/put must not GC envelopes (destroy primitive)', async t => {
  const { baseUrl } = await withRelay(t)
  const secret = await register(baseUrl, 'acc-c', 'dev-c')
  await post(baseUrl, '/v1/sync/push',
    { account: 'acc-c', device: 'dev-c', items: [{ opId: 'op-c1', envelope: '{"rev":"c1"}' }] },
    `Bearer ${secret}`)
  // the pre-fix destroy chain: unauthenticated ack(>=1) then snapshot/put{coversSeq>=ackSeq}
  const ack = await post(baseUrl, '/v1/sync/ack', { account: 'acc-c', device: 'dev-c', ackSeq: 5 }, undefined)
  assert.equal(ack.status, 401)
  const snap = await post(baseUrl, '/v1/snapshot/put',
    { account: 'acc-c', snapshot: { generation: 1, coversSeq: 5, data: '{}' } }, undefined)
  assert.equal(snap.status, 401)
  // envelopes survive
  const pull = await post(baseUrl, '/v1/sync/pull', { account: 'acc-c', afterSeq: 0 }, `Bearer ${secret}`)
  const j = await pull.json()
  assert.equal(j.items.length, 1, 'envelope must survive the unauthenticated GC attempt')
  assert.equal(j.items[0].gcRemoved ?? 0, 0)
  // authenticated GC still functions when the owner genuinely acks
  const ackOk = await post(baseUrl, '/v1/sync/ack', { account: 'acc-c', device: 'dev-c', ackSeq: 1 }, `Bearer ${secret}`)
  assert.equal(ackOk.status, 200)
  const after = await ackOk.json()
  assert.equal(after.gcRemoved, 0, 'snapshot floor (never set by the attacker) keeps the envelope')
})

test('P1: unauthenticated snapshot/put alone does not replace the owner snapshot', async t => {
  const { baseUrl } = await withRelay(t)
  const secret = await register(baseUrl, 'acc-d', 'dev-d')
  // D26 coversSeq cap: a snapshot can only cover envelopes the relay has issued — seed 3
  // so the owner snapshot (coversSeq 3) stays within history and keeps testing the AUTH
  // boundary (the cap itself is pinned by d26-snapshot-coversseq-cap.test.mjs).
  await post(baseUrl, '/v1/sync/push', {
    account: 'acc-d', device: 'dev-d',
    items: [1, 2, 3].map(i => ({ opId: `op-${i}`, envelope: JSON.stringify({ i }) })),
  }, `Bearer ${secret}`)
  const owner = { generation: 7, coversSeq: 3, data: '{"owner":true}' }
  const put = await post(baseUrl, '/v1/snapshot/put',
    { account: 'acc-d', snapshot: owner }, `Bearer ${secret}`)
  assert.equal(put.status, 200)
  const evil = await post(baseUrl, '/v1/snapshot/put',
    { account: 'acc-d', snapshot: { generation: 99, coversSeq: 999, data: '{"evil":true}' } }, undefined)
  assert.equal(evil.status, 401)
  const latest = await post(baseUrl, '/v1/snapshot/latest', { account: 'acc-d' }, `Bearer ${secret}`)
  assert.equal(latest.status, 200)
  assert.equal((await latest.json()).snapshot.data, '{"owner":true}', 'owner snapshot intact')
  // snapshot/latest itself requires auth too
  const anonLatest = await post(baseUrl, '/v1/snapshot/latest', { account: 'acc-d' }, undefined)
  assert.equal(anonLatest.status, 401)
})
