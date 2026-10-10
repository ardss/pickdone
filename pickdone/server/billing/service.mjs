/**
 * PickDone billing — thin HTTP service (sandbox vertical slice).
 *
 * Standalone, provider-agnostic billing service: plain node:http + JSON, same
 * style as the sync relay. It does NOT know about any payment vendor; it holds
 * ONE configured provider (default: sandbox).
 *
 * Routes:
 *   POST /v1/accounts                     (open; mock identity — mints key)
 *   GET  /v1/entitlements                 (Bearer account key)
 *   POST /v1/orders                       (Bearer account key)
 *   GET  /v1/orders/:id                   (Bearer account key)
 *   POST /v1/webhooks/:provider           (provider signature; raw body)
 *   POST /v1/usage                        (Bearer INTERNAL token — trusted reporter)
 *   GET  /v1/reconcile/report             (Bearer ADMIN token)
 *   POST /v1/reconcile                    (Bearer ADMIN token + statement body)
 *
 * SECURITY MODEL:
 *   - entitlements are granted ONLY via the signed webhook path → order=paid.
 *     No route accepts a client-declared "I paid" — the account key alone
 *     cannot buy anything.
 *   - API keys are shown once at account creation (hashed at rest).
 *   - admin/internal tokens come from env at boot; never persisted, never
 *     hardcoded. Sandbox tokens are random per boot when env is absent.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createBillingStore } from './store.mjs'
import { createSandboxProvider } from './providers/sandbox.mjs'
import { createOrder, sweepExpiredOrders } from './orders.mjs'
import { processWebhook } from './webhook.mjs'
import { computeEntitlements, checkSyncAllowed, GRACE_MS } from './entitlements.mjs'
import { reconcileReport } from './reconcile.mjs'
import { PLANS } from './plans.mjs'

export function createBillingService (config = {}) {
  const now = config.now || Date.now
  const store = config.store || createBillingStore({ dataDir: config.dataDir, now })
  const ledger = store.ledger
  const provider = config.provider || createSandboxProvider({
    webhookSecret: config.webhookSecret || randomBytes(24).toString('hex'), now,
  })
  const adminToken = config.adminToken || randomBytes(24).toString('hex')
  const internalToken = config.internalToken || randomBytes(24).toString('hex')
  const graceMs = config.graceMs ?? GRACE_MS
  const maxPendingAgeMs = config.maxPendingAgeMs ?? 24 * 60 * 60 * 1000

  const bearer = req => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')
    return m ? m[1].trim() : null
  }
  const guard = (req, expected) => {
    const got = bearer(req)
    if (!got || typeof expected !== 'string') return false
    const a = Buffer.from(got)
    const b = Buffer.from(expected)
    return a.length === b.length && a.equals(b) // same-length compare; tokens are random
  }

  // Fail-closed gate (billing-hardening): an unhealthy store (isolated
  // damaged ledger/state) answers 503 on every door that grants entitlements
  // or mutates state — BEFORE credential checks, so a degraded service never
  // trades on money history it cannot vouch for. Read-only admin/report +
  // /v1/healthz stay available for manual reconciliation.
  const health = () => (typeof store.getLedgerHealth === 'function'
    ? store.getLedgerHealth()
    : { healthy: true, reason: null, detail: null })
  const writable = () => (typeof store.isWritable === 'function' ? store.isWritable() : true)
  const unhealthy = res => json(res, 503, { error: 'billing-unhealthy', reason: health().reason || 'unhealthy' })

  // Drain-then-judge: an oversize body is fully consumed (discarded) so the
  // socket stays healthy, and the caller gets a clean 413 JSON response —
  // destroying the socket mid-upload turns the error into a transport failure
  // instead of a named HTTP status.
  const MAX_BODY = 1 << 20
  const readRaw = req => new Promise((resolve, reject) => {
    let size = 0
    let oversized = false
    const chunks = []
    req.on('data', c => {
      if (oversized) return
      size += c.length
      if (size > MAX_BODY) { oversized = true; chunks.length = 0; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (oversized) reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })

  const json = (res, status, body) => {
    const buf = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length })
    res.end(buf)
  }

  async function handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      // ---- liveness/explicit health (orchestrators stop routing on 503) ---
      if (path === '/v1/healthz' && req.method === 'GET') {
        const h = health()
        return json(res, h.healthy ? 200 : 503, { ok: h.healthy, reason: h.reason ?? null })
      }

      // ---- open: mock identity -------------------------------------------
      if (req.method === 'POST' && path === '/v1/accounts') {
        if (!writable()) return unhealthy(res)
        const { accountId, apiKey } = store.createAccount()
        return json(res, 201, { accountId, apiKey, note: 'sandbox mock identity — shown once' })
      }

      // ---- provider webhook (raw-body signature) --------------------------
      if (req.method === 'POST' && path.startsWith('/v1/webhooks/')) {
        const name = path.slice('/v1/webhooks/'.length)
        if (name !== provider.name) return json(res, 404, { error: 'unknown-provider' })
        const rawBody = await readRaw(req) // drain first: keep the socket healthy
        if (!writable()) return unhealthy(res)
        const out = processWebhook({ store, provider, ledger, rawBody, headers: req.headers, now })
        return json(res, out.httpStatus, out.body)
      }

      // ---- account-key authed --------------------------------------------
      if (path === '/v1/entitlements' && req.method === 'GET') {
        // refuse to grant entitlements on untrusted money history — before
        // auth, fail-closed beats credential handling
        if (!writable()) return unhealthy(res)
        const account = store.accountByApiKey(bearer(req))
        if (!account) return json(res, 401, { error: 'unauthorized' })
        const ent = computeEntitlements({ store, accountId: account.accountId, now: () => now(), graceMs })
        return json(res, 200, { ...ent, syncAllowed: checkSyncAllowed(ent) })
      }

      if (path === '/v1/orders' && req.method === 'POST') {
        if (!writable()) return unhealthy(res)
        const account = store.accountByApiKey(bearer(req))
        if (!account) return json(res, 401, { error: 'unauthorized' })
        let body
        try { body = JSON.parse(await readRaw(req)) } catch { return json(res, 400, { error: 'malformed-json' }) }
        const r = createOrder({
          store, provider,
          accountId: account.accountId, // server-side account from KEY, never from body
          planId: body.planId, cycle: body.cycle,
        })
        if (r.error) return json(res, r.error === 'unknown-account' ? 401 : 400, { error: r.error })
        const intent = provider.createPaymentIntent(r.order)
        store.patchOrder(r.order.orderId, { providerRef: intent.providerRef })
        return json(res, 201, {
          orderId: r.order.orderId, status: r.order.status,
          amountMinor: r.order.amountMinor, currency: r.order.currency,
          planId: r.order.planId, cycle: r.order.cycle,
          payment: { provider: provider.name, paymentUrl: intent.paymentUrl, providerRef: intent.providerRef },
          note: 'SANDBOX — paymentUrl is simulated; no real charge exists',
        })
      }

      const orderMatch = /^\/v1\/orders\/([\w-]+)$/.exec(path)
      if (orderMatch && req.method === 'GET') {
        const account = store.accountByApiKey(bearer(req))
        if (!account) return json(res, 401, { error: 'unauthorized' })
        const order = store.getOrder(orderMatch[1])
        if (!order || order.accountId !== account.accountId) return json(res, 404, { error: 'not-found' })
        return json(res, 200, { order })
      }

      // ---- internal trusted reporter --------------------------------------
      if (path === '/v1/usage' && req.method === 'POST') {
        if (!writable()) return unhealthy(res)
        if (!guard(req, internalToken)) return json(res, 401, { error: 'unauthorized' })
        let body
        try { body = JSON.parse(await readRaw(req)) } catch { return json(res, 400, { error: 'malformed-json' }) }
        const { accountId, bytesUsed } = body || {}
        if (!store.getAccount(accountId)) return json(res, 404, { error: 'unknown-account' })
        if (!Number.isSafeInteger(bytesUsed) || bytesUsed < 0) return json(res, 400, { error: 'invalid-bytes-used' })
        store.setUsage(accountId, bytesUsed)
        const ent = computeEntitlements({ store, accountId, now: () => now(), graceMs })
        return json(res, 200, { accountId, bytesUsed, storageQuotaBytes: ent.storageQuotaBytes, overQuota: ent.overQuota })
      }

      // ---- admin -----------------------------------------------------------
      if (path === '/v1/reconcile/report' && req.method === 'GET') {
        if (!guard(req, adminToken)) return json(res, 401, { error: 'unauthorized' })
        // read-only manual-reconciliation entry: available while unhealthy,
        // but the sweep is a mutation — only when writable
        if (writable()) sweepExpiredOrders(store, { maxPendingAgeMs })
        return json(res, 200, reconcileReport({ store, now: () => now(), maxPendingAgeMs }))
      }
      if (path === '/v1/reconcile' && req.method === 'POST') {
        if (!writable()) return unhealthy(res)
        if (!guard(req, adminToken)) return json(res, 401, { error: 'unauthorized' })
        let body
        try { body = JSON.parse(await readRaw(req)) } catch { return json(res, 400, { error: 'malformed-json' }) }
        const statement = Array.isArray(body && body.statement) ? body.statement : null
        if (!statement) return json(res, 400, { error: 'statement-array-required' })
        sweepExpiredOrders(store, { maxPendingAgeMs })
        return json(res, 200, reconcileReport({ store, now: () => now(), statement, maxPendingAgeMs }))
      }
      // explicit operator recovery — the only write path while unhealthy;
      // offered ONLY for a torn tail (never for tampering)
      if (path === '/v1/reconcile/ledger/recover' && req.method === 'POST') {
        if (!guard(req, adminToken)) return json(res, 401, { error: 'unauthorized' })
        if (!writable()) {
          let body
          try { body = JSON.parse(await readRaw(req)) } catch { return json(res, 400, { error: 'malformed-json' }) }
          if (!body || body.confirm !== true) return json(res, 400, { error: 'confirm-required', hint: 'POST {confirm:true} — archives every original byte before rewriting' })
          const r = store.recoverLedger()
          if (r.recovered) return json(res, 200, r)
          if (r.reason === 'manual-reconciliation-required') {
            return json(res, 409, { error: 'manual-reconciliation-required', detail: r.detail || null })
          }
          return json(res, 409, { error: r.reason, detail: r.detail || null })
        }
        return json(res, 409, { error: 'already-healthy' })
      }

      if (path === '/v1/plans' && req.method === 'GET') return json(res, 200, { plans: PLANS })
      return json(res, 404, { error: 'not-found' })
    } catch (e) {
      return json(res, e.statusCode || 500, { error: e.statusCode === 413 ? 'payload-too-large' : 'internal-error' })
    }
  }

  return { handle, store, ledger, provider, health, config: { adminToken, internalToken, graceMs, maxPendingAgeMs } }
}

export async function startBillingServer (service, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer((req, res) => { service.handle(req, res) })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server
}
