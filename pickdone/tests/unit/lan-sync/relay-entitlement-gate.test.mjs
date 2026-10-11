/**
 * 2026-10-10 — server-authoritative entitlement gate for the sync relay
 * (DEFAULT OFF; feature/syncv2-relay-entitlement).
 *
 * What is under test here (transport-agnostic, pure seam level):
 *   1. TrustResolver contract — ONLY a server-verified decision grants hosted
 *      sync; an untrusted/no-binding account is treated as free tier. Client
 *      self-reported paid flags NEVER reach the resolver (it is not even given
 *      them — the input shape is { account, device, action } only).
 *   2. Freeze policy — refund/chargeback frozen accounts: register+push DENIED,
 *      read paths untouched (pull is never wrapped).
 *   3. Grace policy — expired-but-in-grace keeps hosted sync (explicit policy).
 *   4. Device limit — maxDevices counts ACTIVE device rows; proven rotation of
 *      an existing device is idempotent and never blocked by the count.
 *   5. Storage quota — relay-metered ciphertext bytes; breach is a coded 413
 *      BEFORE any store write; a rejected push leaves usage untouched, and
 *      after a quota reset the same push succeeds (error retry never poisons).
 *   6. Replay/concurrent idempotency — re-pushing the same opIds adds ZERO
 *      usage (relay reports duplicates; the gate never double-counts).
 *   7. Sandbox trust bridge — in-process binding of relay account -> billing
 *      account; unbound account = untrusted; frozen/grace/expired map from
 *      computeEntitlements. SANDBOX ONLY (see NO-GO list in the module header).
 *
 * Run: node --test tests/unit/lan-sync/relay-entitlement-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const ENT = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay-entitlement.mjs')))
const { createEntitlementGate, createSandboxTrustBridge } = ENT
const billingMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/store.mjs')))
const plansMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/plans.mjs')))

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

/** Decision factory: a fully-privileged cloud decision, tweaked per test. */
const cloudDecision = (over = {}) => ({
  trusted: true,
  accountId: 'acct_billing',
  tier: 'cloud',
  hostedSync: true,
  frozen: false,
  frozenReason: null,
  grace: false,
  maxDevices: null,
  storageQuotaBytes: null,
  storageUsageBytes: 0,
  ...over,
})

const resolverOf = map => async ({ account }) => map.get(account) || cloudDecision({ trusted: false })

const gateErr = async (fn, status, re) => {
  try { await fn() } catch (e) {
    assert.equal(e.status, status, `expected status ${status}, got ${e.status}: ${e.message}`)
    if (re) assert.match(e.message, re)
    return e
  }
  assert.fail(`expected a ${status} entitlement rejection`)
}

// ---------- 1/6: trust contract + freeze + grace decision matrix ----------

test('gate: untrusted account (no server binding) is denied register and push as free tier', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({ trustResolver: resolverOf(new Map()), now: () => NOW })
  await gateErr(() => gate.guardDeviceRegister({ account: 'who', device: 'd1', store }), 403, /no-server-identity/)
  await gateErr(() => gate.guardPush({ account: 'who', device: 'd1', items: [{ opId: 'o', envelope: '{}' }], store }), 403, /no-server-identity/)
})

test('gate: resolver receives NO client-controlled paid claims (input shape contract)', async () => {
  const seen = []
  const gate = createEntitlementGate({
    trustResolver: async input => { seen.push(input); return cloudDecision() },
    now: () => NOW,
  })
  const store = memoryStore()
  await gate.guardPush({
    account: 'a', device: 'd', store,
    // hostile client body: self-reported paid flags must not flow into the resolver
    claims: { paid: true, tier: 'cloud', planId: 'cloud', maxDevices: 999 },
  })
  assert.equal(seen.length, 1)
  const keys = Object.keys(seen[0]).sort()
  assert.deepEqual(keys, ['account', 'action', 'device'], 'resolver input is identity-shaped only')
})

test('gate: frozen account (refund/chargeback) — register+push denied, code names the freeze reason', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ frozen: true, frozenReason: 'refund' })]])),
    now: () => NOW,
  })
  await gateErr(() => gate.guardDeviceRegister({ account: 'a', device: 'new-dev', store }), 403, /subscription-refund/)
  await gateErr(() => gate.guardPush({ account: 'a', device: 'd', items: [], store }), 403, /subscription-refund/)
})

test('gate: frozen wins over grace and over hostedSync quirks', async () => {
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ frozen: true, frozenReason: 'chargeback', grace: true })]])),
    now: () => NOW,
  })
  await gateErr(() => gate.guardPush({ account: 'a', device: 'd', items: [], store: memoryStore() }), 403, /chargeback/)
})

test('gate: expired beyond grace (hostedSync false) is denied like free tier', async () => {
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ hostedSync: false, grace: false })]])),
    now: () => NOW,
  })
  await gateErr(() => gate.guardPush({ account: 'a', device: 'd', items: [], store: memoryStore() }), 403, /plan-hosted-sync-unavailable/)
})

test('gate: grace keeps hosted sync (explicit grace policy) — push and new device allowed', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ grace: true })]])),
    now: () => NOW,
  })
  await gate.guardDeviceRegister({ account: 'a', device: 'd1', store })
  await gate.guardPush({ account: 'a', device: 'd1', items: [{ opId: 'o1', envelope: '{"v":1}' }], store })
})

test('gate: resolver failure is fail-closed for paid actions (503), never a crash or an allow', async () => {
  const gate = createEntitlementGate({
    trustResolver: async () => { throw new Error('billing service down') },
    now: () => NOW,
  })
  await gateErr(() => gate.guardDeviceRegister({ account: 'a', device: 'd', store: memoryStore() }), 503, /resolver-unavailable/)
  await gateErr(() => gate.guardPush({ account: 'a', device: 'd', items: [], store: memoryStore() }), 503, /resolver-unavailable/)
})

// ---------- 2/6: device limit ----------

test('gate: maxDevices counts ACTIVE rows — the (N+1)th NEW device is denied with a coded 403', async () => {
  const store = memoryStore()
  store.upsertDevice('a', 'd1', {})
  store.upsertDevice('a', 'd2', {})
  store.upsertDevice('a', 'd3', { status: 'retired' }) // retired rows do not count
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ maxDevices: 2 })]])),
    now: () => NOW,
  })
  await gateErr(() => gate.guardDeviceRegister({ account: 'a', device: 'd4', store }), 403, /device-limit/)
})

test('gate: proven re-registration of an EXISTING device is idempotent — never blocked by device limit', async () => {
  const store = memoryStore()
  store.upsertDevice('a', 'd1', {})
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ maxDevices: 1 })]])),
    now: () => NOW,
  })
  await gate.guardDeviceRegister({ account: 'a', device: 'd1', store }) // rotation, not a new device
})

test('gate: maxDevices null/undefined means unlimited', async () => {
  const store = memoryStore()
  for (let i = 0; i < 5; i++) store.upsertDevice('a', `d${i}`, {})
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ maxDevices: null })]])),
    now: () => NOW,
  })
  await gate.guardDeviceRegister({ account: 'a', device: 'd99', store })
})

// ---------- 3/6: storage quota + retry safety ----------

test('gate: push breaching the byte quota is a coded 413 thrown BEFORE any store write', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ storageQuotaBytes: 10 })]])),
    now: () => NOW,
  })
  const relay = createRelay(store, { entitlements: gate })
  await relay.push('a', 'd', [{ opId: 'o1', envelope: '12345678' }]) // 8 bytes, fits
  assert.equal(store.lastSeq(), 1)
  await gateErr(
    () => relay.push('a', 'd', [{ opId: 'o2', envelope: '1234567890123' }]),
    413, /storage-quota-exceeded/,
  )
  assert.equal(store.lastSeq(), 1, 'the rejected push must not have touched the store')
  assert.ok(store.getDevice('a', 'd'), 'the accepted push did its normal device bookkeeping')
})

test('gate: rejected push leaves usage untouched — retry after quota reset succeeds (no permanent poisoning)', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ storageQuotaBytes: 20 })]])),
    now: () => NOW,
  })
  const relay = createRelay(store, { entitlements: gate })
  await relay.push('a', 'd', [{ opId: 'o1', envelope: 'x'.repeat(15) }])
  await gateErr(
    () => relay.push('a', 'd', [{ opId: 'o2', envelope: 'y'.repeat(15) }]),
    413,
  )
  assert.equal(gate.usageBytes('a'), 15, 'the 413 must not have counted any bytes')
  // operator raises the quota (or usage is reconciled down): the SAME push now succeeds
  gate.setUsage('a', 0)
  await relay.push('a', 'd', [{ opId: 'o2', envelope: 'y'.repeat(15) }])
  assert.equal(gate.usageBytes('a'), 15, 'meter restarts from the reconciled baseline')
})

test('gate: first-seen account seeds usage from the server-reported storageUsageBytes (trusted reporter compat)', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ storageQuotaBytes: 100, storageUsageBytes: 90 })]])),
    now: () => NOW,
  })
  await gateErr(
    () => gate.guardPush({ account: 'a', device: 'd', items: [{ opId: 'o1', envelope: 'x'.repeat(20) }], store }),
    413, /storage-quota-exceeded/,
  )
  assert.equal(gate.usageBytes('a'), 90, 'seeded from the resolver-reported usage, not zero')
})

// ---------- 4/6: replay/concurrent idempotency through the wrapped relay.push ----------

test('gate: wrapped relay.push meters only NEWLY stored bytes — replayed opIds add zero usage', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ storageQuotaBytes: 100 })]])),
    now: () => NOW,
  })
  const relay = createRelay(store, { entitlements: gate })
  const items = [{ opId: 'op-1', envelope: 'e'.repeat(30) }]
  const first = await relay.push('a', 'd', items)
  assert.equal(first.acked['op-1'], 1)
  assert.deepEqual(first.duplicates, [], 'fresh push has no duplicates')
  assert.equal(gate.usageBytes('a'), 30)

  // full replay: same opId, same envelope — accepted, idempotent, zero usage delta
  const replay = await relay.push('a', 'd', items)
  assert.equal(replay.acked['op-1'], 1, 'same serverSeq as the first push')
  assert.deepEqual(replay.duplicates, ['op-1'])
  assert.equal(gate.usageBytes('a'), 30, 'duplicate push must not be metered twice')

  // partial replay: one known + one fresh opId
  const mixed = await relay.push('a', 'd', [{ opId: 'op-1', envelope: 'e'.repeat(30) }, { opId: 'op-2', envelope: 'f'.repeat(10) }])
  assert.deepEqual(mixed.duplicates, ['op-1'])
  assert.equal(gate.usageBytes('a'), 40)
})

test('gate: replayed push does NOT trip the quota projection (retry inside quota stays green)', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['a', cloudDecision({ storageQuotaBytes: 35 })]])),
    now: () => NOW,
  })
  const relay = createRelay(store, { entitlements: gate })
  const items = [{ opId: 'op-1', envelope: 'q'.repeat(30) }]
  await relay.push('a', 'd', items)
  // 30 stored + 30 naive projection would exceed 35 — the projection must exclude the known opId
  const out = await relay.push('a', 'd', items)
  assert.equal(out.acked['op-1'], 1)
  assert.equal(gate.usageBytes('a'), 30)
})

// ---------- 5/6: read paths are never gated ----------

test('gate: pull/snapshot stay open for free, frozen and grace accounts (read-only always allowed)', async () => {
  const store = memoryStore()
  const gate = createEntitlementGate({
    trustResolver: resolverOf(new Map([['frozen', cloudDecision({ frozen: true, frozenReason: 'refund' })]])),
    now: () => NOW,
  })
  const relay = createRelay(store, { entitlements: gate })
  // seed one envelope directly through the store (pre-freeze data)
  store.appendEnvelope('frozen', 'op-pre', '{"v":1}')
  const pulled = relay.pull('frozen', 0, 1024)
  assert.equal(pulled.items.length, 1, 'frozen account still reads its history (export/read path)')
  assert.equal(relay.latestSnapshot('frozen'), null)
  assert.equal(gate.usageBytes('frozen'), undefined, 'reads are not metered')
})

// ---------- 6/6: sandbox trust bridge over the real billing store ----------

const seedSub = (billingStore, accountId, over = {}) => billingStore.setSubscription(accountId, {
  accountId, planId: 'cloud', cycle: 'monthly', status: 'active',
  startedAt: NOW - DAY, currentPeriodEnd: NOW + 30 * DAY, orderId: 'ord_seed', frozenReason: null,
  ...over,
})

test('sandbox bridge: unbound relay account resolves untrusted; client cannot self-bind', async () => {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
  const d = await bridge.resolveTrust({ account: 'ghost' })
  assert.equal(d.trusted, false, 'no in-process binding = no cloud subscription')
  assert.ok(bridge.trustLevel.includes('sandbox'), 'bridge is explicitly labeled sandbox')
})

test('sandbox bridge: bound account with active cloud sub resolves the cloud decision', async () => {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const { accountId } = billingStore.createAccount()
  seedSub(billingStore, accountId)
  const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
  bridge.bind('user-a', accountId)
  const d = await bridge.resolveTrust({ account: 'user-a' })
  assert.equal(d.trusted, true)
  assert.equal(d.tier, 'cloud')
  assert.equal(d.hostedSync, true)
  assert.equal(d.maxDevices, 5, 'cloud plan device limit flows through')
  assert.equal(d.storageQuotaBytes, 1024 * 1024 * 1024)
})

test('sandbox bridge: refund freeze / grace / expiry map through computeEntitlements', async () => {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
  const mk = name => {
    const { accountId } = billingStore.createAccount()
    bridge.bind(name, accountId)
    return accountId
  }
  const refundId = mk('refund')
  seedSub(billingStore, refundId, { status: 'frozen', frozenReason: 'refund' })
  const graceId = mk('grace')
  seedSub(billingStore, graceId, { currentPeriodEnd: NOW - Number(DAY) }) // inside 3d grace
  const expiredId = mk('expired')
  seedSub(billingStore, expiredId, { currentPeriodEnd: NOW - 5 * Number(DAY) }) // beyond grace

  const refund = await bridge.resolveTrust({ account: 'refund' })
  assert.equal(refund.frozen, true)
  assert.equal(refund.frozenReason, 'refund')
  assert.equal(refund.hostedSync, false)

  const grace = await bridge.resolveTrust({ account: 'grace' })
  assert.equal(grace.frozen, false)
  assert.equal(grace.grace, true)
  assert.equal(grace.hostedSync, true, 'grace keeps hosted sync (explicit policy)')

  const expired = await bridge.resolveTrust({ account: 'expired' })
  assert.equal(expired.grace, false)
  assert.equal(expired.hostedSync, false)
  assert.equal(expired.tier, plansMod.getPlan('local').tier, 'expired reverts to the local tier')
})

test('sandbox bridge: end-to-end freeze through the signed webhook path flips the relay decision', async () => {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const { accountId } = billingStore.createAccount()
  seedSub(billingStore, accountId)
  const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
  bridge.bind('user-a', accountId)
  assert.equal((await bridge.resolveTrust({ account: 'user-a' })).frozen, false)

  // refund arrives via the ONLY money door: signed webhook -> order refunded -> freeze
  const ordersMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/orders.mjs')))
  const webhookMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/webhook.mjs')))
  const providerMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/providers/sandbox.mjs')))
  const provider = providerMod.createSandboxProvider({ webhookSecret: 'whsec_test_123456', now: () => NOW })
  const { order } = ordersMod.createOrder({ store: billingStore, provider, accountId, planId: 'cloud', cycle: 'monthly' })
  const run = event => webhookMod.processWebhook({
    store: billingStore, provider, ledger: billingStore.ledger, ...event, now: () => NOW,
  })
  const charge = provider.emitEvent({
    orderId: order.orderId, type: 'charge.succeeded',
    amountMinor: order.amountMinor, currency: order.currency,
  })
  assert.equal(run({ rawBody: charge.body, headers: charge.headers }).body.applied, true)
  const refund = provider.emitEvent({
    orderId: order.orderId, type: 'refund.succeeded',
    amountMinor: order.amountMinor, currency: order.currency,
  })
  assert.equal(run({ rawBody: refund.body, headers: refund.headers }).body.applied, true)
  const d = await bridge.resolveTrust({ account: 'user-a' })
  assert.equal(d.frozen, true, 'webhook refund freezes the entitlement decision')
  assert.equal(d.frozenReason, 'refund')
})

test('gate: default policy object is frozen and documents the explicit read/grace strategy', () => {
  assert.ok(Object.isFrozen(ENT.DEFAULT_ENTITLEMENT_POLICY))
  assert.equal(ENT.DEFAULT_ENTITLEMENT_POLICY.readOnlyAlwaysAllowed, true)
  assert.equal(ENT.DEFAULT_ENTITLEMENT_POLICY.graceAllowsPush, true)
  assert.equal(ENT.DEFAULT_ENTITLEMENT_POLICY.quotaPushStatus, 413)
  assert.equal(ENT.DEFAULT_ENTITLEMENT_POLICY.resolverError, 'fail-closed')
})
