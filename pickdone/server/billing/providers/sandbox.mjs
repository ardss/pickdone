/**
 * PickDone billing — SANDBOX provider (the only concrete implementation here).
 *
 * Simulates a payment provider end-to-end WITHOUT touching real money:
 *   - createPaymentIntent mints a fake checkout URL (sandbox://…, never HTTP);
 *   - settle() produces the signed webhook event a REAL provider would send
 *     when payment succeeds/fails/is refunded — tests and the sandbox CLI POST
 *     it to /v1/webhooks/sandbox over real HTTP.
 *
 * HARD GATE: this module is the ONLY place allowed to fabricate provider
 * events, and its events are only trusted because they arrive signed at the
 * public webhook route. Nothing here may short-circuit into the billing core
 * directly — the HTTP boundary stays mandatory even in tests.
 *
 * Replacing it with a real provider (Stripe/Paddle/…) means implementing the
 * provider contract (providers/provider.mjs) with real merchant credentials
 * from env — gated on actual merchant evidence per the project rules.
 */

import { randomBytes } from 'node:crypto'
import { signPayload, verifySignature, EVENT_TYPES } from './provider.mjs'

export function createSandboxProvider ({ webhookSecret, now = Date.now } = {}) {
  if (!webhookSecret || typeof webhookSecret !== 'string' || webhookSecret.length < 16) {
    throw new Error('sandbox provider: webhookSecret (>=16 chars) required')
  }
  const issued = new Map() // orderId -> providerRef (checkout session id)
  return {
    name: 'sandbox',
    issued,
    createPaymentIntent (order) {
      const providerRef = `sbx_cs_${order.orderId.slice(4)}_${randomBytes(6).toString('hex')}`
      issued.set(order.orderId, providerRef)
      return {
        providerRef,
        // NOT an http(s) URL on purpose: nothing real is reachable there.
        paymentUrl: `sandbox://checkout/${order.orderId}?session=${providerRef}`,
      }
    },
    verify: (rawBody, headers, opts = {}) =>
      verifySignature(webhookSecret, rawBody, headers, { now, ...opts }),
    normalize (rawBody, headers) {
      let parsed
      try { parsed = JSON.parse(rawBody) } catch { return null }
      if (!parsed || typeof parsed !== 'object') return null
      const { id, type, orderId, amountMinor, currency, providerRef, occurredAt } = parsed
      if (typeof id !== 'string' || !id) return null
      if (!EVENT_TYPES.has(type)) return null
      if (typeof orderId !== 'string' || !orderId) return null
      return { id, type, orderId, amountMinor, currency, providerRef: providerRef || null, occurredAt: occurredAt || null }
    },
    /** Simulate the provider's callback. Returns { body, headers } ready for
     *  fetch POST /v1/webhooks/sandbox. outcome: 'paid'|'failed' for charge
     *  events; refund/chargeback events via type override. amountMinor /
     *  currency overrides exist ONLY to let security tests forge mismatches. */
    emitEvent ({ orderId, type, amountMinor, currency, providerRef, eventId = `evt_${randomBytes(8).toString('hex')}`, ts = Math.floor(now() / 1000) }) {
      const body = JSON.stringify({
        id: eventId, type, orderId,
        amountMinor: amountMinor ?? null, currency: currency ?? null,
        providerRef: providerRef ?? issued.get(orderId) ?? null,
        occurredAt: ts * 1000,
      })
      return {
        body,
        headers: {
          'content-type': 'application/json',
          'x-pd-timestamp': String(ts),
          'x-pd-signature': signPayload(webhookSecret, ts, body),
        },
        eventId,
      }
    },
  }
}
