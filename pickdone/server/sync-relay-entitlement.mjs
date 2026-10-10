/**
 * PickDone Sync v2 — server-authoritative entitlement gate for the relay
 * (feature/syncv2-relay-entitlement, 2026-10-10). DEFAULT OFF.
 *
 * WHEN THE GATE IS ABSENT the relay behaves byte-for-byte like before (open
 * self-host semantics, spec §54): nothing in this module may change that.
 * When an operator wires a gate via createRelay(store, { entitlements }), the
 * relay becomes a HOSTED relay and enforces server-verified subscription,
 * device and storage limits on the WRITE paths only:
 *
 *   register (new device)  gated: identity + freeze + plan + device limit
 *   push (new envelopes)   gated: identity + freeze + plan + byte quota (413)
 *   pull / snapshot latest NOT gated: reads/export stay open for every account
 *                           (free, expired, grace, frozen) — data egress is
 *                           never held hostage (readOnlyAlwaysAllowed policy).
 *
 * TRUST MODEL — the one rule this module exists for:
 *   A cloud subscription is granted ONLY by a server-verified decision. The
 *   TrustResolver input is identity-shaped ({ account, device, action }) — it
 *   NEVER receives client-declared paid flags, because a client saying
 *   "paid: true" proves nothing. Resolver failure is fail-closed (503) for
 *   writes; reads stay open.
 *
 * PLUGINS:
 *   - TrustResolver        — the ONLY seam for real identity verification.
 *   - createSandboxTrustBridge — IN-PROCESS bridge onto billing/store.mjs for
 *     tests and single-process sandbox deployments. NOT a production identity
 *     plane (see PRODUCTION_NO_GO below).
 *
 * FREEZE / GRACE / QUOTA SEMANTICS (mirrors billing/entitlements.mjs):
 *   - refund/chargeback  -> frozen: register+push DENIED with the freeze reason
 *                           in the code (subscription-refund / chargeback);
 *   - expired, in grace  -> hosted sync CONTINUES (explicit policy knobs
 *                           graceAllowsPush / graceAllowsNewDevices);
 *   - expired past grace -> treated as free tier: writes DENIED, reads open;
 *   - device limit       -> Nth NEW device 403 device-limit; proven rotation of
 *                           an existing row is idempotent and never blocked;
 *   - storage quota      -> relay-metered accepted ciphertext bytes; a push
 *                           projected over quota is a coded 413 BEFORE any
 *                           store write, so retries are always safe and a
 *                           transient denial never becomes permanent.
 *
 * REPLAY / CONCURRENT IDEMPOTENCY:
 *   The gate meters only bytes the relay actually NEWLY stored: relay.push
 *   reports duplicate opIds (appendEnvelope dedup) and the gate skips them;
 *   the quota projection likewise excludes already-accepted opIds, so a
 *   replayed push can neither be double-metered nor falsely 413'd. Node's
 *   single-threaded route handling plus store-level opId dedup makes the
 *   check-then-meter sequence atomic per request; concurrent replays converge
 *   to one stored copy and one metered charge.
 *
 * ============================================================================
 * PRODUCTION_NO_GO — do NOT take this entitlement plane to production until
 * every item below is closed with evidence:
 *   1. IDENTITY IS MOCK. billing POST /v1/accounts mints an API key to anyone;
 *      there is no email/OAuth/SSO/real-world identity behind an account.
 *      `account` strings on the relay are client-chosen; only the operator
 *      provisioning step (bridge.bind) makes them mean something, and that
 *      binding lives in the same process/memory as the relay itself.
 *   2. PAYMENTS ARE SIMULATED. The sandbox provider mints sandbox:// checkout
 *      URLs and its own signed webhooks; there is no PSP, no real charge,
 *      no real refund/chargeback signal. NO real money movement may be enabled
 *      from this code path.
 *   3. TRUST BRIDGE IS IN-PROCESS. A compromised relay host IS the billing
 *      authority here. Production requires service-to-service verification
 *      (mTLS/signed JWT) against a separately deployed billing service, with
 *      the binding persisted server-side, not in relay memory.
 *   4. USAGE METERING IS IN-MEMORY AND RELAY-LOCAL. Accepted-bytes drift from
 *      the durable truth (GC shrink, restarts). Production needs durable
 *      metering + periodic reconciliation against the trusted reporter
 *      (POST /v1/usage) and setUsage/resync on drift.
 *   5. WEBHOOK TRUST IS A SHARED HMAC SECRET with sandbox skew windows.
 *      Production needs PSP-verified signatures, replay windows and key
 *      rotation evidence.
 *   6. NO LEGAL/TAX/PCI REVIEW, no ToS, no dunning emails, no data-deletion
 *      SLA for frozen accounts (reads stay open by design — confirm counsel).
 */

import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { computeEntitlements, GRACE_MS } from './billing/entitlements.mjs'

// Durable persistence for the hosted relay's OPERATOR plane (bindings + usage
// metering). writeFileDurable comes from the app tree (tmp → fsync → rename);
// standalone deployments without it get a plain atomic-enough fallback, the
// same trade billing/store.mjs already makes.
const requireCjs = createRequire(import.meta.url)
let writeFileDurable
try {
  ({ writeFileDurable } = requireCjs('../../src/main/durable-fs.js'))
} catch {
  writeFileDurable = (file, data) => {
    const fs = requireCjs('node:fs')
    fs.mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  }
}

/** Explicit, operator-visible enforcement policy. Frozen; override per gate. */
export const DEFAULT_ENTITLEMENT_POLICY = Object.freeze({
  /** Reads (pull / snapshot latest / device state) are never billed or gated. */
  readOnlyAlwaysAllowed: true,
  /** Expired-but-in-grace accounts may keep pushing (renewal lands late). */
  graceAllowsPush: true,
  /** Expired-but-in-grace accounts may enroll new devices. */
  graceAllowsNewDevices: true,
  /** HTTP status for storage-quota breaches on push. */
  quotaPushStatus: 413,
  /** HTTP status for device-limit breaches on register. */
  deviceLimitStatus: 403,
  /** TrustResolver crash/failure: writes fail CLOSED (never open). */
  resolverError: 'fail-closed',
})

/** Machine-readable production readiness blockers — see the header. */
export const PRODUCTION_NO_GO = Object.freeze([
  'identity-is-mock-api-key',
  'payments-are-simulated-sandbox',
  'trust-bridge-is-in-process',
  'usage-metering-is-in-memory',
  'webhook-trust-is-shared-hmac',
  'no-legal-tax-pci-review',
])

/**
 * TrustResolver contract (implement this for real deployments).
 *
 *   resolveTrust({ account, device, action }) => Promise<TrustDecision|null>
 *
 * TrustDecision:
 *   trusted            boolean  — ONLY a server-verified mapping grants true
 *   accountId          string   — canonical billing account id
 *   tier               string   — 'local' | 'cloud' | 'selfhost'
 *   hostedSync         boolean  — plan grants hosted sync at all
 *   frozen             boolean  — refund/chargeback freeze (wins over all)
 *   frozenReason       string|null — 'refund' | 'chargeback' | ...
 *   grace              boolean  — expired but inside the grace window
 *   maxDevices         number|null  — ACTIVE-device cap; null = unlimited
 *   storageQuotaBytes  number|null  — stored-bytes cap; null = unlimited
 *   storageUsageBytes  number   — server-side usage (seeds the relay meter)
 *   overQuota          boolean  — billing-side over-quota flag (hard 413)
 *
 * NO client-controlled field is ever passed in; implementers must not accept
 * any. Returning null / { trusted:false } = free tier (writes denied).
 */

const gateError = (status, code, message) =>
  Object.assign(new Error(`entitlement-denied/${code}: ${message}`), { status, code })

// ---------- usage ledger (relay-local accepted-bytes meter) ----------

/** FIFO cap of tracked opIds PER ACCOUNT. Bounded memory; eviction is safe:
 *  an evicted opId replayed against a still-stored envelope is reported as a
 *  duplicate by the store and never re-metered. */
export const USAGE_OPS_CAP_PER_ACCOUNT = 200_000

/**
 * File-backed persistence for the usage ledger (PRODUCTION_NO_GO #4 fix).
 *
 * The in-memory ledger used to die with the process: a relay restart silently
 * reset metering to zero, so a quota could be bypassed by bouncing the relay
 * and drift was invisible. With `path` set, the ledger write-throughs a JSON
 * snapshot (tmp → fsync → rename, same primitive as relay-state.json) on every
 * mutation and reloads it at construction. Corrupt/unreadable snapshots are
 * quarantined to `<path>.bad` and reset to empty — metering loss is the SAFE
 * failure direction (replays are deduped by the store, and an operator resync
 * via setUsage remains authoritative).
 */
function createUsageLedger (path = null) {
  const byAccount = new Map() // account -> { total, ops: Map<opId, bytes> }
  const acct = a => {
    let e = byAccount.get(a)
    if (!e) { e = { total: 0, ops: new Map() }; byAccount.set(a, e) }
    return e
  }
  const snapshot = () => ({
    version: 1,
    accounts: Object.fromEntries([...byAccount.entries()].map(([a, e]) => [a, {
      total: e.total,
      ops: [...e.ops.entries()].slice(-USAGE_OPS_CAP_PER_ACCOUNT),
    }])),
  })
  const persist = () => {
    if (!path) return
    try { writeFileDurable(path, JSON.stringify(snapshot())) } catch { /* metering must never take a push down */ }
  }
  if (path && existsSync(path)) {
    try {
      const dump = JSON.parse(readFileSync(path, 'utf8'))
      if (!dump || typeof dump !== 'object' || typeof dump.accounts !== 'object' || dump.accounts === null) {
        throw new Error('malformed usage dump: accounts object required')
      }
      for (const [a, e] of Object.entries(dump.accounts)) {
        if (!e || typeof e !== 'object' || !Number.isFinite(e.total) || !Array.isArray(e.ops)) continue
        const entry = { total: e.total, ops: new Map() }
        for (const op of e.ops) {
          if (Array.isArray(op) && typeof op[0] === 'string' && Number.isFinite(op[1])) entry.ops.set(op[0], op[1])
        }
        byAccount.set(String(a), entry)
      }
    } catch (err) {
      const bad = path + '.bad'
      try { requireCjs('node:fs').renameSync(path, bad) } catch { /* unreadable AND unmovable */ }
      console.error(`[relay-entitlement] usage ledger unreadable (${err && err.message}) — quarantined to ${bad}, metering restarts at zero`)
    }
  }
  return {
    has: a => byAccount.has(a),
    total: a => (byAccount.get(a) ? byAccount.get(a).total : 0),
    known: (a, opId) => { const e = byAccount.get(a); return e ? e.ops.has(opId) : false },
    /** Meter freshly-stored bytes. Returns false (no-op) for a known opId. */
    accept (a, opId, bytes) {
      const e = acct(a)
      if (e.ops.has(opId)) return false
      e.ops.set(opId, bytes)
      if (e.ops.size > USAGE_OPS_CAP_PER_ACCOUNT) e.ops.delete(e.ops.keys().next().value)
      e.total += bytes
      persist()
      return true
    },
    /** First-seen seed from the server-reported usage (trusted reporter). */
    seed (a, bytes) {
      if (!byAccount.has(a)) { byAccount.set(a, { total: bytes, ops: new Map() }); persist() }
    },
    /** Authoritative resync (operator/reconcile). Clears opId memory too —
     *  a stale ledger must never outvote the reconciled truth. */
    reset (a, bytes = 0) { byAccount.set(a, { total: bytes, ops: new Map() }); persist() },
    /** Test/ops introspection: the durable snapshot shape. */
    __snapshot: snapshot,
  }
}

// ---------- the gate ----------

/**
 * @param {object} opts
 * @param {Function|object} opts.trustResolver  resolveTrust fn or { resolveTrust }
 * @param {object} [opts.policy]   overrides on DEFAULT_ENTITLEMENT_POLICY
 * @param {string} [opts.usagePath] durable usage-ledger file (relay restarts keep
 *   metering/quota; see createUsageLedger). Absent = in-memory only (tests).
 * @param {Function} [opts.now]    clock
 */
export function createEntitlementGate ({ trustResolver, policy = null, usagePath = null, now = Date.now } = {}) {
  if (!trustResolver) throw new Error('createEntitlementGate: trustResolver is required')
  if (typeof trustResolver !== 'function' && typeof trustResolver.resolveTrust !== 'function') {
    throw new Error('createEntitlementGate: trustResolver must be a function or expose resolveTrust()')
  }
  const resolve = typeof trustResolver === 'function'
    ? trustResolver
    : trustResolver.resolveTrust.bind(trustResolver)
  const mergedPolicy = Object.freeze({ ...DEFAULT_ENTITLEMENT_POLICY, ...(policy || {}) })
  const ledger = createUsageLedger(usagePath)

  /** Resolve + validate one decision; throws coded denials for writes. */
  async function decide ({ account, device, action, graceKnob }) {
    let decision
    try {
      decision = await resolve({ account, device, action })
    } catch (e) {
      if (mergedPolicy.resolverError !== 'fail-closed') throw e
      throw gateError(503, 'resolver-unavailable', `trust resolver failed (${e && e.message}); writes fail closed`)
    }
    if (!decision || decision.trusted !== true) {
      throw gateError(403, 'no-server-identity', `account ${JSON.stringify(String(account || ''))} has no server-verified identity; client-claimed flags grant nothing`)
    }
    if (decision.frozen) {
      throw gateError(403, `subscription-${decision.frozenReason || 'frozen'}`, `subscription is frozen (${decision.frozenReason || 'frozen'}); writes are suspended, reads remain available`)
    }
    const graceWrite = !!decision.grace && graceKnob === true
    if (!decision.hostedSync && !graceWrite) {
      throw gateError(403, 'plan-hosted-sync-unavailable', 'the plan does not include hosted sync (free or expired past grace)')
    }
    return decision
  }

  const seedUsage = (account, decision) => {
    if (!ledger.has(account) && Number.isFinite(decision.storageUsageBytes) && decision.storageUsageBytes > 0) {
      ledger.seed(account, decision.storageUsageBytes)
    }
  }

  const projectedIncoming = (account, items) => {
    let incoming = 0
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it.opId !== 'string' || typeof it.envelope !== 'string') continue
      if (ledger.known(account, it.opId)) continue // replay-safe projection
      incoming += Buffer.byteLength(it.envelope)
    }
    return incoming
  }

  return {
    trustResolver,
    policy: mergedPolicy,

    /** Register seam: identity + freeze + plan(grace) + device limit. */
    async guardDeviceRegister ({ account, device, store }) {
      const decision = await decide({ account, device, action: 'register', graceKnob: mergedPolicy.graceAllowsNewDevices })
      // Proven rotation of an existing row is idempotent: never a NEW device.
      if (store && store.getDevice(account, device)) return decision
      const max = decision.maxDevices
      if (Number.isFinite(max)) {
        const active = store.listDevices(account).filter(d => d && d.status !== 'retired').length
        if (active >= max) {
          throw gateError(mergedPolicy.deviceLimitStatus, 'device-limit', `plan allows ${max} active device(s); retire one or upgrade`)
        }
      }
      return decision
    },

    /** Push seam: identity + freeze + plan(grace) + byte quota. Throws coded
     *  errors BEFORE relay.push touches the store, so a denial leaves zero
     *  state behind (usage untouched, no device bump, no envelopes). */
    async guardPush ({ account, device, items }) {
      const decision = await decide({ account, device, action: 'push', graceKnob: mergedPolicy.graceAllowsPush })
      const quota = decision.storageQuotaBytes
      if (decision.overQuota === true) {
        throw gateError(mergedPolicy.quotaPushStatus, 'storage-quota-exceeded', 'server-side usage is over quota')
      }
      if (Number.isFinite(quota)) {
        seedUsage(account, decision)
        const projected = ledger.total(account) + projectedIncoming(account, items)
        if (projected > quota) {
          throw gateError(mergedPolicy.quotaPushStatus, 'storage-quota-exceeded', `stored ${ledger.total(account)}B + push ${projectedIncoming(account, items)}B exceeds the ${quota}B quota`)
        }
      }
      return decision
    },

    /** Meter AFTER a successful relay.push, skipping store-reported duplicates
     *  and already-accepted opIds (replay/concurrency idempotency). */
    recordAccepted (account, items, duplicates) {
      const dup = duplicates instanceof Set ? duplicates : new Set(duplicates || [])
      for (const it of Array.isArray(items) ? items : []) {
        if (!it || typeof it.opId !== 'string' || typeof it.envelope !== 'string') continue
        if (dup.has(it.opId)) continue
        ledger.accept(account, it.opId, Buffer.byteLength(it.envelope))
      }
    },

    usageBytes: account => (ledger.has(account) ? ledger.total(account) : undefined),
    /** Operator/reconcile resync — see PRODUCTION_NO_GO #4. */
    setUsage: (account, bytes) => ledger.reset(account, Number.isFinite(bytes) ? bytes : 0),
  }
}

// ---------- relay attachment (the ONLY integration point) ----------

/**
 * Wrap a relay's write seams with the gate. Reads are untouched. The wrapped
 * methods become async (trust resolution is async in production); when the
 * gate throws a coded error the HTTP layer answers with its status + message
 * (relay route() already maps {status,message} errors to JSON bodies).
 */
export function attachEntitlementGate (relay, gate) {
  if (!relay || !gate) throw new Error('attachEntitlementGate: relay and gate required')
  const rawRegister = relay.registerDevice
  const rawPush = relay.push
  relay.registerDevice = async function (account, device, opts) {
    await gate.guardDeviceRegister({ account, device, action: 'register', store: relay.store })
    return rawRegister.call(relay, account, device, opts)
  }
  relay.push = async function (account, device, items) {
    await gate.guardPush({ account, device, items, action: 'push', store: relay.store })
    const out = rawPush.call(relay, account, device, items)
    gate.recordAccepted(account, items, (out && out.duplicates) || [])
    return out
  }
  return relay
}

// ---------- in-process sandbox trust bridge ----------

/**
 * Bridge the relay's `account` strings onto billing accounts IN THIS PROCESS.
 * The binding is operator provisioning (bridge.bind) — never a client claim:
 * nothing on the wire can create or move a binding. SANDBOX ONLY; see
 * PRODUCTION_NO_GO #1/#3 before ever pointing this at real customers.
 *
 * `bindingsPath` (2026-10-11): durable operator bindings (JSON snapshot,
 * write-through on every bind). Without it, a relay restart forgot every
 * binding and ALL accounts fell back to untrusted/free — an operator had to
 * re-run provisioning after every deploy. With it, bindings survive restarts;
 * a corrupt file quarantines to `.bad` and starts empty (the fail-safe
 * direction: nobody gains trust from a damaged file).
 */
export function createSandboxTrustBridge ({ billingStore, bindingsPath = null, graceMs = GRACE_MS, now = Date.now } = {}) {
  if (!billingStore) throw new Error('createSandboxTrustBridge: billingStore required')
  const bindings = new Map() // relay account -> billing accountId
  const overrides = new Map() // relay account -> { maxDevices?, storageQuotaBytes? }
  /** Durable operator state: bindings AND per-account plan overrides — a relay
   *  restart used to silently forget overrides, so a support-granted quota cap
   *  evaporated on every deploy. One JSON file, write-through on mutation. */
  const persistOperatorState = () => {
    if (!bindingsPath) return
    try {
      writeFileDurable(bindingsPath, JSON.stringify({
        version: 1,
        bindings: [...bindings.entries()],
        overrides: [...overrides.entries()],
      }))
    } catch { /* a persist failure must not fail the bind itself */ }
  }
  if (bindingsPath && existsSync(bindingsPath)) {
    try {
      const dump = JSON.parse(readFileSync(bindingsPath, 'utf8'))
      if (!dump || typeof dump !== 'object' || !Array.isArray(dump.bindings)) {
        throw new Error('malformed bindings dump: bindings array required')
      }
      for (const b of dump.bindings) {
        if (Array.isArray(b) && typeof b[0] === 'string' && typeof b[1] === 'string') bindings.set(b[0], b[1])
      }
      for (const o of (Array.isArray(dump.overrides) ? dump.overrides : [])) {
        if (Array.isArray(o) && typeof o[0] === 'string' && o[1] && typeof o[1] === 'object') overrides.set(o[0], o[1])
      }
    } catch (err) {
      const bad = bindingsPath + '.bad'
      try { requireCjs('node:fs').renameSync(bindingsPath, bad) } catch { /* unreadable AND unmovable */ }
      console.error(`[relay-entitlement] bindings unreadable (${err && err.message}) — quarantined to ${bad}, no accounts trusted until re-bound`)
    }
  }
  const untrusted = () => ({
    trusted: false,
    reason: 'no-server-binding',
    accountId: null,
    tier: 'local',
    hostedSync: false,
    frozen: false,
    frozenReason: null,
    grace: false,
    maxDevices: 1,
    storageQuotaBytes: 0,
    storageUsageBytes: 0,
    overQuota: false,
  })
  return {
    trustLevel: 'sandbox-in-process-only',
    /** Operator-side provisioning of the account <-> billing binding. */
    bind (account, billingAccountId) {
      if (typeof account !== 'string' || !account) throw new Error('bind: relay account string required')
      if (typeof billingAccountId !== 'string' || !billingAccountId) throw new Error('bind: billing accountId required')
      bindings.set(account, billingAccountId)
      persistOperatorState()
    },
    bindingOf: account => (bindings.has(account) ? { accountId: bindings.get(account) } : null),
    /** Operator-side per-account plan overrides (support/enterprise limits). */
    setPlanOverride (account, patch = {}) {
      const prev = overrides.get(account) || {}
      overrides.set(account, {
        maxDevices: 'maxDevices' in patch ? patch.maxDevices : prev.maxDevices,
        storageQuotaBytes: 'storageQuotaBytes' in patch ? patch.storageQuotaBytes : prev.storageQuotaBytes,
      })
      persistOperatorState()
    },
    /** Test/ops introspection: durable overrides survive restarts. */
    planOverrideOf: account => (overrides.has(account) ? { ...overrides.get(account) } : null),
    async resolveTrust ({ account } = {}) {
      const billingAccountId = bindings.get(account)
      if (!billingAccountId || !billingStore.getAccount(billingAccountId)) return untrusted()
      const ent = computeEntitlements({ store: billingStore, accountId: billingAccountId, now: () => now(), graceMs })
      const ov = overrides.get(account) || {}
      return {
        trusted: true,
        accountId: billingAccountId,
        tier: ent.tier,
        hostedSync: ent.hostedSync,
        frozen: ent.frozen,
        frozenReason: ent.frozenReason,
        grace: ent.grace,
        maxDevices: ov.maxDevices !== undefined ? ov.maxDevices : ent.maxDevices,
        storageQuotaBytes: ov.storageQuotaBytes !== undefined ? ov.storageQuotaBytes : ent.storageQuotaBytes,
        storageUsageBytes: ent.storageUsageBytes,
        overQuota: ent.overQuota,
      }
    },
  }
}
