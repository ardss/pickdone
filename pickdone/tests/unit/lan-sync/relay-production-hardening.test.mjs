/**
 * 2026-10-11 — production-gap closure acceptance for the relay's operator plane
 * (follow-up to feature/syncv2-relay-entitlement; see PRODUCTION_NO_GO #4 and
 * the deployment-gate headers in sync-relay.mjs / relay-sync-adapter.js).
 *
 * Proves at the REAL surfaces:
 *   1. TLS: startRelayServer({tls}) serves the byte-identical route surface over
 *      HTTPS with a real self-signed cert (fixture); bearer auth works over TLS;
 *      the plain-HTTP handshake cannot speak to the TLS port.
 *   2. Usage-quota persistence: metered bytes survive a gate+relay restart —
 *      before this, bouncing the relay reset metering to zero and a quota could
 *      be bypassed by a restart. Restart → over-quota push still 413.
 *   3. Corrupt usage snapshot quarantines to .bad and restarts metering at zero
 *      (the safe direction — store-level opId dedupe keeps replays un-metered).
 *   4. Account-binding persistence: operator bindings survive a bridge restart —
 *      before this, every restart untrusted ALL accounts until re-provisioned.
 *   5. main() wiring: --tls-cert without --tls-key is a coded boot error;
 *      --hosted builds the gate with durable files in the billing data dir.
 *
 * Run: node --test tests/unit/lan-sync/relay-production-hardening.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const relayMod = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const entMod = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay-entitlement.mjs')))
const billingMod = await import(pathToFileURL(path.join(ROOT, 'server/billing/store.mjs')))

const { memoryStore, createRelay, startRelayServer, main } = relayMod
const { createEntitlementGate, createSandboxTrustBridge } = entMod

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000
const CERT = fs.readFileSync(path.join(ROOT, 'tests/fixtures/relay-tls/localhost-cert.pem'), 'utf8')
const KEY = fs.readFileSync(path.join(ROOT, 'tests/fixtures/relay-tls/localhost-key.pem'), 'utf8')

const post = (base, url, body, secret) => fetch(base + url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    connection: 'close', // pooled keep-alive teardown crashes on win32 (see relay-registration-guard.test.mjs)
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  },
  body: JSON.stringify(body),
})

async function shutdown (server) {
  if (server.closeAllConnections) server.closeAllConnections()
  await new Promise(r => server.close(r))
}

async function register (url, account, device) {
  const res = await post(url, '/v1/device/register', { account, device })
  const out = await res.json()
  return { status: res.status, secret: out.device && out.device.deviceSecret, out }
}

function bindPaid (billingStore, bridge, relayAccount) {
  const { accountId } = billingStore.createAccount()
  billingStore.setSubscription(accountId, {
    accountId, planId: 'cloud', cycle: 'monthly', status: 'active',
    startedAt: NOW - DAY, currentPeriodEnd: NOW + 30 * DAY, orderId: 'ord_seed', frozenReason: null,
  })
  bridge.bind(relayAccount, accountId)
  return accountId
}

test('TLS: the identical route surface over HTTPS — register/push/pull with bearer auth', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1', tls: { cert: CERT, key: KEY } })
  const url = `https://127.0.0.1:${server.address().port}`
  try {
    // undici fetch needs a dispatcher-level CA; use the node:https surface with
    // the exact fixture cert as its own CA (self-signed, CN=localhost, SAN 127.0.0.1).
    const reg = await new Promise((resolve, reject) => {
      const req = https.request(url + '/v1/device/register', {
        method: 'POST', ca: CERT, headers: { 'content-type': 'application/json', connection: 'close' },
      }, res => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ account: 'tls-acc', device: 'dev-tls' }))
    })
    assert.equal(reg.status, 200, 'registration works over TLS')
    assert.ok(reg.body.device && reg.body.device.deviceSecret, 'secret minted over TLS')
    const secret = reg.body.device.deviceSecret

    const push = await new Promise((resolve, reject) => {
      const req = https.request(url + '/v1/sync/push', {
        method: 'POST', ca: CERT,
        headers: { 'content-type': 'application/json', connection: 'close', authorization: `Bearer ${secret}` },
      }, res => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ account: 'tls-acc', device: 'dev-tls', items: [{ opId: 'o1', envelope: '{"v":1}' }] }))
    })
    assert.equal(push.status, 200, 'bearer auth + push work over TLS')
    assert.ok(push.body.acked.o1 > 0)

    // plain HTTP speaking to a TLS port must fail (protocol mismatch), proving
    // the port really is TLS and not silently downgraded.
    const plain = await fetch(`http://127.0.0.1:${server.address().port}/v1/sync/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ account: 'tls-acc' }),
    }).then(r => ({ ok: true, status: r.status }), e => ({ ok: false, message: String(e && e.message || e) }))
    assert.equal(plain.ok, false, 'plain HTTP against the TLS port fails the handshake')
  } finally { await shutdown(server) }
})

/** Envelope string of EXACTLY `bytes` UTF-8 bytes (ASCII only → 1 byte/char). */
const envOf = bytes => {
  const env = JSON.stringify({ v: 1, pad: 'x' })
  const cur = Buffer.byteLength(env)
  if (bytes < cur) throw new Error('envOf: too small')
  return JSON.stringify({ v: 1, pad: 'x'.repeat(bytes - cur + 1) })
}

test('usage quota persists across a relay+gate restart — a restart no longer bypasses the quota', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-persist-'))
  const usagePath = path.join(dir, 'relay-usage.json')
  const mkHosted = async () => {
    const billingStore = billingMod.createBillingStore({ dataDir: path.join(dir, 'billing'), now: () => NOW })
    const bridge = createSandboxTrustBridge({ billingStore, bindingsPath: path.join(dir, 'billing', 'relay-bindings.json'), now: () => NOW })
    const gate = createEntitlementGate({ trustResolver: bridge, usagePath, now: () => NOW })
    const relay = createRelay(memoryStore(), { entitlements: gate })
    const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
    return { server, url: `http://127.0.0.1:${server.address().port}`, gate, bridge, billingStore }
  }
  let h = await mkHosted()
  try {
    bindPaid(h.billingStore, h.bridge, 'persisted-acc')
    const reg = await register(h.url, 'persisted-acc', 'dev1')
    assert.equal(reg.status, 200)
    // 600 bytes quota; push 500 bytes now — leaves 100
    h.bridge.setPlanOverride('persisted-acc', { storageQuotaBytes: 600 })
    const env500 = envOf(500)
    assert.equal(Buffer.byteLength(env500), 500)
    const p1 = await post(h.url, '/v1/sync/push', { account: 'persisted-acc', device: 'dev1', items: [{ opId: 'o500', envelope: env500 }] }, reg.secret)
    assert.equal(p1.status, 200)
    assert.equal(h.gate.usageBytes('persisted-acc'), 500)
    assert.ok(fs.existsSync(usagePath), 'usage snapshot write-through to disk')
  } finally { await shutdown(h.server) }

  // "restart": brand-new relay/gate/bridge over the SAME durable files
  h = await mkHosted()
  try {
    // Readiness ping (2026-10-24 night): under full-gate self-load the first fetch
    // after the restart occasionally hit a one-off socket hiccup (fetch failed at
    // 105ms, final22) — poll until the relay answers, bounded, instead of reding
    // on a transient. A relay that never comes up still fails at the deadline.
    for (let i = 0; i < 40; i++) {
      const ping = await fetch(h.url + '/v1/health', { method: 'GET' }).then(() => true, () => false)
      if (ping) break
      await new Promise(r => setTimeout(r, 250))
    }
    assert.equal(h.gate.usageBytes('persisted-acc'), 500, 'metering restored from disk')
    assert.equal(h.bridge.bindingOf('persisted-acc') && h.bridge.bindingOf('persisted-acc').accountId != null, true, 'binding restored from disk (no re-provision)')
    // the surviving 100-byte budget rejects a fresh 200-byte push
    const reg = await register(h.url, 'persisted-acc', 'dev1')
    assert.equal(reg.status, 200)
    const env200 = envOf(200)
    assert.equal(Buffer.byteLength(env200), 200)
    const denied = await post(h.url, '/v1/sync/push', { account: 'persisted-acc', device: 'dev1', items: [{ opId: 'o200', envelope: env200 }] }, reg.secret)
    assert.equal(denied.status, 413, 'quota still enforced after restart (no bypass by bouncing the relay)')
    assert.equal(h.gate.usageBytes('persisted-acc'), 500, 'denial left usage untouched')
    // replay of the ALREADY-STORED 500B push stays 200 and never double-meters
    const env500 = envOf(500)
    const replay = await post(h.url, '/v1/sync/push', { account: 'persisted-acc', device: 'dev1', items: [{ opId: 'o500', envelope: env500 }] }, reg.secret)
    assert.equal(replay.status, 200, 'stored-envelope replay is a clean idempotent 200')
    assert.equal(h.gate.usageBytes('persisted-acc'), 500, 'replay not re-metered')
  } finally { await shutdown(h.server) }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('corrupt usage snapshot quarantines to .bad and restarts metering at zero (safe direction)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-usage-corrupt-'))
  const usagePath = path.join(dir, 'relay-usage.json')
  // (a) unparseable JSON → quarantined, metering restarts at zero
  fs.writeFileSync(usagePath, 'not json at all')
  const mkGate = () => {
    const billingStore = billingMod.createBillingStore({ now: () => NOW })
    const bridge = createSandboxTrustBridge({ billingStore, now: () => NOW })
    return createEntitlementGate({ trustResolver: bridge, usagePath, now: () => NOW })
  }
  let gate = mkGate()
  assert.equal(gate.usageBytes('a') ?? 0, 0, 'metering starts at zero on the corrupt file')
  assert.ok(fs.existsSync(usagePath + '.bad'), 'evidence quarantined')
  assert.equal(fs.existsSync(usagePath), false, 'active file cleared for a fresh start')
  // (b) parseable-but-garbage ENTRIES are skipped silently (no quarantine needed)
  fs.writeFileSync(usagePath, JSON.stringify({ version: 1, accounts: { a: { total: 'BROKEN', ops: 'nope' } } }))
  gate = mkGate()
  assert.equal(gate.usageBytes('a') ?? 0, 0, 'garbage entries load as nothing — metering still starts at zero')
  // ledger keeps working after recovery
  const relay = createRelay(memoryStore(), { entitlements: gate })
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  try { assert.equal(server.listening, true, 'relay serves fine with the recovered ledger') } finally { await shutdown(server) }
  fs.rmSync(dir, { recursive: true, force: true })
})

test('bridge bindings persist across restart; corrupt bindings quarantine and trust nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bindings-persist-'))
  const bindingsPath = path.join(dir, 'relay-bindings.json')
  const billingDir = path.join(dir, 'billing')
  // billing store is DURABLE here (like a real deployment): the account row must
  // survive the restart for the restored binding to resolve as trusted.
  const mk = () => {
    const billingStore = billingMod.createBillingStore({ dataDir: billingDir, now: () => NOW })
    const bridge = createSandboxTrustBridge({ billingStore, bindingsPath, now: () => NOW })
    return { billingStore, bridge }
  }
  let { billingStore, bridge } = mk()
  bindPaid(billingStore, bridge, 'acc-a')
  assert.ok(fs.existsSync(bindingsPath), 'bindings write-through')
  // "restart"
  ;({ billingStore, bridge } = mk())
  assert.equal(bridge.bindingOf('acc-a').accountId != null, true, 'binding survived the restart')
  const trust = await bridge.resolveTrust({ account: 'acc-a' })
  assert.equal(trust.trusted, true, 'restart bridge still trusts the bound account (billing row reloaded)')

  fs.writeFileSync(bindingsPath, 'not json at all')
  const recovered = mk()
  assert.equal(recovered.bridge.bindingOf('acc-a'), null, 'corrupt dump: nobody gains trust from a damaged file')
  assert.ok(fs.existsSync(bindingsPath + '.bad'), 'corrupt bindings quarantined')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('main() boot hygiene: tls args must pair; hosted mode persists into the billing dir', async () => {
  await assert.rejects(
    () => main(['--port', '0', '--host', '127.0.0.1', '--tls-cert', 'x.pem']),
    /--tls-cert and --tls-key must be given together/,
    'half a TLS pair is a coded boot error, not a silent plain-HTTP boot',
  )
  // hosted smoke: main() builds the gate with durable files; the relay answers
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hosted-main-'))
  let server
  try {
    server = await main(['--port', '0', '--host', '127.0.0.1', '--data', path.join(dir, 'relay'), '--hosted', path.join(dir, 'billing'), '--enrollment', 'enr-secret'])
    const url = `http://127.0.0.1:${server.address().port}`
    const noEnr = await register(url, 'someone', 'dev1')
    assert.equal(noEnr.status, 403, 'hosted boot keeps the enrollment door shut')
    assert.match(noEnr.out.error, /enrollment secret required/)
    const res = await fetch(url + '/v1/device/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close', 'x-enrollment': 'enr-secret' },
      body: JSON.stringify({ account: 'someone', device: 'dev1' }),
    })
    // enrollment PASSES but the hosted gate still fails the register CLOSED:
    // nobody is trusted until an operator binds the relay account to a billing
    // account (provisioning is operator-side, never client-side).
    assert.equal(res.status, 403, 'enrolled but unbound: register fails closed')
    assert.match((await res.json()).error, /no-server-identity/)
    assert.ok(fs.existsSync(path.join(dir, 'billing', 'relay-bindings.json')) === false, 'no binding file until an operator actually binds')
    assert.ok(fs.statSync(path.join(dir, 'billing')).isDirectory(), 'billing store rooted in the --hosted dir')
  } finally { await shutdown(server) }
  fs.rmSync(dir, { recursive: true, force: true })
})
