/**
 * PickDone billing — entitlement computation (pure, derived, never stored).
 *
 * Entitlements are COMPUTED from (subscription record, usage, now) on every
 * read — there is no "entitlement" row a client or bug can corrupt. Key rules:
 *   - entitlements are granted ONLY by server-verified payment (webhook →
 *     order=paid → subscription activation). Client self-reports grant nothing.
 *   - refund/chargeback FREEZES the subscription immediately (hosted sync off),
 *     even inside the paid window.
 *   - expiry keeps a short GRACE window (renewal payments often land hours
 *     late); after grace the account reverts to the free local tier.
 */

import { getPlan, CYCLE_MS } from './plans.mjs'

export const GRACE_MS = 3 * 24 * 60 * 60 * 1000

/** Period end after a successful charge. Renewals stack on the existing end
 *  (max(now, currentPeriodEnd) + cycle) so paying early never loses days. */
export function periodEndAfterCharge ({ now, cycle, previous }) {
  const base = previous && previous > now ? previous : now
  return base + CYCLE_MS[cycle]
}

export function baseEntitlements (now) {
  const plan = getPlan('local')
  return {
    tier: plan.tier,
    hostedSync: plan.hostedSync,
    selfHosted: false,
    maxDevices: plan.maxDevices,
    storageQuotaBytes: plan.storageQuotaBytes,
    storageUsageBytes: 0,
    overQuota: false,
    frozen: false,
    frozenReason: null,
    grace: false,
    subscription: null,
    computedAt: now,
  }
}

/** The one function everything reads. `sub` may be null (free account). */
export function computeEntitlements ({ store, accountId, now = Date.now, graceMs = GRACE_MS }) {
  const t = now()
  const ent = baseEntitlements(t)
  const usage = store.getUsage(accountId)
  ent.storageUsageBytes = usage.bytesUsed || 0
  const sub = store.getSubscription(accountId)
  if (!sub) {
    ent.overQuota = ent.storageUsageBytes > ent.storageQuotaBytes
    return ent
  }
  ent.subscription = {
    planId: sub.planId, cycle: sub.cycle, status: sub.status,
    startedAt: sub.startedAt, currentPeriodEnd: sub.currentPeriodEnd,
  }
  if (sub.status === 'frozen') {
    ent.frozen = true
    ent.frozenReason = sub.frozenReason || 'frozen'
    ent.hostedSync = false
    ent.tier = getPlan('local').tier
    ent.maxDevices = getPlan('local').maxDevices
    ent.overQuota = false
    return ent
  }
  const plan = getPlan(sub.planId) || getPlan('local')
  const inPaidWindow = t < sub.currentPeriodEnd
  const inGrace = !inPaidWindow && t < sub.currentPeriodEnd + graceMs
  if (inPaidWindow || inGrace) {
    ent.tier = plan.tier
    ent.hostedSync = plan.hostedSync
    ent.maxDevices = plan.maxDevices
    ent.storageQuotaBytes = plan.storageQuotaBytes
    ent.grace = inGrace
  }
  ent.overQuota = ent.storageUsageBytes > ent.storageQuotaBytes
  return ent
}

/** The seam the sync relay will call before serving a hosted-sync request.
 *  Freeze wins over everything (a refunded/charged-back account must not ride
 *  on quota bookkeeping or plan quirks). */
export function checkSyncAllowed (entitlements) {
  if (entitlements.frozen) return { allowed: false, reason: `subscription-${entitlements.frozenReason}` }
  if (!entitlements.hostedSync) return { allowed: false, reason: 'plan-hosted-sync-unavailable' }
  if (entitlements.overQuota) return { allowed: false, reason: 'storage-quota-exceeded' }
  return { allowed: true }
}
