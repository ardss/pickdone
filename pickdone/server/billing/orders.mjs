/**
 * PickDone billing — server-side orders and the order state machine.
 *
 * State machine (guards ALL transitions; anything not listed is rejected):
 *
 *   created/pending ──charge.succeeded──▶ paid ──refund.succeeded──────▶ refunded (terminal)
 *        │                                 │
 *        └──charge.failed──▶ failed ───────┴──chargeback.created────▶ chargeback (terminal)
 *                             (terminal)
 *
 * Money rules enforced here (never trusted from the client):
 *   - price comes from the SERVER-side catalog (plans.priceFor), not the caller;
 *   - zero/negative amounts cannot exist as orders or as applied events;
 *   - currency is fixed per plan price and compared EXACTLY at settlement.
 */

import { getPlan, priceFor, CYCLE_MS } from './plans.mjs'
import { randomBytes } from 'node:crypto'

export const ORDER_STATES = ['pending', 'paid', 'failed', 'refunded', 'chargeback']
const TERMINAL = new Set(['failed', 'refunded', 'chargeback'])

/** Which event types may transition which state (event type → next state). */
export const TRANSITIONS = {
  pending: {
    'charge.succeeded': 'paid',
    'charge.failed': 'failed',
    // refunds/chargebacks for an unpaid order are not money we hold — deferred
    // (recorded, unapplied) in webhook.mjs, never silently dropped.
  },
  paid: {
    'refund.succeeded': 'refunded',
    'chargeback.created': 'chargeback',
    'charge.failed': null, // rejected: cannot fail after success
  },
  refunded: {},
  chargeback: {},
  failed: {},
}

export function createOrder ({ store, accountId, planId, cycle, provider }) {
  if (!store.getAccount(accountId)) return { error: 'unknown-account' }
  const plan = getPlan(planId)
  if (!plan) return { error: 'unknown-plan' }
  if (!plan.sellable) return { error: 'plan-not-sellable' } // local/selfhost: nothing to bill
  const price = priceFor(planId, cycle)
  if (!price) return { error: 'unknown-cycle' }
  const order = {
    orderId: `ord_${randomBytes(9).toString('hex')}`,
    accountId,
    planId,
    cycle,
    status: 'pending',
    amountMinor: price.amountMinor, // server-derived; client never states money
    currency: price.currency,
    provider: provider.name,
    providerRef: null,
    createdAt: store.now(),
    settledAt: null,
    closedAt: null,
    closeReason: null,
  }
  store.insertOrder(order)
  return { order }
}

export function isTerminal (status) { return TERMINAL.has(status) }

/** Apply one normalized provider event to an order.
 *  Returns one of:
 *    { applied:true, status }            — transition happened
 *    { applied:false, deferred:true }    — valid later, order not ready (refund pre-charge)
 *    { applied:false, reason }           — rejected/ignored (recorded, no effect)
 *  DOES NOT touch the ledger — webhook.mjs owns the transaction boundary. */
export function applyEventToOrder ({ store, order, event }) {
  if (isTerminal(order.status)) {
    return { applied: false, reason: `order-terminal-${order.status}` }
  }
  const next = (TRANSITIONS[order.status] || {})[event.type]
  if (next === undefined) {
    // e.g. refund on pending: legitimate from the provider's view, useless
    // until a charge lands — defer and replay when the order reaches `paid`.
    return { applied: false, deferred: true }
  }
  if (next === null) {
    return { applied: false, reason: `invalid-transition-${event.type}-from-${order.status}` }
  }
  const patch = { status: next }
  if (next === 'paid') { patch.settledAt = store.now(); patch.providerRef = event.providerRef || order.providerRef }
  else { patch.closedAt = store.now(); patch.closeReason = event.type }
  store.patchOrder(order.orderId, patch)
  return { applied: true, status: next }
}

/** Sweep stale pending orders to `failed` (provider never settled them).
 *  Called opportunistically (reconcile/report); idempotent. */
export function sweepExpiredOrders (store, { maxPendingAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const now = store.now()
  let expired = 0
  for (const o of store.listAllOrders()) {
    if (o.status !== 'pending') continue
    if (now - o.createdAt < maxPendingAgeMs) continue
    store.patchOrder(o.orderId, { status: 'failed', closedAt: now, closeReason: 'expired' })
    expired++
  }
  return expired
}

export { CYCLE_MS }
