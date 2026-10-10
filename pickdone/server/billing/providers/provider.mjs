/**
 * PickDone billing — payment provider contract (provider-agnostic boundary).
 *
 * The billing core (orders/webhook/entitlements/ledger) NEVER imports a
 * concrete provider. It talks to this surface:
 *
 *   provider = {
 *     name: 'sandbox',
 *     createPaymentIntent (order) -> { providerRef, paymentUrl }
 *       — "give me something the customer can pay at"; SANDBOX ONLY mints a
 *         fake URL. A real provider adapter would call its hosted-checkout API
 *         and MUST record its own idempotency key = order.orderId.
 *     verify (rawBody, headers) -> boolean
 *       — authenticate the inbound webhook. Real adapters implement their
 *         vendor scheme (Stripe sig header, PayPal cert-chain, ...). Sandbox
 *         uses the PickDone default HMAC contract below.
 *     normalize (rawBody, headers) -> event | null
 *       — map the vendor payload to the PickDone canonical event:
 *         { id, type, orderId, amountMinor, currency, providerRef, occurredAt }
 *         type ∈ charge.succeeded | charge.failed | refund.succeeded |
 *                chargeback.created
 *   }
 *
 * Default webhook auth contract (used by the sandbox provider; real adapters
 * may swap the scheme but MUST provide the same guarantees):
 *   header x-pd-timestamp  : unix seconds
 *   header x-pd-signature  : "v1=" + hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
 *   - constant-time compare, ±skewMs freshness window (replay guard),
 *     plus server-side event-id dedup (second line of replay defense).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const EVENT_TYPES = new Set([
  'charge.succeeded', 'charge.failed', 'refund.succeeded', 'chargeback.created',
])

export function signPayload (secret, timestampSeconds, rawBody) {
  return 'v1=' + createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')
}

export function verifySignature (secret, rawBody, headers, { skewMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const ts = Number(headers['x-pd-timestamp'])
  const sig = String(headers['x-pd-signature'] || '')
  if (!Number.isFinite(ts)) return false
  const expected = signPayload(secret, ts, rawBody)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length) return false
  if (!timingSafeEqual(a, b)) return false
  return Math.abs(now() - ts * 1000) <= skewMs
}
