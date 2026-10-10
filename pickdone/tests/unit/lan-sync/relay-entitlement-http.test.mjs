/**
 * 2026-10-10 — HTTP acceptance for the DEFAULT-OFF relay entitlement gate
 * (feature/syncv2-relay-entitlement).
 *
 * Proves at the real HTTP surface (startRelayServer):
 *   1. Gate OFF (default): byte-for-byte the historical relay — open
 *      registration + push with NO billing anything (regression guard).
 *   2. Gate ON, unbound/free account: register+push 403; client self-reported
 *      paid flags in the body are IGNORED (no cloud subscription without a
 *      server-verified binding).
 *   3. Gate ON, paid bound account: register+push+pull all work; refund via
 *      the signed webhook freezes: push/register -> 403, pull (read) stays 200.
 *   4. Device limit: the over-limit device register is 403; the under-limit
 *      ones and proven rotations stay 200.
 *   5. Byte quota: over-quota push -> coded 413 BEFORE any write; retry of the
 *      SAME push keeps failing cleanly (usage untouched) and a quota reset
 *      lets it through — a transient denial never becomes permanent.
 *   6. Replay/concurrent idempotency over HTTP: the same push twice yields the
 *      same serverSeq, both 200, usage metered once.
 *   7. Cross-account secret isolation still holds with the gate on: account
 *      A's device secret cannot read or write account B (401).
 *
 * Run: node --test tests/unit/lan-sync/relay-entitlement-http.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { createEntitlementGate, createSandboxTrustBridge } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay-entitlement.mjs')))
const billingMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/store.mjs')))
const ordersMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/orders.mjs')))
const webhookMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/webhook.mjs')))
const providerMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/providers/sandbox.mjs')))

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

const post = (base, url, body, secret) => fetch(base + url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    connection: 'close', // see relay-registration-guard.test.mjs: pooled keep-alive teardown crashes on win32
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
})

async function shutdown (server) {
  if (server.closeAllConnections) server.closeAllConnections()
  await new Promise(r => server.close(r))
}

/** Boot a gated relay wired to the in-process sandbox trust bridge over a
 *  fresh in-memory billing store. Returns handles to relay + gate + billing. */
async function boot () {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
  const gate = createEntitlementGate({ trustResolver: bridge, now: () => NOW })
  const relay = createRelay(memoryStore(), { entitlements: gate })
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  return { server, url, relay, gate, bridge, billingStore }
}

const register = async (base, account, device, extra = {}) => {
  const res = await post(base, '/v1/device/register', { account, device, ...extra })
  const out = await res.json()
  return { status: res.status, secret: out.device && out.device.deviceSecret, out }
}

/** Bind a relay account to a fresh billing account with an ACTIVE cloud sub. */
function bindPaid (billingStore, bridge, relayAccount) {
  const { accountId } = billingStore.createAccount()
  billingStore.setSubscription(accountId, {
    accountId, planId: 'cloud', cycle: 'monthly', status: 'active',
    startedAt: NOW - DAY, currentPeriodEnd: NOW + 30 * DAY, orderId: 'ord_seed', frozenReason: null,
  })
  bridge.bind(relayAccount, accountId)
  return accountId
}

test('HTTP: gate OFF (default) — historical semantics untouched, no billing required', async () => {
  const billingStore = billingMod.createBillingStore({ now: () => NOW })
  const relay = createRelay(memoryStore()) // DEFAULT: no entitlements option at all
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const reg = await register(url, 'free-soul', 'dev1')
    assert.equal(reg.status, 200, 'default relay: open registration unchanged')
    const push = await post(url, '/v1/sync/push', { account: 'free-soul', device: 'dev1', items: [{ opId: 'o1', envelope: '{"v":1}' }] }, reg.secret)
    assert.equal(push.status, 200, 'default relay: push needs no entitlement')
    const pull = await post(url, '/v1/sync/pull', { account: 'free-soul', afterSeq: 0 }, reg.secret)
    assert.equal(pull.status, 200)
    assert.equal((await pull.json()).items.length, 1)
  } finally { await shutdown(server) }
})

test('HTTP: gate ON + unbound account — self-reported paid flags in the body are IGNORED', async () => {
  const { server, url, gate } = await boot()
  try {
    // hostile client: claims a cloud subscription in its own body — worth nothing
    const reg = await register(url, 'im-poster-child', 'dev1', {
      paid: true, tier: 'cloud', planId: 'cloud', maxDevices: 999999, storageQuotaBytes: 1 << 30,
    })
    assert.equal(reg.status, 403, 'register without a server binding is denied even with self-claimed paid')
    assert.match(reg.out.error, /no-server-identity/)
    assert.equal(gate.usageBytes('im-poster-child'), undefined, 'no usage state created for the denial')

    // auth precedes entitlement on data routes: an account that could never
    // register has no device secret, so its push is 401 (never 200). The 403
    // no-server-identity above is what stops it from ever getting that far —
    // and the gate-level unit test proves the self-claimed flags are ignored
    // even with a valid bearer (resolver input carries no client claims).
    const push = await post(url, '/v1/sync/push', {
      account: 'im-poster-child', device: 'dev1', paid: true, tier: 'cloud',
      items: [{ opId: 'o1', envelope: '{"v":1}' }],
    })
    assert.equal(push.status, 401, 'unbound account: no device secret exists, auth fails first')
    assert.equal(gate.usageBytes('im-poster-child'), undefined, 'no usage state created for the denial')
  } finally { await shutdown(server) }
})

test('HTTP: gate ON + paid bound account — full sync works; signed-webhook refund freezes writes, reads stay open', async () => {
  const { server, url, gate, bridge, billingStore } = await boot()
  try {
    bindPaid(billingStore, bridge, 'subscriber')
    const reg = await register(url, 'subscriber', 'dev1')
    assert.equal(reg.status, 200)
    const push = await post(url, '/v1/sync/push', { account: 'subscriber', device: 'dev1', items: [{ opId: 'o1', envelope: '{"v":1}' }] }, reg.secret)
    assert.equal(push.status, 200)

    // refund through the ONLY money door: create order -> charge -> refund (signed webhooks)
    const provider = providerMod.createSandboxProvider({ webhookSecret: 'whsec_http_test_01', now: () => NOW })
    const { accountId } = bridge.bindingOf('subscriber')
    const { order } = ordersMod.createOrder({ store: billingStore, provider, accountId, planId: 'cloud', cycle: 'monthly' })
    const run = ev => webhookMod.processWebhook({ store: billingStore, provider, ledger: billingStore.ledger, ...ev, now: () => NOW })
    const charge = provider.emitEvent({
      orderId: order.orderId, type: 'charge.succeeded',
      amountMinor: order.amountMinor, currency: order.currency,
    })
    assert.equal(run({ rawBody: charge.body, headers: charge.headers }).body.applied, true)
    const refund = provider.emitEvent({ orderId: order.orderId, type: 'refund.succeeded', amountMinor: order.amountMinor, currency: order.currency })
    assert.equal(run({ rawBody: refund.body, headers: refund.headers }).body.applied, true)

    const pushFrozen = await post(url, '/v1/sync/push', { account: 'subscriber', device: 'dev1', items: [{ opId: 'o2', envelope: '{"v":2}' }] }, reg.secret)
    assert.equal(pushFrozen.status, 403, 'frozen account cannot push')
    assert.match((await pushFrozen.json()).error, /subscription-refund/)
    const regFrozen = await register(url, 'subscriber', 'dev2')
    assert.equal(regFrozen.status, 403, 'frozen account cannot enroll NEW devices')
    const pullFrozen = await post(url, '/v1/sync/pull', { account: 'subscriber', afterSeq: 0 }, reg.secret)
    assert.equal(pullFrozen.status, 200, 'frozen account still READS its history (export path)')
    assert.equal((await pullFrozen.json()).items.length, 1, 'and sees exactly the pre-freeze envelope')
  } finally { await shutdown(server) }
})

test('HTTP: device limit — over-limit register is 403, proven rotation still 200', async () => {
  const { server, url, bridge, billingStore } = await boot()
  try {
    bindPaid(billingStore, bridge, 'duo')
    // operator-level plan override (support/enterprise custom limits): cap at 2 devices
    bridge.setPlanOverride('duo', { maxDevices: 2 })
    const r1 = await register(url, 'duo', 'd1')
    assert.equal(r1.status, 200)
    const r2 = await register(url, 'duo', 'd2')
    assert.equal(r2.status, 200)
    const r3 = await register(url, 'duo', 'd3')
    assert.equal(r3.status, 403, 'third NEW device exceeds the plan limit')
    assert.match(r3.out.error, /device-limit/)
    // rotation of an existing device is idempotent — allowed at full count
    const rot = await register(url, 'duo', 'd1', { deviceSecret: r1.secret })
    assert.equal(rot.status, 200, 'proven rotation never counts against the device limit')
  } finally { await shutdown(server) }
})

test('HTTP: byte quota — over-quota push is a coded 413 with usage untouched; reset lets the retry through', async () => {
  const { server, url, gate, bridge, billingStore } = await boot()
  try {
    const accountId = bindPaid(billingStore, bridge, 'metered')
    billingStore.setUsage(accountId, 0) // trusted-reporter style seed: meter starts at zero
    bridge.setPlanOverride('metered', { storageQuotaBytes: 50 })
    const reg = await register(url, 'metered', 'dev1')
    assert.equal(reg.status, 200)

    const ok = await post(url, '/v1/sync/push', { account: 'metered', device: 'dev1', items: [{ opId: 'o1', envelope: 'd'.repeat(20) }] }, reg.secret)
    assert.equal(ok.status, 200)
    assert.equal(gate.usageBytes('metered'), 20)

    const over = await post(url, '/v1/sync/push', { account: 'metered', device: 'dev1', items: [{ opId: 'o2', envelope: 'e'.repeat(40) }] }, reg.secret)
    assert.equal(over.status, 413, 'quota breach is an explicit HTTP 413, not a 500/timeout')
    assert.match((await over.json()).error, /storage-quota-exceeded/)
    assert.equal(gate.usageBytes('metered'), 20, 'denial metered nothing')
    const retry = await post(url, '/v1/sync/push', { account: 'metered', device: 'dev1', items: [{ opId: 'o2', envelope: 'e'.repeat(40) }] }, reg.secret)
    assert.equal(retry.status, 413, 'retry of the same over-quota push still fails cleanly')
    assert.equal(gate.usageBytes('metered'), 20)

    // operator/reconcile resets usage — the SAME push now succeeds (no permanent lockout)
    gate.setUsage('metered', 0)
    const after = await post(url, '/v1/sync/push', { account: 'metered', device: 'dev1', items: [{ opId: 'o2', envelope: 'e'.repeat(40) }] }, reg.secret)
    assert.equal(after.status, 200, 'error retry must never become a permanent invalidation')
    assert.equal(gate.usageBytes('metered'), 40)
  } finally { await shutdown(server) }
})

test('HTTP: replay idempotency — same push twice, same serverSeq, metered once', async () => {
  const { server, url, gate, bridge, billingStore } = await boot()
  try {
    const accountId = bindPaid(billingStore, bridge, 'idem')
    billingStore.setUsage(accountId, 0)
    const reg = await register(url, 'idem', 'dev1')
    const items = [{ opId: 'op-x', envelope: 'z'.repeat(25) }]
    const p1 = await post(url, '/v1/sync/push', { account: 'idem', device: 'dev1', items }, reg.secret)
    const p2 = await post(url, '/v1/sync/push', { account: 'idem', device: 'dev1', items }, reg.secret)
    assert.equal(p1.status, 200); assert.equal(p2.status, 200)
    const b1 = await p1.json(); const b2 = await p2.json()
    assert.equal(b1.acked['op-x'], b2.acked['op-x'], 'replay keeps the original serverSeq')
    assert.deepEqual(b2.duplicates, ['op-x'], 'the response names the replayed opId')
    assert.equal(gate.usageBytes('idem'), 25, 'usage metered exactly once')
  } finally { await shutdown(server) }
})

test('HTTP: cross-account secret isolation holds with the gate on — A token cannot touch B', async () => {
  const { server, url, bridge, billingStore } = await boot()
  try {
    bindPaid(billingStore, bridge, 'alice')
    bindPaid(billingStore, bridge, 'bob')
    const alice = await register(url, 'alice', 'devA')
    const bob = await register(url, 'bob', 'devB')
    assert.equal(alice.status, 200); assert.equal(bob.status, 200)

    const steal = await post(url, '/v1/sync/push', { account: 'bob', device: 'devB', items: [{ opId: 'o-b', envelope: '{"v":1}' }] }, alice.secret)
    assert.equal(steal.status, 401, "alice's device secret must not authorize bob's stream")
    const readSteal = await post(url, '/v1/sync/pull', { account: 'bob', afterSeq: 0 }, alice.secret)
    assert.equal(readSteal.status, 401, "alice's device secret must not read bob's history")
    const stateSteal = await post(url, '/v1/device/state', { account: 'bob', device: 'devB', status: 'retired' }, alice.secret)
    assert.equal(stateSteal.status, 401, "alice's device secret must not retire bob's device")

    const own = await post(url, '/v1/sync/push', { account: 'bob', device: 'devB', items: [{ opId: 'o-b', envelope: '{"v":1}' }] }, bob.secret)
    assert.equal(own.status, 200, "bob's own secret still works")
  } finally { await shutdown(server) }
})
