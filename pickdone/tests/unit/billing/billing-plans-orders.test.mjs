import test from 'node:test'
import assert from 'node:assert/strict'

// Billing catalog + server-side orders + the order state machine (pure core,
// no HTTP). Money is integer minor units; prices come ONLY from the catalog.

const GIB = 1024 * 1024 * 1024

async function kit (t, now = Date.now) {
  const { createBillingStore } = await import('../../../server/billing/store.mjs')
  const { createSandboxProvider } = await import('../../../server/billing/providers/sandbox.mjs')
  const store = createBillingStore({ now })
  const provider = createSandboxProvider({ webhookSecret: 'test-secret-0123456789abcdef', now })
  t.after(() => store.close())
  return { store, provider }
}

test('plans: catalog shape �?local free, cloud sellable, selfhost not sellable', async t => {
  const { PLANS, priceFor, isSellable } = await import('../../../server/billing/plans.mjs')
  assert.equal(PLANS.local.sellable, false, 'local features are free forever')
  assert.equal(PLANS.selfhost.sellable, false, 'self-host has free egress, nothing to bill')
  assert.equal(PLANS.cloud.sellable, true)
  assert.equal(PLANS.cloud.hostedSync, true)
  assert.equal(PLANS.cloud.maxDevices, 5)
  assert.equal(PLANS.cloud.storageQuotaBytes, Number(GIB))
  assert.equal(priceFor('cloud', 'monthly').amountMinor, 499)
  assert.equal(priceFor('cloud', 'annual').amountMinor, 4999)
  assert.equal(priceFor('cloud', 'monthly').currency, 'USD')
  assert.equal(priceFor('cloud', 'weekly'), null, 'unknown cycle has no price')
  assert.equal(isSellable('local', 'monthly'), false)
})

test('orders: creation derives money from the catalog and rejects garbage', async t => {
  const { createOrder } = await import('../../../server/billing/orders.mjs')
  const { store, provider } = await kit(t)
  const { accountId } = store.createAccount()

  assert.equal(createOrder({ store, provider, accountId, planId: 'nope', cycle: 'monthly' }).error, 'unknown-plan')
  assert.equal(createOrder({ store, provider, accountId, planId: 'local', cycle: 'monthly' }).error, 'plan-not-sellable',
    'local tier is free �?billing it would be a stored-value/wallet smell')
  assert.equal(createOrder({ store, provider, accountId, planId: 'selfhost', cycle: 'monthly' }).error, 'plan-not-sellable')
  assert.equal(createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'weekly' }).error, 'unknown-cycle')

  const r = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'annual' })
  assert.equal(r.error, undefined)
  assert.equal(r.order.status, 'pending')
  assert.equal(r.order.amountMinor, 4999, 'money from catalog, not caller')
  assert.equal(r.order.currency, 'USD')
  assert.equal(r.order.accountId, accountId)
})

test('orders: state machine �?only listed transitions pass', async t => {
  const { createOrder, applyEventToOrder } = await import('../../../server/billing/orders.mjs')
  const { store, provider } = await kit(t)
  const { accountId } = store.createAccount()
  const ev = (type, extra = {}) => ({ id: `evt_${Math.random()}`, type, orderId: 'x', amountMinor: 499, currency: 'USD', providerRef: 'sbx_1', ...extra })

  // pending �?paid
  const a = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  assert.deepEqual(applyEventToOrder({ store, order: a, event: ev('refund.succeeded') }), { applied: false, deferred: true },
    'refund on unpaid order defers (recorded, not dropped)')
  assert.equal(applyEventToOrder({ store, order: a, event: ev('charge.failed') }).applied, true)
  assert.equal(store.getOrder(a.orderId).status, 'failed')
  // failed is terminal
  assert.equal(applyEventToOrder({ store, order: store.getOrder(a.orderId), event: ev('charge.succeeded') }).applied, false)

  // paid �?refunded / chargeback
  const b = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  applyEventToOrder({ store, order: b, event: ev('charge.succeeded') })
  assert.equal(applyEventToOrder({ store, order: store.getOrder(b.orderId), event: ev('charge.succeeded') }).applied, false,
    'second charge on a paid order is ignored (no double grant)')
  assert.equal(applyEventToOrder({ store, order: store.getOrder(b.orderId), event: ev('chargeback.created') }).applied, true)
  assert.equal(store.getOrder(b.orderId).status, 'chargeback')
  assert.equal(applyEventToOrder({ store, order: store.getOrder(b.orderId), event: ev('refund.succeeded') }).applied, false,
    'terminal states accept nothing')
})

test('orders: stale pending sweep �?failed(expired), paid/pending-fresh untouched', async t => {
  const { createOrder, sweepExpiredOrders } = await import('../../../server/billing/orders.mjs')
  let t0 = 1_700_000_000_000
  const { store, provider } = await kit(t, () => t0)
  const { accountId } = store.createAccount()
  const old = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  t0 += 25 * 60 * 60 * 1000 // 25h later
  const fresh = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  assert.equal(sweepExpiredOrders(store, { maxPendingAgeMs: 24 * 60 * 60 * 1000 }), 1)
  assert.equal(store.getOrder(old.orderId).status, 'failed')
  assert.equal(store.getOrder(old.orderId).closeReason, 'expired')
  assert.equal(store.getOrder(fresh.orderId).status, 'pending')
  assert.equal(sweepExpiredOrders(store, { maxPendingAgeMs: 24 * 60 * 60 * 1000 }), 0, 'idempotent')
})
