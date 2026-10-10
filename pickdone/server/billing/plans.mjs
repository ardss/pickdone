/**
 * PickDone billing — product plans and entitlement templates (sandbox vertical).
 *
 * Monetization shape (agreed product direction, 2026-10):
 *   - local features are FREE forever (the app is local-first);
 *   - the PAID product is HOSTED multi-device sync (we run the relay, we store
 *     the envelopes/snapshots, we pay the hosting) — sold per account;
 *   - SELF-HOST (running the open-source relay yourself) stays free with free
 *     egress — it is not something billing gates.
 *
 * Money is ALWAYS integer minor units (cents) + ISO-4217 currency. No floats
 * anywhere in the billing core. Prices here are SANDBOX catalog values: they
 * exercise the pipeline but never represent a live offer.
 */

export const CURRENCY = 'USD'

/** Paid period length per billing cycle, in ms (used for currentPeriodEnd). */
export const CYCLE_MS = {
  monthly: 30 * 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000,
}

/** Storage quota per plan in bytes. 0 = none (no hosted storage). */
const GIB = 1024 * 1024 * 1024

export const PLANS = {
  /**
   * Free local tier — what an account has when it has NO active paid
   * subscription. Present in the catalog for explicitness; NOT sellable
   * server-side (nothing to bill: no hosted component is consumed).
   */
  local: {
    tier: 'local',
    sellable: false,
    hostedSync: false,
    maxDevices: 1,
    storageQuotaBytes: 0,
  },
  /**
   * Paid hosted-sync tier. The ONLY sellable plan in the sandbox catalog.
   * localSync stays free inside it (tier is additive on top of local).
   */
  cloud: {
    tier: 'cloud',
    sellable: true,
    hostedSync: true,
    maxDevices: 5,
    storageQuotaBytes: 1 * GIB,
    price: {
      monthly: { amountMinor: 499, currency: CURRENCY },
      annual: { amountMinor: 4999, currency: CURRENCY },
    },
  },
  /**
   * Self-host: running the open-source sync relay yourself. Free, free egress,
   * NO hosted storage from us — it never reaches the billing pipeline except
   * as an entitlement label for tooling/UI.
   */
  selfhost: {
    tier: 'selfhost',
    sellable: false,
    hostedSync: true, // your own relay, your own hardware
    maxDevices: null, // unlimited — the operator's own risk/cost
    storageQuotaBytes: 0,
    selfHosted: true,
  },
}

export function getPlan (planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId) ? PLANS[planId] : null
}

export function isSellable (planId, cycle) {
  const plan = getPlan(planId)
  return !!(plan && plan.sellable && plan.price && plan.price[cycle])
}

/** The exact money an order for (planId, cycle) must carry — webhook events
 *  are validated against this, never against client-declared amounts. */
export function priceFor (planId, cycle) {
  if (!isSellable(planId, cycle)) return null
  const { amountMinor, currency } = PLANS[planId].price[cycle]
  return { amountMinor, currency }
}
