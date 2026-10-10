/**
 * PickDone billing — webhook processing (the ONLY door money events enter).
 *
 * Transaction boundary, strictly in this order and SYNCHRONOUSLY (single
 * threaded node + no await between check-and-effect = atomic under concurrent
 * duplicate deliveries):
 *
 *   1. provider.verify(rawBody, headers)      — auth: HMAC + freshness skew
 *   2. provider.normalize(rawBody)            — shape + event-type whitelist
 *   3. money sanity                            — amountMinor>0, currency ^[A-Z]{3}$
 *   4. order lookup + amount/currency EXACT match vs server-side order
 *   5. event-id dedup (provider,eventId)       — replayed delivery = no-op 200
 *   6. record event (unique insert) → state machine → ledger append →
 *      subscription activation/freeze
 *
 * Out-of-order deliveries (e.g. refund.succeeded before charge.succeeded) are
 * RECORDED as deferred, never dropped; when the order later reaches `paid`,
 * deferred events replay in arrival order so the account converges to the
 * provider's final state.
 */

import { applyEventToOrder, isTerminal } from './orders.mjs'
import { periodEndAfterCharge } from './entitlements.mjs'

const CURRENCY_RE = /^[A-Z]{3}$/

/** Apply a `paid` transition's side effects: ledger charge + subscription. */
function settlePaid ({ store, order, event, ledger }) {
  ledger.append({
    type: 'charge',
    accountId: order.accountId,
    orderId: order.orderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    provider: order.provider,
    providerRef: event.providerRef,
    eventId: event.id,
  })
  const prev = store.getSubscription(order.accountId)
  const startedAt = prev ? prev.startedAt : store.now()
  const currentPeriodEnd = periodEndAfterCharge({
    now: store.now(), cycle: order.cycle, previous: prev ? prev.currentPeriodEnd : null,
  })
  store.setSubscription(order.accountId, {
    accountId: order.accountId,
    planId: order.planId,
    cycle: order.cycle,
    status: 'active',
    startedAt,
    currentPeriodEnd,
    orderId: order.orderId,
    frozenReason: null,
  })
}

/** Apply a revoke transition's side effects: ledger entry + freeze NOW. */
function revokeSubscription ({ store, order, event, ledger, type }) {
  ledger.append({
    type,
    accountId: order.accountId,
    orderId: order.orderId,
    amountMinor: order.amountMinor,
    currency: order.currency,
    provider: order.provider,
    providerRef: event.providerRef,
    eventId: event.id,
  })
  const sub = store.getSubscription(order.accountId)
  if (sub) {
    store.setSubscription(order.accountId, {
      ...sub, status: 'frozen', frozenReason: type, currentPeriodEnd: sub.currentPeriodEnd,
    })
  }
}

/** Second pass: replay deferred events once an order hits `paid`.
 *  Returns the LAST applied result so callers can report convergence. */
function replayDeferred ({ store, order, ledger, provider }) {
  let last = null
  for (const ev of store.deferredEvents(order.orderId)) {
    if (ev.applied) continue
    const r = applyEvent({ store, order: store.getOrder(order.orderId), event: ev, ledger, provider, replay: true })
    store.patchEvent(provider.name, ev.id, { applied: r.applied, deferred: !r.applied, applyReason: r.reason || null })
    last = r
    if (!r.applied) break // still blocked — stop replaying (order unchanged)
  }
  return last
}

function applyEvent ({ store, order, event, ledger, provider }) {
  const r = applyEventToOrder({ store, order, event })
  if (!r.applied) return r
  if (r.status === 'paid') {
    settlePaid({ store, order: store.getOrder(order.orderId), event, ledger })
  } else if (r.status === 'refunded') {
    revokeSubscription({ store, order: store.getOrder(order.orderId), event, ledger, type: 'refund' })
  } else if (r.status === 'chargeback') {
    revokeSubscription({ store, order: store.getOrder(order.orderId), event, ledger, type: 'chargeback' })
  }
  return r
}

/**
 * Process one raw webhook delivery. NEVER throws for business-level outcomes —
 * returns { httpStatus, body } so the transport stays thin and testable.
 */
export function processWebhook ({ store, provider, ledger, rawBody, headers, now = Date.now }) {
  // 0. fail closed: while the store is unhealthy (isolated damaged ledger or
  //    state), NOTHING may be recorded and NO money state may move — the
  //    provider redelivers after operator recovery. Nothing was recorded, so
  //    dedup will not swallow that future redelivery.
  if (typeof store.isWritable === 'function' && !store.isWritable()) {
    const h = typeof store.getLedgerHealth === 'function' ? store.getLedgerHealth() : {}
    return { httpStatus: 503, body: { error: 'billing-ledger-unhealthy', reason: h.reason || 'unhealthy' } }
  }
  // 1. auth — unsigned / wrong-signed / stale: hard reject, nothing recorded
  if (!provider.verify(rawBody, headers, { now })) {
    return { httpStatus: 401, body: { error: 'invalid-signature' } }
  }
  // 2. shape
  const event = provider.normalize(rawBody, headers)
  if (!event) {
    return { httpStatus: 400, body: { error: 'malformed-event' } }
  }
  // 3. money sanity — zero/negative amounts are always an attack or a bug
  if (!Number.isSafeInteger(event.amountMinor) || event.amountMinor <= 0) {
    return { httpStatus: 400, body: { error: 'invalid-amount' } }
  }
  if (typeof event.currency !== 'string' || !CURRENCY_RE.test(event.currency)) {
    return { httpStatus: 400, body: { error: 'invalid-currency' } }
  }
  // 4. the order must exist server-side and money must match EXACTLY
  const order = store.getOrder(event.orderId)
  if (!order) {
    return { httpStatus: 400, body: { error: 'unknown-order' } }
  }
  if (event.amountMinor !== order.amountMinor || event.currency !== order.currency) {
    const rec = store.recordEvent({
      provider: provider.name, eventId: event.id, type: event.type,
      orderId: order.orderId, amountMinor: event.amountMinor, currency: event.currency,
      providerRef: event.providerRef, applied: false, deferred: false,
      rejectReason: 'amount-currency-mismatch',
    })
    return { httpStatus: 400, body: { error: 'amount-currency-mismatch', recorded: rec.duplicate ? 'duplicate' : 'recorded' } }
  }
  // 5. replay/idempotency gate — BEFORE any effect
  const seen = store.findEvent(provider.name, event.id)
  if (seen) {
    return { httpStatus: 200, body: { received: true, duplicate: true, applied: !!seen.applied } }
  }
  // 6. unique-record then effect — one synchronous critical section
  const rec = store.recordEvent({
    provider: provider.name, eventId: event.id, type: event.type,
    orderId: order.orderId, amountMinor: event.amountMinor, currency: event.currency,
    providerRef: event.providerRef, applied: false, deferred: false, rejectReason: null,
  })
  if (rec.duplicate) {
    // lost a dedup race (cannot happen single-threaded, guarded anyway)
    return { httpStatus: 200, body: { received: true, duplicate: true, applied: !!rec.event.applied } }
  }
  const freshOrder = store.getOrder(order.orderId)
  if (isTerminal(freshOrder.status)) {
    store.patchEvent(provider.name, event.id, { applied: false, rejectReason: `order-terminal-${freshOrder.status}` })
    return { httpStatus: 200, body: { received: true, applied: false, reason: `order-terminal-${freshOrder.status}` } }
  }
  const r = applyEvent({ store, order: freshOrder, event, ledger, provider })
  store.patchEvent(provider.name, event.id, {
    applied: r.applied,
    deferred: !!r.deferred,
    applyReason: r.reason || null,
  })
  if (r.applied && r.status === 'paid') {
    // convergence: deliver any refunds/chargebacks that arrived early
    replayDeferred({ store, order: store.getOrder(order.orderId), ledger, provider })
  }
  const after = store.getOrder(order.orderId)
  return {
    httpStatus: 200,
    body: { received: true, applied: r.applied, orderStatus: after.status, ...(r.deferred ? { deferred: true } : {}), ...(r.reason ? { reason: r.reason } : {}) },
  }
}
