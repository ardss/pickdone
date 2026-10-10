/**
 * PickDone billing — reconciliation: our ledger vs the provider's statement.
 *
 * A periodic job (or the admin route) hands in the provider's settlement
 * statement (the same rows a Stripe/Paddle CSV export gives: type, orderId,
 * providerRef, amountMinor, currency) and this diffreads BOTH directions:
 *   - charges/refunds/chargebacks in the statement but NOT in our ledger
 *     (provider took money we never booked — investigate immediately);
 *   - ledger money entries with NO statement row (we booked a phantom).
 * Plus internal checks: ledger hash chain, unapplied/deferred events, and
 * pending orders past their settle window (feed for sweepExpiredOrders).
 */

import { verifyChain } from './ledger.mjs'

const matchKey = r => `${r.providerRef || ''}|${r.orderId || ''}|${r.type}|${r.amountMinor}|${r.currency}`

export function reconcileReport ({ store, now = Date.now, statement = [], maxPendingAgeMs = 24 * 60 * 60 * 1000 }) {
  const ledger = store.ledger.all().filter(e => e.type !== undefined)
  const chain = verifyChain(ledger)

  const ours = new Map(ledger.filter(e => e.amountMinor != null).map(e => [matchKey(e), e]))
  const theirs = new Map()
  for (const row of statement) theirs.set(matchKey(row), row)

  // A diff only makes sense against an actual statement: an empty/absent
  // statement would flag EVERY booked entry "missing-in-statement" — noise,
  // not signal. Internal checks (chain, unapplied, stale) always run.
  const discrepancies = []
  if (statement.length > 0) {
    for (const [k, row] of theirs) {
      if (!ours.has(k)) discrepancies.push({ kind: 'missing-in-ledger', ...row })
    }
    for (const [k, e] of ours) {
      if (!theirs.has(k)) {
        discrepancies.push({ kind: 'missing-in-statement', type: e.type, orderId: e.orderId, providerRef: e.providerRef, amountMinor: e.amountMinor, currency: e.currency })
      }
    }
  }

  const totals = (rows) => {
    const t = {}
    for (const r of rows) {
      if (r.amountMinor == null || !r.currency) continue
      const c = (t[r.currency] = t[r.currency] || { charges: 0, refunds: 0, chargebacks: 0, net: 0 })
      if (r.type === 'charge') { c.charges += r.amountMinor; c.net += r.amountMinor }
      else if (r.type === 'refund') { c.refunds += r.amountMinor; c.net -= r.amountMinor }
      else if (r.type === 'chargeback') { c.chargebacks += r.amountMinor; c.net -= r.amountMinor }
    }
    return t
  }

  const t = now()
  return {
    generatedAt: new Date(t).toISOString(),
    chainOk: chain.ok,
    chainBrokenAt: chain.ok ? null : chain.brokenAt,
    ledgerTotals: totals(ledger),
    statementTotals: totals(statement),
    discrepancies,
    unappliedEvents: store.listEvents().filter(e => !e.applied)
      .map(e => ({ eventId: e.eventId, type: e.type, orderId: e.orderId, deferred: !!e.deferred, reason: e.rejectReason || e.applyReason || null })),
    stalePendingOrders: store.listAllOrders()
      .filter(o => o.status === 'pending' && t - o.createdAt > maxPendingAgeMs)
      .map(o => ({ orderId: o.orderId, ageMs: t - o.createdAt })),
  }
}
