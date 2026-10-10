import test from 'node:test'
import assert from 'node:assert/strict'

// Webhook security gate (in-process processWebhook �?HTTP transport covered in
// billing-service-e2e). Every probe: unsigned/forged/stale signatures, money
// mismatches, replay idempotency, out-of-order convergence, zero/negative
// amounts, chargeback/refund revocation.

const { createBillingStore } = await import('../../../server/billing/store.mjs')
const { createSandboxProvider } = await import('../../../server/billing/providers/sandbox.mjs')
const { createOrder } = await import('../../../server/billing/orders.mjs')
const { processWebhook } = await import('../../../server/billing/webhook.mjs')

async function kit (t, now = Date.now) {
  const store = createBillingStore({ now })
  const provider = createSandboxProvider({ webhookSecret: 'whsec-test-0123456789abcdef', now })
  const ledger = store.ledger
  const mkOrder = () => {
    const { accountId } = store.createAccount()
    return { accountId, order: createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order }
  }
  const settle = (order, type = 'charge.succeeded') => {
    const e = provider.emitEvent({ orderId: order.orderId, type, amountMinor: order.amountMinor, currency: order.currency })
    return processWebhook({ store, provider, ledger, rawBody: e.body, headers: e.headers })
  }
  t.after(() => store.close())
  return { store, provider, ledger, mkOrder, settle, deliver: e => processWebhook({ store, provider, ledger, rawBody: e.body, headers: e.headers }) }
}
test('webhook: unsigned / forged / stale / tampered deliveries are hard 401 with zero effects', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order } = mkOrder()
  const good = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })

  const r1 = processWebhook({ store, provider, ledger, rawBody: good.body, headers: { 'content-type': 'application/json' } })
  assert.equal(r1.httpStatus, 401, 'missing signature rejected')

  const r2 = processWebhook({ store, provider, ledger, rawBody: good.body, headers: { 'x-pd-timestamp': good.headers['x-pd-timestamp'], 'x-pd-signature': 'v1=' + '0'.repeat(64) } })
  assert.equal(r2.httpStatus, 401, 'forged signature rejected')

  const stale = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency, ts: Math.floor(Date.now() / 1000) - 3600 })
  const r3 = processWebhook({ store, provider, ledger, rawBody: stale.body, headers: stale.headers })
  assert.equal(r3.httpStatus, 401, 'timestamp outside skew window rejected (replay guard)')

  const tampered = good.body.replace('USD', 'EUR')
  const r4 = processWebhook({ store, provider, ledger, rawBody: tampered, headers: good.headers })
  assert.equal(r4.httpStatus, 401, 'signature covers the raw body �?any mutation rejects')

  assert.equal(store.counts().events, 0, 'rejected deliveries are not recorded')
  assert.equal(ledger.all().length, 0)
  assert.equal(store.getOrder(order.orderId).status, 'pending')
  assert.equal(store.getSubscription(order.accountId), null)
})

test('webhook: zero / negative / non-integer amounts rejected before any effect', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order } = mkOrder()
  for (const amountMinor of [0, -1, 4.99, '499']) {
    const e = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor, currency: 'USD' })
    const r = processWebhook({ store, provider, ledger, rawBody: e.body, headers: e.headers })
    assert.equal(r.httpStatus, 400, `amount=${JSON.stringify(amountMinor)} rejected`)
    assert.equal(r.body.error, 'invalid-amount')
  }
  const badCur = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: 499, currency: 'usd' })
  const rc = processWebhook({ store, provider, ledger, rawBody: badCur.body, headers: badCur.headers })
  assert.equal(rc.httpStatus, 400)
  assert.equal(rc.body.error, 'invalid-currency')
  assert.equal(ledger.all().length, 0, 'no money entered the books')
  assert.equal(store.getOrder(order.orderId).status, 'pending')
})

test('webhook: amount/currency mismatch vs the server-side order is rejected and recorded', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order } = mkOrder() // cloud monthly = 499 USD
  const wrongAmt = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: 1, currency: 'USD' })
  const r1 = processWebhook({ store, provider, ledger, rawBody: wrongAmt.body, headers: wrongAmt.headers })
  assert.equal(r1.httpStatus, 400)
  assert.equal(r1.body.error, 'amount-currency-mismatch')
  const wrongCur = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: 499, currency: 'EUR' })
  const r2 = processWebhook({ store, provider, ledger, rawBody: wrongCur.body, headers: wrongCur.headers })
  assert.equal(r2.httpStatus, 400)
  assert.equal(store.counts().events, 2, 'mismatches recorded for audit')
  assert.equal(ledger.all().length, 0)
  assert.equal(store.getOrder(order.orderId).status, 'pending', 'no entitlement from wrong money')
})

test('webhook: unknown order / unknown event type / junk body rejected', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order } = mkOrder()
  const ghost = provider.emitEvent({ orderId: 'ord_does_not_exist', type: 'charge.succeeded', amountMinor: 499, currency: 'USD' })
  const r1 = processWebhook({ store, provider, ledger, rawBody: ghost.body, headers: ghost.headers })
  assert.equal(r1.httpStatus, 400)
  assert.equal(r1.body.error, 'unknown-order')

  const weird = provider.emitEvent({ orderId: order.orderId, type: 'wallet.cashback', amountMinor: 499, currency: 'USD' })
  const r2 = processWebhook({ store, provider, ledger, rawBody: weird.body, headers: weird.headers })
  assert.equal(r2.httpStatus, 400)
  assert.equal(r2.body.error, 'malformed-event')

  const { signPayload } = await import('../../../server/billing/providers/provider.mjs')
  const ts = String(Math.floor(Date.now() / 1000))
  const junkBody = 'not json {{{'
  const r3 = processWebhook({
    store, provider, ledger, rawBody: junkBody,
    headers: { 'x-pd-timestamp': ts, 'x-pd-signature': signPayload('whsec-test-0123456789abcdef', ts, junkBody) },
  })
  assert.equal(r3.httpStatus, 400)
  assert.equal(r3.body.error, 'malformed-event', 'validly-signed junk body passes auth, fails shape')
})

test('webhook: exact replay (same event id) is idempotent �?one charge, one grant', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order, accountId } = mkOrder()
  const e = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const r1 = processWebhook({ store, provider, ledger, rawBody: e.body, headers: e.headers })
  assert.equal(r1.httpStatus, 200)
  assert.equal(r1.body.applied, true)
  for (let i = 0; i < 3; i++) {
    const rd = processWebhook({ store, provider, ledger, rawBody: e.body, headers: e.headers })
    assert.equal(rd.httpStatus, 200)
    assert.equal(rd.body.duplicate, true, `replay ${i} no-ops`)
  }
  const charges = ledger.all().filter(x => x.type === 'charge')
  assert.equal(charges.length, 1, 'exactly one ledger charge despite 4 deliveries')
  assert.equal(store.getSubscription(accountId).status, 'active')
  assert.equal(store.counts().events, 1, 'one recorded event')
})

test('webhook: out-of-order �?refund arrives BEFORE charge, converges to refunded+frozen', async t => {
  const { store, ledger, mkOrder, provider } = await kit(t)
  const { order, accountId } = mkOrder()
  const refund = provider.emitEvent({ orderId: order.orderId, type: 'refund.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const r1 = processWebhook({ store, provider, ledger, rawBody: refund.body, headers: refund.headers })
  assert.equal(r1.body.applied, false)
  assert.equal(r1.body.deferred, true, 'recorded, not dropped')
  assert.equal(store.getOrder(order.orderId).status, 'pending', 'refund cannot revoke a nonexistent entitlement')

  const charge = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const r2 = processWebhook({ store, provider, ledger, rawBody: charge.body, headers: charge.headers })
  assert.equal(r2.body.applied, true)
  assert.equal(r2.body.orderStatus, 'refunded', 'deferred refund replays after payment lands')
  assert.equal(store.getSubscription(accountId).status, 'frozen', 'converged to provider final state')
  assert.deepEqual(ledger.all().map(x => x.type).sort(), ['charge', 'refund'], 'both money events booked exactly once')
})

test('webhook: chargeback and refund revoke and freeze paid subscriptions', async t => {
  const { store, ledger, mkOrder, settle } = await kit(t)
  const { order: o1, accountId: a1 } = mkOrder()
  assert.equal(settle(o1).body.applied, true)
  assert.equal(store.getSubscription(a1).status, 'active')
  const rcb = settle(o1, 'chargeback.created')
  assert.equal(rcb.body.orderStatus, 'chargeback')
  assert.equal(store.getSubscription(a1).status, 'frozen')
  assert.equal(store.getSubscription(a1).frozenReason, 'chargeback')

  const { order: o2, accountId: a2 } = mkOrder()
  settle(o2)
  const rrf = settle(o2, 'refund.succeeded')
  assert.equal(rrf.body.orderStatus, 'refunded')
  assert.equal(store.getSubscription(a2).status, 'frozen')
  assert.equal(store.getSubscription(a2).frozenReason, 'refund')
  assert.equal(ledger.all().filter(x => x.type === 'chargeback').length, 1)
  assert.equal(ledger.all().filter(x => x.type === 'refund').length, 1)
})
