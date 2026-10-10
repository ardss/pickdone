import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// FAIL-CLOSED ledger isolation (billing-hardening).
//
// A tampered / corrupted / torn (power-loss partial write) ledger.jsonl must
// put the billing store and service into an explicit READ-ONLY unhealthy
// state that:
//   - refuses to grant entitlements,
//   - refuses to accept new (paid) webhooks,
//   - refuses to silently rebuild an empty ledger,
//   - never renames/deletes the evidence file automatically.
// Recovery is an EXPLICIT operator action, archives every original byte, and
// is only ever offered for a torn tail (provably never-acked append), never
// for tampering. All time is INJECTED.

const { createBillingStore } = await import('../../../server/billing/store.mjs')
const { createSandboxProvider } = await import('../../../server/billing/providers/sandbox.mjs')
const { createOrder } = await import('../../../server/billing/orders.mjs')
const { processWebhook } = await import('../../../server/billing/webhook.mjs')
const { createBillingService, startBillingServer } = await import('../../../server/billing/service.mjs')

const T0 = 1_700_000_000_000

function mkDir (t) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-billing-fc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Seed a healthy file-mode dir: account + order + (optional) settled charge
 *  (+ refund). Returns ids, the live provider (same HMAC secret), and the raw
 *  ledger bytes as left on disk. */
function seedDir (t, { refund = false } = {}) {
  const dir = mkDir(t)
  const s = createBillingStore({ dataDir: dir, now: () => T0 })
  const provider = createSandboxProvider({ webhookSecret: 'whsec-fc-0123456789abcdef', now: () => T0 })
  const { accountId, apiKey } = s.createAccount()
  const order = createOrder({ store: s, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  const settle = (type) => {
    const e = provider.emitEvent({ orderId: order.orderId, type, amountMinor: order.amountMinor, currency: order.currency })
    const r = processWebhook({ store: s, provider, ledger: s.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
    assert.equal(r.httpStatus, 200)
  }
  settle('charge.succeeded')
  if (refund) settle('refund.succeeded')
  s.close()
  return {
    dir, provider, accountId, apiKey, orderId: order.orderId,
    ledgerPath: join(dir, 'ledger.jsonl'),
    statePath: join(dir, 'billing-state.json'),
    raw: readFileSync(join(dir, 'ledger.jsonl'), 'utf8'),
  }
}

const tamperedRaw = (raw, lineIdx, from, to) => {
  const lines = raw.split('\n')
  lines[lineIdx] = lines[lineIdx].replace(from, to)
  return lines.join('\n')
}

test('tamper: broken chain mid-file -> read-only unhealthy boot, file untouched, no silent rebuild', t => {
  const seeded = seedDir(t, { refund: true }) // 2 entries: charge, refund
  const evil = tamperedRaw(seeded.raw, 1, '"amountMinor":499', '"amountMinor":1')
  assert.notEqual(evil, seeded.raw)
  writeFileSync(seeded.ledgerPath, evil)

  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  const h = s.getLedgerHealth()
  assert.equal(h.healthy, false, 'boot must NOT come up writable on tampered money history')
  assert.equal(h.reason, 'ledger-chain-broken')
  assert.equal(h.detail.brokenAt, 2, 'tampered second entry is where the chain breaks')
  assert.equal(s.isWritable(), false)

  // cryptographically-intact PREFIX stays available read-only for manual
  // reconciliation — but nothing more may ever be appended
  assert.equal(s.ledger.all().length, 1)
  assert.equal(s.ledger.all()[0].type, 'charge')
  assert.equal(s.ledger.isReadOnly(), true)
  assert.throws(() => s.ledger.append({ type: 'charge', amountMinor: 499, currency: 'USD' }), /READ-ONLY/)

  // the evidence file must be untouched: no .bad rename, no fresh ledger
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil)
  assert.equal(existsSync(seeded.ledgerPath + '.bad'), false, 'no silent quarantine rename')

  // recovery refuses to auto-"fix" tampering
  const rec = s.recoverLedger()
  assert.equal(rec.recovered, false)
  assert.equal(rec.reason, 'manual-reconciliation-required')
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil, 'still untouched after refused recovery')
  s.close()
})

test('tamper: refused webhook never records events nor rewrites state/ledger; replay settles after out-of-band fix', t => {
  const seeded = seedDir(t) // order paid, NOT terminal — a chargeback can still land
  const evil = tamperedRaw(seeded.raw, 0, '"amountMinor":499', '"amountMinor":1')
  writeFileSync(seeded.ledgerPath, evil)
  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  const stateBefore = readFileSync(seeded.statePath, 'utf8')
  const eventsBefore = s.listEvents().length

  // a freshly-signed chargeback must be REFUSED (503), not recorded, not
  // applied — the provider will retry after operator recovery
  const e = seeded.provider.emitEvent({
    orderId: seeded.orderId, type: 'chargeback.created',
    amountMinor: 499, currency: 'USD',
  })
  const r = processWebhook({ store: s, provider: seeded.provider, ledger: s.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
  assert.equal(r.httpStatus, 503)
  assert.equal(r.body.error, 'billing-ledger-unhealthy')
  assert.equal(s.listEvents().length, eventsBefore, 'no event recorded while unhealthy')
  assert.equal(readFileSync(seeded.statePath, 'utf8'), stateBefore, 'state snapshot untouched')
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil, 'ledger untouched')
  s.close()

  // operator fixes the file OUT OF BAND (restore good bytes) → restart →
  // the SAME event replays cleanly: refusal polluted neither the dedup table
  // nor the ledger, so the provider's retry settles normally
  writeFileSync(seeded.ledgerPath, seeded.raw)
  const s2 = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  assert.equal(s2.isWritable(), true)
  const r2 = processWebhook({ store: s2, provider: seeded.provider, ledger: s2.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
  assert.equal(r2.httpStatus, 200)
  assert.equal(r2.body.applied, true)
  assert.equal(r2.body.orderStatus, 'chargeback')
  assert.equal(s2.ledger.all().length, 2, 'charge + chargeback booked in one chain')
  assert.equal(s2.ledger.verify().ok, true)
  s2.close()
})

test('corrupt: unparseable line mid-file -> read-only unhealthy (ledger-corrupt-line), file untouched', t => {
  const seeded = seedDir(t) // 1 entry
  const lines = seeded.raw.split('\n')
  lines.splice(1, 0, '{"seq":2,"ts":not-json') // terminated garbage line
  const evil = lines.join('\n')
  writeFileSync(seeded.ledgerPath, evil)

  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  const h = s.getLedgerHealth()
  assert.equal(h.healthy, false)
  assert.equal(h.reason, 'ledger-corrupt-line')
  assert.equal(h.detail.line, 2)
  assert.equal(s.isWritable(), false)
  assert.equal(s.ledger.all().length, 1, 'good prefix loaded read-only')
  assert.equal(s.ledger.isReadOnly(), true)
  assert.throws(() => s.ledger.append({ type: 'charge', amountMinor: 100, currency: 'USD' }), /READ-ONLY/)
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil, 'no rewrite, no rename, no rebuild')
  assert.equal(existsSync(seeded.ledgerPath + '.bad'), false)
  s.close()
})

test('torn tail (power-loss partial write) -> unhealthy until EXPLICIT recovery; recovery archives + truncates, never deletes', t => {
  const seeded = seedDir(t) // 1 good entry, file ends with '\n'
  const torn = seeded.raw + '{"seq":2,"ts":1700000' // crashed mid-append
  writeFileSync(seeded.ledgerPath, torn)

  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  const h = s.getLedgerHealth()
  assert.equal(h.healthy, false)
  assert.equal(h.reason, 'ledger-torn-tail')
  assert.equal(s.isWritable(), false)
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), torn, 'boot must not auto-truncate the torn line')

  // explicit operator recovery: archive every original byte, rewrite prefix
  const rec = s.recoverLedger()
  assert.equal(rec.recovered, true)
  assert.equal(rec.archivedTo.startsWith(seeded.ledgerPath + '.torn-'), true)
  assert.equal(readFileSync(rec.archivedTo, 'utf8'), torn, 'archive keeps EVERY original byte')
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), seeded.raw, 'file rewritten to the verified prefix')
  assert.equal(s.getLedgerHealth().healthy, true)
  assert.equal(s.isWritable(), true)
  assert.equal(s.ledger.all().length, 1)
  assert.equal(s.ledger.verify().ok, true)

  // service continues normally: a NEW charge settles and is booked seq 2
  const provider = seeded.provider
  const acc = s.createAccount()
  const order = createOrder({ store: s, provider, accountId: acc.accountId, planId: 'cloud', cycle: 'monthly' }).order
  const e = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const r = processWebhook({ store: s, provider, ledger: s.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
  assert.equal(r.httpStatus, 200)
  assert.equal(r.body.applied, true)
  assert.equal(s.ledger.all().length, 2)
  assert.equal(s.ledger.all()[1].seq, 2)
  assert.equal(s.ledger.verify().ok, true)
  s.close()

  // restart: healthy, everything persisted
  const s2 = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  assert.equal(s2.getLedgerHealth().healthy, true)
  assert.equal(s2.ledger.all().length, 2)
  assert.equal(s2.getSubscription(acc.accountId).status, 'active')
  s2.close()
})

test('torn tail: unterminated but parseable last line re-joins ONLY if it chain-extends; recovery archives first', t => {
  const seeded = seedDir(t)
  const noFinalNewline = seeded.raw.slice(0, -1) // fsync'd lines always end '\n'
  writeFileSync(seeded.ledgerPath, noFinalNewline)

  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  assert.equal(s.getLedgerHealth().reason, 'ledger-torn-tail')
  assert.equal(s.isWritable(), false)
  const rec = s.recoverLedger()
  assert.equal(rec.recovered, true)
  assert.equal(readFileSync(rec.archivedTo, 'utf8'), noFinalNewline)
  // the entry chain-extends the (empty) prefix → kept, terminator restored
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), seeded.raw)
  assert.equal(s.isWritable(), true)
  assert.equal(s.ledger.all().length, 1)
  assert.equal(s.ledger.verify().ok, true)
  s.close()
})

test('state file corrupt -> read-only unhealthy (state-corrupt); ledger evidence untouched', t => {
  const seeded = seedDir(t)
  writeFileSync(seeded.statePath, '{"accounts": [oops')
  const s = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  const h = s.getLedgerHealth()
  assert.equal(h.healthy, false)
  assert.equal(h.reason, 'state-corrupt')
  assert.equal(s.isWritable(), false)
  assert.equal(s.ledger.all().length, 1)
  assert.throws(() => s.createAccount(), /READ-ONLY/)
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), seeded.raw, 'ledger not quarantined/rebuilt')
  assert.equal(existsSync(seeded.statePath + '.bad'), false)
  s.close()
})

test('healthy boots stay writable: fresh sandbox (no files) and historical ledger restart', t => {
  const dir = mkDir(t)
  const s0 = createBillingStore({ dataDir: dir, now: () => T0 })
  assert.equal(s0.getLedgerHealth().healthy, true, 'fresh sandbox without any ledger boots healthy')
  assert.equal(s0.isWritable(), true)
  const provider = createSandboxProvider({ webhookSecret: 'whsec-fc2-0123456789abcde', now: () => T0 })
  const { accountId } = s0.createAccount()
  const order = createOrder({ store: s0, provider, accountId, planId: 'cloud', cycle: 'monthly' }).order
  const e = provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  processWebhook({ store: s0, provider, ledger: s0.ledger, rawBody: e.body, headers: e.headers, now: () => T0 })
  assert.equal(existsSync(join(dir, 'ledger.jsonl')), true, 'first append creates the ledger')
  s0.close()

  const s1 = createBillingStore({ dataDir: dir, now: () => T0 })
  assert.equal(s1.getLedgerHealth().healthy, true)
  assert.equal(s1.isWritable(), true)
  assert.equal(s1.ledger.all().length, 1)
  assert.equal(s1.ledger.verify().ok, true)
  assert.equal(s1.getSubscription(accountId).status, 'active')
  s1.close()
})

// ---------- service-level (real HTTP): the fail-closed doors --------------

async function withService (t, dir, { provider }) {
  const service = createBillingService({
    dataDir: dir, provider, now: () => T0,
    adminToken: 'admin-tok-fc', internalToken: 'internal-tok-fc',
  })
  const server = await startBillingServer(service, { port: 0, host: '127.0.0.1' })
  t.after(() => new Promise(r => server.close(r)))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const get = (path, headers = {}) => fetch(base + path, { headers })
  return { service, post, get }
}

test('service: tampered ledger -> 503 on entitlements/accounts/orders/webhooks/usage/reconcile; admin report + health stay readable; recover refused 409', async t => {
  const seeded = seedDir(t, { refund: true })
  const evil = tamperedRaw(seeded.raw, 1, '"amountMinor":499', '"amountMinor":1')
  writeFileSync(seeded.ledgerPath, evil)

  const { post, get } = await withService(t, seeded.dir, { provider: seeded.provider })

  // refuse to grant entitlements (fail closed beats credential handling)
  const ent = await get('/v1/entitlements', { authorization: `Bearer ${seeded.apiKey}` })
  assert.equal(ent.status, 503)
  assert.equal((await ent.json()).error, 'billing-unhealthy')

  // refuse every mutating door
  assert.equal((await post('/v1/accounts', {})).status, 503)
  const or = await post('/v1/orders', { planId: 'cloud', cycle: 'monthly' }, { authorization: `Bearer ${seeded.apiKey}` })
  assert.equal(or.status, 503)
  const evt = seeded.provider.emitEvent({ orderId: seeded.orderId, type: 'charge.succeeded', amountMinor: 499, currency: 'USD' })
  assert.equal((await post('/v1/webhooks/sandbox', evt.body, evt.headers)).status, 503, 'new paid webhook refused')
  assert.equal((await post('/v1/usage', { accountId: seeded.accountId, bytesUsed: 1 }, { authorization: 'Bearer internal-tok-fc' })).status, 503)
  assert.equal((await post('/v1/reconcile', { statement: [] }, { authorization: 'Bearer admin-tok-fc' })).status, 503)

  // the file is still exactly the tampered bytes — nothing was rebuilt
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil)

  // manual reconciliation entry stays open (read-only) + explicit health
  const rep = await (await get('/v1/reconcile/report', { authorization: 'Bearer admin-tok-fc' })).json()
  assert.equal(rep.ledgerHealth.healthy, false)
  assert.equal(rep.ledgerHealth.reason, 'ledger-chain-broken')
  const hz = await get('/v1/healthz')
  assert.equal(hz.status, 503)
  assert.deepEqual(await hz.json(), { ok: false, reason: 'ledger-chain-broken' })

  // automated "recovery" on tampering: refused with a named conflict
  const rec = await post('/v1/reconcile/ledger/recover', { confirm: true }, { authorization: 'Bearer admin-tok-fc' })
  assert.equal(rec.status, 409)
  assert.equal((await rec.json()).error, 'manual-reconciliation-required')
  assert.equal(readFileSync(seeded.ledgerPath, 'utf8'), evil, 'still untouched after refused recovery')
})

test('service: torn tail -> admin recover endpoint re-opens the service; paid webhook + entitlements work again; restart keeps state', async t => {
  const seeded = seedDir(t)
  const torn = seeded.raw + '{"seq":2,"ts":17000'
  writeFileSync(seeded.ledgerPath, torn)

  const svc1 = await withService(t, seeded.dir, { provider: seeded.provider })
  const hz1 = await svc1.get('/v1/healthz')
  assert.equal(hz1.status, 503)
  assert.equal((await hz1.json()).reason, 'ledger-torn-tail')

  // recover requires explicit confirmation
  const noConfirm = await svc1.post('/v1/reconcile/ledger/recover', {}, { authorization: 'Bearer admin-tok-fc' })
  assert.equal(noConfirm.status, 400)
  const rec = await svc1.post('/v1/reconcile/ledger/recover', { confirm: true }, { authorization: 'Bearer admin-tok-fc' })
  assert.equal(rec.status, 200)
  const recBody = await rec.json()
  assert.equal(recBody.recovered, true)
  assert.equal(readFileSync(recBody.archivedTo, 'utf8'), torn, 'original bytes archived, never deleted')

  const hz2 = await svc1.get('/v1/healthz')
  assert.equal(hz2.status, 200)
  assert.deepEqual(await hz2.json(), { ok: true, reason: null })

  // full paid flow works again
  const ar = await svc1.post('/v1/accounts', {})
  assert.equal(ar.status, 201)
  const { accountId, apiKey } = await ar.json()
  const auth = { authorization: `Bearer ${apiKey}` }
  const or = await svc1.post('/v1/orders', { planId: 'cloud', cycle: 'monthly' }, auth)
  assert.equal(or.status, 201)
  const order = await or.json()
  const evt = seeded.provider.emitEvent({ orderId: order.orderId, type: 'charge.succeeded', amountMinor: order.amountMinor, currency: order.currency })
  const wr = await svc1.post('/v1/webhooks/sandbox', evt.body, evt.headers)
  assert.equal((await wr.json()).applied, true)
  const ent = await (await svc1.get('/v1/entitlements', auth)).json()
  assert.equal(ent.tier, 'cloud')
  assert.equal(ent.syncAllowed.allowed, true)

  // restart: healthy, chain intact, entitlements persist
  const s2 = createBillingStore({ dataDir: seeded.dir, now: () => T0 })
  assert.equal(s2.getLedgerHealth().healthy, true)
  assert.equal(s2.ledger.all().length, 2)
  assert.equal(s2.ledger.verify().ok, true)
  assert.equal(s2.getSubscription(accountId).status, 'active')
  s2.close()
})
