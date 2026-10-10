import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Entitlement lifecycle (grant �?quota �?freeze �?grace �?expiry �?renewal),
// the append-only hash-chained ledger (tamper evidence), and file-backed
// persistence incl. tampered-ledger boot quarantine. All time is INJECTED.

const { createBillingStore } = await import('../../../server/billing/store.mjs')
const { createSandboxProvider } = await import('../../../server/billing/providers/sandbox.mjs')
const { createOrder } = await import('../../../server/billing/orders.mjs')
const { processWebhook } = await import('../../../server/billing/webhook.mjs')
const { computeEntitlements, checkSyncAllowed, GRACE_MS } = await import('../../../server/billing/entitlements.mjs')
const { verifyChain } = await import('../../../server/billing/ledger.mjs')

const GIB = 1024 * 1024 * 1024
const T0 = 1_700_000_000_000

function kit (t, { dataDir = null } = {}) {
  let now = T0
  const store = createBillingStore({ dataDir, now: () => now })
  const provider = createSandboxProvider({ webhookSecret: 'whsec-entl-0123456789abcd', now: () => now })
  const settle = (order, type = 'charge.succeeded') => {
    const e = provider.emitEvent({ orderId: order.orderId, type, amountMinor: order.amountMinor, currency: order.currency })
    // the injected clock rides along — the webhook freshness check and the
    // provider's own timestamp must share ONE time source in tests
    return processWebhook({ store, provider, ledger: store.ledger, rawBody: e.body, headers: e.headers, now: () => now })
  }
  const buy = (cycle = 'monthly') => {
    const { accountId } = store.createAccount()
    const order = createOrder({ store, provider, accountId, planId: 'cloud', cycle }).order
    settle(order)
    return { accountId, order }
  }
  const ent = (accountId) => computeEntitlements({ store, accountId, now: () => now })
  const advance = ms => { now += ms }
  t.after(() => store.close())
  return { store, provider, settle, buy, ent, advance, setNow: ms => { now = ms }, getNow: () => now }
}

test('entitlements: free account �?local tier; paid charge �?cloud tier with quota', async t => {
  const { store, buy, ent } = kit(t)
  const { accountId } = store.createAccount()
  assert.equal(ent(accountId).tier, 'local')
  assert.equal(ent(accountId).hostedSync, false)
  assert.equal(checkSyncAllowed(ent(accountId)).allowed, false)

  const { accountId: paidId } = buy('monthly')
  const e = ent(paidId)
  assert.equal(e.tier, 'cloud')
  assert.equal(e.hostedSync, true)
  assert.equal(e.maxDevices, 5)
  assert.equal(e.storageQuotaBytes, GIB)
  assert.equal(e.overQuota, false)
  assert.equal(e.grace, false)
  assert.equal(checkSyncAllowed(e).allowed, true)
  void store
})

test('entitlements: storage usage vs quota �?over-quota gates hosted sync', async t => {
  const { store, buy, ent } = kit(t)
  const { accountId } = buy('monthly')
  store.setUsage(accountId, 512 * 1024 * 1024)
  assert.equal(ent(accountId).overQuota, false)
  store.setUsage(accountId, GIB + 1)
  const e = ent(accountId)
  assert.equal(e.overQuota, true)
  assert.equal(checkSyncAllowed(e).allowed, false)
  assert.equal(checkSyncAllowed(e).reason, 'storage-quota-exceeded')
  store.setUsage(accountId, 100)
  assert.equal(ent(accountId).overQuota, false, 'usage is absolute �?dropping below re-opens sync')
})

test('entitlements: refund/chargeback freeze wins even inside the paid window', async t => {
  const { settle, buy, ent, store, getNow } = kit(t)
  const { accountId, order } = buy('monthly')
  assert.equal(ent(accountId).tier, 'cloud')
  settle(order, 'refund.succeeded')
  const e = ent(accountId)
  assert.equal(e.frozen, true)
  assert.equal(e.frozenReason, 'refund')
  assert.equal(e.hostedSync, false)
  assert.equal(e.tier, 'local', 'frozen accounts read as free tier')
  assert.equal(checkSyncAllowed(e).allowed, false)
  assert.equal(checkSyncAllowed(e).reason, 'subscription-refund')
  assert.equal(store.getSubscription(accountId).currentPeriodEnd > getNow(), true,
    'paid window is NOT truncated �?freeze is the gate, history stays intact')
})

test('entitlements: grace window keeps sync alive, then expiry downgrades to local', async t => {
  const { buy, ent, advance } = kit(t)
  const { accountId } = buy('monthly')
  advance(29 * 24 * 60 * 60 * 1000) // day 29 of 30
  assert.equal(ent(accountId).grace, false)
  assert.equal(ent(accountId).hostedSync, true)
  advance(2 * 24 * 60 * 60 * 1000) // 1 day past period end
  const g = ent(accountId)
  assert.equal(g.grace, true, 'inside GRACE_MS after period end')
  assert.equal(g.hostedSync, true, 'renewal payments land late �?do not cut loyal users mid-cycle')
  assert.equal(checkSyncAllowed(g).allowed, true)
  advance(GRACE_MS) // past grace now
  const x = ent(accountId)
  assert.equal(x.tier, 'local')
  assert.equal(x.hostedSync, false)
  assert.equal(x.grace, false)
  assert.equal(checkSyncAllowed(x).reason, 'plan-hosted-sync-unavailable')
})

test('entitlements: renewal stacks on the existing period (early pay never loses days)', async t => {
  const { store, provider, settle, buy, setNow } = kit(t)
  const { accountId, order: first } = buy('annual')
  const end1 = store.getSubscription(accountId).currentPeriodEnd
  setNow(T0 + 200 * 24 * 60 * 60 * 1000) // day 200 of 365: renew early
  const second = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'annual' }).order
  settle(second)
  const sub = store.getSubscription(accountId)
  assert.equal(sub.status, 'active')
  assert.equal(sub.currentPeriodEnd, end1 + 365 * 24 * 60 * 60 * 1000,
    'renewal extends from max(now, periodEnd)')
  assert.equal(first.status, 'paid')
})

test('ledger: append-only hash chain verifies; any retro-edit/deletion/reorder breaks it', async t => {
  const { store, buy, settle } = kit(t)
  const { order } = buy('monthly')
  settle(order, 'refund.succeeded')
  const entries = store.ledger.all()
  assert.deepEqual(entries.map(e => e.type), ['charge', 'refund'])
  assert.equal(entries[0].prevHash, 'GENESIS')
  assert.equal(verifyChain(entries).ok, true)

  // retro-edit amount
  const edited = entries.map(e => ({ ...e }))
  edited[0].amountMinor = 1
  assert.equal(verifyChain(edited).ok, false)
  assert.equal(verifyChain(edited).brokenAt, 1)
  // deletion of a middle entry: surviving pair no longer lines up by seq/hash
  assert.equal(verifyChain([entries[0], entries[1]]).ok, true, 'full chain verifies')
  const three = buy2Chain(store)
  assert.equal(verifyChain(three.slice(0, 1).concat(three.slice(2))).ok, false, 'deleting the middle entry breaks the chain')
  // reorder
  assert.equal(verifyChain([entries[1], entries[0]]).ok, false)
})

// build a 3-entry chain in one store to exercise middle-deletion
function buy2Chain (store) {
  const provider = createSandboxProvider({ webhookSecret: 'whsec-chain-0123456789ab', now: () => Date.now() })
  const { accountId } = store.createAccount()
  const o1 = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  const deliver = (order, type) => {
    const e = provider.emitEvent({ orderId: order.orderId, type, amountMinor: order.amountMinor, currency: order.currency })
    return processWebhook({ store, provider, ledger: store.ledger, rawBody: e.body, headers: e.headers })
  }
  deliver(o1, 'charge.succeeded')
  const o2 = createOrder({ store, provider, accountId, planId: 'cloud', cycle: 'annual' }).order
  deliver(o2, 'charge.succeeded')
  deliver(o2, 'refund.succeeded')
  return store.ledger.all().slice(-3)
}

test('ledger: appends are rejected for zero/negative/float amounts at the entry level', async t => {
  const { store } = kit(t)
  assert.throws(() => store.ledger.append({ type: 'charge', amountMinor: 0, currency: 'USD' }), /positive safe integer/)
  assert.throws(() => store.ledger.append({ type: 'charge', amountMinor: -100, currency: 'USD' }))
  assert.throws(() => store.ledger.append({ type: 'charge', amountMinor: 4.99, currency: 'USD' }))
  assert.throws(() => store.ledger.append({ type: 'wallet-topup' }), /unknown entry type/)
})

test('store file mode: state + ledger survive restart; chain-verified boot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-billing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const buy = () => {
    const s = createBillingStore({ dataDir: dir, now: () => T0 })
    const provider = createSandboxProvider({ webhookSecret: 'whsec-file-0123456789abcd', now: () => T0 })
    const { accountId } = s.createAccount()
    const order = createOrder({ store: s, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
    const e = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
    processWebhook({ store: s, provider, ledger: s.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
    s.close()
    return { accountId, orderId: order.orderId }
  }
  const { accountId, orderId } = buy()
  // reopen: account, order, subscription restored; ledger chain intact
  const s2 = createBillingStore({ dataDir: dir, now: () => T0 })
  assert.equal(s2.getAccount(accountId).accountId, accountId)
  assert.equal(s2.getOrder(orderId).status, 'paid')
  assert.equal(s2.getSubscription(accountId).status, 'active')
  assert.equal(s2.ledger.all().length, 1)
  assert.equal(s2.ledger.verify().ok, true)
  s2.close()

  // tamper one byte of money history on disk �?boot QUARANTINES and refuses
  const ledgerPath = join(dir, 'ledger.jsonl')
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
  const evil = lines.map(l => l.replace('"amountMinor":499', '"amountMinor":1'))
  writeFileSync(ledgerPath, evil.join('\n') + '\n')
  const s3 = createBillingStore({ dataDir: dir, now: () => T0 })
  assert.equal(s3.ledger.all().length, 0, 'tampered chain never boots into service')
  assert.equal(existsSync(ledgerPath + '.bad'), true, 'original quarantined for investigation')
  s3.close()
})
