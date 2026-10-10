import test from 'node:test'
import assert from 'node:assert/strict'

// REAL HTTP end-to-end over the sandbox provider: the full vertical slice â€?// account â†?order â†?provider-signed webhook â†?entitlements â†?usage/quota â†?// refund freeze â†?reconcile â€?plus auth guards and CONCURRENT duplicate
// webhook idempotency. Loopback only, ephemeral port, memory store.

const { createBillingService, startBillingServer } = await import('../../../server/billing/service.mjs')
const { createSandboxProvider } = await import('../../../server/billing/providers/sandbox.mjs')

const GIB = 1024 * 1024 * 1024

async function withService (t) {
  const provider = createSandboxProvider({ webhookSecret: 'whsec-e2e-0123456789abcdef' })
  const service = createBillingService({
    provider, adminToken: 'admin-tok-e2e', internalToken: 'internal-tok-e2e',
  })
  const server = await startBillingServer(service, { port: 0, host: '127.0.0.1' })
  t.after(() => new Promise(r => server.close(r)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const get = (path, headers = {}) => fetch(base + path, { headers })
  const deliver = event => post('/v1/webhooks/sandbox', event.body, event.headers)
  const newUser = async () => {
    const r = await post('/v1/accounts', {})
    assert.equal(r.status, 201)
    const j = await r.json()
    return { accountId: j.accountId, apiKey: j.apiKey, auth: { authorization: `Bearer ${j.apiKey}` } }
  }
  const settleOrder = async (auth, cycle = 'monthly', type = 'charge.succeeded') => {
    const or = await post('/v1/orders', { planId: 'cloud', cycle }, auth)
    assert.equal(or.status, 201)
    const order = await or.json()
    const evt = provider.emitEvent({ orderId: order.orderId, type, amountMinor: order.amountMinor, currency: order.currency })
    const wr = await deliver(evt)
    return { order, webhook: wr }
  }
  return { service, provider, post, get, deliver, newUser, settleOrder }
}

test('e2e: full happy path â€?order â†?signed webhook â†?cloud entitlements â†?usage â†?refund â†?frozen', async t => {
  const { post, get, deliver, provider, newUser } = await withService(t)
  const { accountId, auth } = await newUser()

  const e0 = await (await get('/v1/entitlements', auth)).json()
  assert.equal(e0.tier, 'local')
  assert.equal(e0.syncAllowed.allowed, false)

  const or = await post('/v1/orders', { planId: 'cloud', cycle: 'monthly' }, auth)
  assert.equal(or.status, 201)
  const order = await or.json()
  assert.equal(order.status, 'pending')
  assert.equal(order.amountMinor, 499)
  assert.equal(order.currency, 'USD')
  assert.match(order.payment.paymentUrl, /^sandbox:\/\//, 'no real checkout URL exists')

  const evt = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const wr = await deliver(evt)
  assert.equal(wr.status, 200)
  assert.equal((await wr.json()).applied, true)

  const e1 = await (await get('/v1/entitlements', auth)).json()
  assert.equal(e1.tier, 'cloud')
  assert.equal(e1.storageQuotaBytes, GIB)
  assert.equal(e1.syncAllowed.allowed, true)
  assert.equal(e1.subscription.status, 'active')

  // trusted storage reporter sets usage; over-quota flips the gate
  const u1 = await (await post('/v1/usage', { accountId, bytesUsed: 100 }, { authorization: 'Bearer internal-tok-e2e' })).json()
  assert.equal(u1.overQuota, false)
  const u2 = await post('/v1/usage', { accountId, bytesUsed: GIB + 7 }, { authorization: 'Bearer internal-tok-e2e' })
  assert.equal((await u2.json()).overQuota, true)
  const e2 = await (await get('/v1/entitlements', auth)).json()
  assert.equal(e2.overQuota, true)
  assert.equal(e2.syncAllowed.allowed, false)
  assert.equal(e2.syncAllowed.reason, 'storage-quota-exceeded')

  // refund revokes: freeze immediate, still inside the paid window
  const rfe = provider.emitEvent({ orderId: order.orderId, type: 'refund.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const rr = await deliver(rfe)
  assert.equal((await rr.json()).orderStatus, 'refunded')
  const e3 = await (await get('/v1/entitlements', auth)).json()
  assert.equal(e3.frozen, true)
  assert.equal(e3.frozenReason, 'refund')
  assert.equal(e3.syncAllowed.allowed, false)
  assert.equal(e3.syncAllowed.reason, 'subscription-refund')
})

test('e2e: annual cycle sells too; renewal order on the same account stacks', async t => {
  const { get, newUser, settleOrder } = await withService(t)
  const { auth } = await newUser()
  const { webhook: w1 } = await settleOrder(auth, 'annual')
  assert.equal(w1.status, 200)
  const end1 = (await (await get('/v1/entitlements', auth)).json()).subscription.currentPeriodEnd
  const { webhook: w2 } = await settleOrder(auth, 'annual')
  assert.equal(w2.status, 200)
  const end2 = (await (await get('/v1/entitlements', auth)).json()).subscription.currentPeriodEnd
  assert.equal(new Date(end2) - new Date(end1), 365 * 24 * 60 * 60 * 1000, 'renewal extends a full year from the old end')
})

test('e2e: concurrent duplicate webhook deliveries â€?exactly one effect', async t => {
  const { get, provider, newUser, deliver, post } = await withService(t)
  const { auth } = await newUser()
  const or = await post('/v1/orders', { planId: 'cloud', cycle: 'annual' }, auth)
  const order = await or.json()
  const evt = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })

  const results = await Promise.all(Array.from({ length: 10 }, () => deliver(evt)))
  const bodies = await Promise.all(results.map(x => x.json()))
  assert.equal(results.every(x => x.status === 200), true)
  assert.equal(bodies.filter(b => b.applied === true && !b.duplicate).length, 1, 'exactly one delivery applied')
  assert.equal(bodies.filter(b => b.duplicate).length, 9, 'the rest are idempotent no-ops')
  const e = await (await get('/v1/entitlements', auth)).json()
  assert.equal(e.subscription.status, 'active')
})

test('e2e: auth guards â€?no key / wrong key / wrong tokens / wrong provider / foreign order', async t => {
  const { post, get, newUser } = await withService(t)
  const { auth, accountId } = await newUser()

  assert.equal((await get('/v1/entitlements')).status, 401, 'missing key')
  assert.equal((await get('/v1/entitlements', { authorization: 'Bearer nope' })).status, 401, 'wrong key')
  assert.equal((await post('/v1/orders', { planId: 'cloud', cycle: 'monthly' })).status, 401, 'order needs the key')
  assert.equal((await post('/v1/usage', { accountId, bytesUsed: 1 })).status, 401, 'usage needs INTERNAL token')
  assert.equal((await post('/v1/usage', { accountId, bytesUsed: 1 }, { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await get('/v1/reconcile/report', { authorization: 'Bearer internal-tok-e2e' })).status, 401, 'internal token cannot read admin reports')
  assert.equal((await get('/v1/reconcile/report', { authorization: 'Bearer admin-tok-e2e' })).status, 200, 'admin token works')
  assert.equal((await post('/v1/webhooks/stripe', '{}')).status, 404, 'unconfigured provider has no route')
  const foreign = await newUser()
  const ownOrder = await (await post('/v1/orders', { planId: 'cloud', cycle: 'monthly' }, auth)).json()
  assert.equal((await get(`/v1/orders/${ownOrder.orderId}`, { authorization: `Bearer ${foreign.apiKey}` })).status, 404,
    'an account cannot read another account order')
  assert.equal((await get(`/v1/orders/${ownOrder.orderId}`, auth)).status, 200)
})

test('e2e: unsigned webhook over HTTP is 401; order validation errors surface', async t => {
  const { post, newUser } = await withService(t)
  await newUser()
  const junk = await post('/v1/webhooks/sandbox', { id: 'evt_x', type: 'charge.succeeded' })
  assert.equal(junk.status, 401, 'no signature headers â†?401')
  const badPlan = await post('/v1/orders', { planId: 'ultra', cycle: 'monthly' })
  assert.equal(badPlan.status, 401, 'order route still needs the key first')
})

test('e2e: reconcile â€?internal consistency ok; provider statement diff flags ghost charge', async t => {
  const { post, get, newUser, settleOrder } = await withService(t)
  const { auth } = await newUser()
  const { order } = await settleOrder(auth, 'monthly')

  const admin = { authorization: 'Bearer admin-tok-e2e' }
  const rep1 = await (await get('/v1/reconcile/report', admin)).json()
  assert.equal(rep1.chainOk, true)
  assert.deepEqual(rep1.discrepancies, [])
  assert.equal(rep1.ledgerTotals.USD.net, 499)

  const rep2 = await (await post('/v1/reconcile', {
    statement: [
      { type: 'charge', orderId: order.orderId, providerRef: order.payment.providerRef, amountMinor: 499, currency: 'USD' },
      { type: 'charge', orderId: 'ord_ghost', providerRef: 'sbx_other', amountMinor: 9999, currency: 'USD' },
    ],
  }, admin)).json()
  assert.equal(rep2.chainOk, true)
  assert.equal(rep2.discrepancies.length, 1)
  assert.equal(rep2.discrepancies[0].kind, 'missing-in-ledger')
  assert.equal(rep2.discrepancies[0].orderId, 'ord_ghost')
})

test('e2e: oversize webhook body is rejected (413) before signature work', async t => {
  const { post } = await withService(t)
  const big = 'x'.repeat((1 << 20) + 64)
  const r = await post('/v1/webhooks/sandbox', big)
  assert.equal(r.status, 413)
})
