/**
 * 2026-10-10 revocation regression (P0): retiring a device via
 * /v1/device/state {status:'retired'} is the ONLY revocation primitive the
 * relay offers — there is no admin path to rotate a lost device's secret
 * (the rotation proof IS that secret). authorize() used to ignore device
 * status, so a retired (e.g. stolen) device's bearer secret kept full
 * pull/push/ack/snapshot access forever.
 *
 * Fixed semantics asserted here:
 *  - a retired device's secret is a dead credential on EVERY data route;
 *  - the account-wide candidate path (snapshot routes accept any of the
 *    account's devices) also refuses retired rows;
 *  - active devices on the same account are unaffected;
 *  - rotation with proof-of-possession keeps the retired status, so a thief
 *    holding the secret cannot self-revive (new secret still gets 401);
 *  - re-register without proof is still 409 (rotation guard unchanged).
 *
 * Run: node --test tests/unit/sync/relay-retired-revocation.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

async function withRelay(t) {
  const { memoryStore, createRelay, startRelayServer } = await import('../../../server/sync-relay.mjs')
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  t.after(() => new Promise(r => server.close(r)))
  return { relay, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

const post = (baseUrl, path, body, authz) => fetch(baseUrl + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', connection: 'close', ...(authz ? { authorization: authz } : {}) },
  body: JSON.stringify(body),
})

async function register(baseUrl, account, device) {
  const res = await post(baseUrl, '/v1/device/register', { account, device })
  assert.equal(res.status, 200)
  return (await res.json()).device.deviceSecret
}

test('P0: retired device bearer is a dead credential on every data route', async t => {
  const { baseUrl } = await withRelay(t)
  const secA = await register(baseUrl, 'acc-r', 'dev-a')
  const secB = await register(baseUrl, 'acc-r', 'dev-b')
  // seed one envelope from the live device
  const push = await post(baseUrl, '/v1/sync/push',
    { account: 'acc-r', device: 'dev-a', items: [{ opId: 'op1', envelope: '{"v":1}' }] },
    `Bearer ${secA}`)
  assert.equal(push.status, 200)
  // retire dev-b with its own secret (the only device its secret can address)
  const retire = await post(baseUrl, '/v1/device/state', { account: 'acc-r', device: 'dev-b', status: 'retired' }, `Bearer ${secB}`)
  assert.equal(retire.status, 200)
  // every data route must now refuse dev-b's secret with 401
  const routes = [
    ['/v1/sync/pull', { account: 'acc-r', afterSeq: 0 }],
    ['/v1/sync/push', { account: 'acc-r', device: 'dev-b', items: [{ opId: 'op-b2', envelope: '{"v":2}' }] }],
    ['/v1/sync/ack', { account: 'acc-r', device: 'dev-b', ackSeq: 1 }],
    ['/v1/device/state', { account: 'acc-r', device: 'dev-b', status: 'retired' }],
    ['/v1/snapshot/put', { account: 'acc-r', snapshot: { generation: 1, coversSeq: 1, data: '{}' } }],
    ['/v1/snapshot/latest', { account: 'acc-r' }],
  ]
  for (const [path, body] of routes) {
    const res = await post(baseUrl, path, body, `Bearer ${secB}`)
    assert.equal(res.status, 401, `${path} must reject a retired device's bearer`)
    const j = await res.json()
    assert.equal(j.items, undefined, `${path} must leak no envelope data on 401`)
  }
})

test('P0: the account-wide snapshot path refuses a retired secret; active devices keep working', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const secA = await register(baseUrl, 'acc-wide', 'dev-a')
  const secB = await register(baseUrl, 'acc-wide', 'dev-b')
  await post(baseUrl, '/v1/sync/push',
    { account: 'acc-wide', device: 'dev-a', items: [{ opId: 'op-w1', envelope: '{"v":"w1"}' }] },
    `Bearer ${secA}`)
  // before retirement, dev-b's secret legitimately authorizes the snapshot route (any device)
  const pre = await post(baseUrl, '/v1/snapshot/latest', { account: 'acc-wide' }, `Bearer ${secB}`)
  assert.equal(pre.status, 200)
  // retire the ONLY device (dev-b has no device-scoped row access anymore, snapshot path too)
  await post(baseUrl, '/v1/device/state', { account: 'acc-wide', device: 'dev-b', status: 'retired' }, `Bearer ${secB}`)
  const post401 = await post(baseUrl, '/v1/snapshot/latest', { account: 'acc-wide' }, `Bearer ${secB}`)
  assert.equal(post401.status, 401, 'retired secret must not authorize the account-wide snapshot path')
  // dev-a (active) is unaffected end to end
  const pull = await post(baseUrl, '/v1/sync/pull', { account: 'acc-wide', afterSeq: 0 }, `Bearer ${secA}`)
  assert.equal(pull.status, 200)
  assert.equal((await pull.json()).items.length, 1)
  const push = await post(baseUrl, '/v1/sync/push',
    { account: 'acc-wide', device: 'dev-a', items: [{ opId: 'op-w2', envelope: '{"v":"w2"}' }] },
    `Bearer ${secA}`)
  assert.equal(push.status, 200)
  // gc semantics unchanged: retired rows stay out of the active ack floor
  assert.equal(relay.store.listDevices('acc-wide').filter(d => d.status === 'retired').length, 1)
})

test('P0: thief self-revive blocked — proof rotation keeps the retired status, new secret still 401', async t => {
  const { baseUrl } = await withRelay(t)
  const sec = await register(baseUrl, 'acc-thief', 'dev-t')
  await post(baseUrl, '/v1/device/state', { account: 'acc-thief', device: 'dev-t', status: 'retired' }, `Bearer ${sec}`)
  // rotation WITH proof succeeds (200) — but must not resurrect the device
  const rot = await post(baseUrl, '/v1/device/register', { account: 'acc-thief', device: 'dev-t', deviceSecret: sec })
  assert.equal(rot.status, 200)
  const newSecret = (await rot.json()).device.deviceSecret
  assert.notEqual(newSecret, sec, 'rotation mints a fresh secret')
  const pull = await post(baseUrl, '/v1/sync/pull', { account: 'acc-thief', afterSeq: 0 }, `Bearer ${newSecret}`)
  assert.equal(pull.status, 401, 'the rotated secret must stay revoked (status remains retired)')
  // and the no-proof takeover guard is unchanged
  const noProof = await post(baseUrl, '/v1/device/register', { account: 'acc-thief', device: 'dev-t' })
  assert.equal(noProof.status, 409, 're-register without proof is still 409')
})

test('P0: retiring an unknown device row still cannot authenticate anything (no row, no access)', async t => {
  const { baseUrl } = await withRelay(t)
  const secA = await register(baseUrl, 'acc-u', 'dev-a')
  const res = await post(baseUrl, '/v1/sync/pull', { account: 'acc-u', afterSeq: 0 }, `Bearer ${secA}x`)
  assert.equal(res.status, 401, 'wrong-length secret still 401 (baseline unchanged)')
})
