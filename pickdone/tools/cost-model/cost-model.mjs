/**
 * PickDone cloud capacity & cost model — configuration-driven, pure functions.
 *
 * MVP cloud shape (per docs/sync-v2-cloud-control-plane.md): the EXISTING Node
 * relay (Node HTTP + better-sqlite3/WAL, long-lived connections) runs on a
 * VPS/container; R2-style object storage holds encrypted snapshots + cold
 * archive; Workers/D1 are an ALTERNATIVE data plane, not the default, and are
 * not priced into totals here.
 *
 * Prices are price entries: { value, unit, source: { url, verifiedAt } }.
 * - `verified(...)`: transcribed from the vendor's PUBLIC list price (never our
 *   contracted settlement rates).
 * - `assumption(...)`: a placeholder the operator MUST replace with a sourced
 *   quote before any external use (see price-source.mjs / CLI --quote).
 * - `notModeled(...)`: a cost driver we deliberately do not price; the report
 *   carries it as a warning and totals MUST NOT be presented as complete.
 *
 * Units (input AND output): bytes/GB decimal (1 GB = 1e9 B); month = 30.44 d;
 * money = config.currency (default USD, list-price transcription).
 */

export const DAYS_PER_MONTH = 30.44
export const GB = 1e9

// ---------------------------------------------------------------------------
// Price entry helpers
// ---------------------------------------------------------------------------

/** Verified public list price (url + verifiedAt mandatory). */
export const verified = (value, unit, url, verifiedAt = '2026-10-10') =>
  ({ value, unit, source: { url, verifiedAt } })

/** Explicit assumption — never quotable until a real source replaces the text. */
export const assumption = (value, unit, note = 'placeholder magnitude — replace with a sourced vendor quote + verification date') =>
  ({ value, unit, source: { url: `ASSUMPTION: ${note}`, verifiedAt: 'UNSET' } })

/** A cost driver intentionally excluded from totals; surfaces as a warning. */
export const notModeled = (unit, reason) =>
  ({ value: null, unit, source: { url: `NOT MODELED: ${reason}`, verifiedAt: 'UNSET' } })

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const R2 = 'https://developers.cloudflare.com/r2/pricing/'
const WORKERS = 'https://developers.cloudflare.com/workers/platform/pricing/'
const CREEM = 'https://www.creem.io/pricing/'
const PADDLE = 'https://www.paddle.com/pricing'

export function defaultConfig() {
  return {
    currency: 'USD',

    users: {
      mau: 5000,            // total monthly active users (free + paid)
      paidShare: 0.08,      // fraction of MAU on a paid tier
    },

    usage: {
      devicesPerUser: 2.5,              // mean registered devices per user
      freeDeviceCap: 1,                 // free tier device slots
      paidDeviceCap: 5,                 // paid tier device slots
      changesPerDeviceActiveDay: 40,    // envelopes pushed per active device-day
      activeDaysPerMonth: 22,           // active device-days per device per month
      payloadBytesPerChange: 1200,      // server-side envelope JSON bytes (pre-compression)
      storageCompressionFactor: 0.6,    // stored bytes / payload bytes (0.6 = stores 60%)
      egressCompressionFactor: 0.5,     // wire bytes / payload bytes during pull
      accountStateBytes: 8 * GB / 1000, // 8 MB mean materialized account state
      snapshotCompressionFactor: 0.4,
      envelopeRetentionMonths: 6,       // mean hot-DB residency (GC-floor assumption)
      coldArchiveMonths: 18,            // months envelopes live in the cold tier after hot
      generationsFree: 1,               // snapshots retained on the free tier
      generationsPaid: 10,              // snapshots retained on the paid tier (version history)
      snapshotsPerAccountMonth: 8,      // snapshot uploads per account per month
      newDevicesPerUserMonth: 0.02,     // snapshot-bootstrap events per user-month
      pullRoundsPerDeviceActiveDay: 96, // pull/ack rounds per active device-day (15 min cadence)
      changesPerPushRequest: 20,        // envelopes batched per push request
    },

    // DB track = the relay's own SQLite (WAL) volume on the compute host or an
    // attached block volume. NOT D1 by default (relay depends on better-sqlite3/WAL).
    db: {
      rowOverheadBytesPerEnvelope: 400, // serverSeq, opId, indexes, page slack
      replicas: 1,                      // extra copies beyond the primary volume
      volumeOverheadFactor: 1.3,        // WAL + page-rewrite overhead living alongside data
      pricePerGbMonth: assumption(0.10, 'USD per GB-month (attached SSD block volume; 0 if the VPS disk already covers it)'),
      // Row-level billing (e.g. D1 rows_read/rows_written) is intentionally NOT
      // priced: fill pricePerMillionReads/Writes only if the db track moves to D1.
      requests: {
        pricePerMillionReads: notModeled('USD per million row reads', 'D1 rows_read billing is not applicable to the SQLite volume MVP; required before any D1-based plan can claim complete totals'),
        pricePerMillionWrites: notModeled('USD per million row writes', 'D1 rows_written billing is not applicable to the SQLite volume MVP; required before any D1-based plan can claim complete totals'),
      },
    },

    // Object track = R2-style storage for encrypted snapshots + cold archive.
    object: {
      replicas: 1,
      pricePerGbMonth: verified(0.015, 'USD per GB-month (R2 Standard, public list price)', R2),
      coldPriceFactor: 1.0,             // R2 list has a single Standard class (no archive tier as of 2026-10-10)
      coldReplicas: 1,
      restoreShareOfYearlyPerMonth: 0.002, // fraction of cold GB retrieved per month (2%/yr)
      backupCopies: 1,
      backupPriceFactor: 1.0,           // backups billed as extra R2 Standard GB (verified basis)
      requests: {
        writePricePerMillion: verified(4.50, 'USD per million R2 Class A (write) operations', R2),
        readPricePerMillion: verified(0.36, 'USD per million R2 Class B (read) operations', R2),
      },
      egressPricePerGb: verified(0.0, 'USD per GB (R2 egress to the internet is free, public list price)', R2),
    },

    // Relay data-plane egress = envelope pull fan-out over the Node relay.
    // This rides the VPS network, NOT R2 free egress — a real VPS either
    // includes a traffic quota or bills per GB; replace the assumption.
    relayEgress: {
      pricePerGb: assumption(0.05, 'USD per GB relay egress (VPS traffic beyond any included quota — check the chosen VPS plan)'),
      includedQuotaGbMonthPerInstance: 1000, // traffic included in the VPS plan (assumption)
    },

    compute: {
      // Node relay on a VPS/container: Node HTTP + better-sqlite3/WAL + long-lived
      // connections (server.maxConnections today). This CANNOT run on Workers;
      // do NOT substitute a Workers plan price here.
      kind: 'vps-node-relay',
      instanceMonthly: assumption(10, 'USD per month for ONE VPS/container sized for the Node relay (pick a real plan + sourced quote)'),
      instancesMin: 1,
      connectionsPerInstance: 4000,     // concurrent device connections per instance (assumption; today maxConnections=64 per process — scale via processes/instances)
      peakConcurrentFraction: 0.05,     // share of all devices concurrently connected at peak
      // NON-PRODUCTION candidate references (public list transcriptions, NOT a
      // decision, NOT contracted rates): region availability, payment eligibility
      // and China-latency UNVERIFIED. Backup/extra IPv4 may bill separately.
      candidateReferences: [
        {
          vendor: 'DigitalOcean Basic Droplet',
          note: '1 GiB/1 vCPU/25 GiB $6/mo; 2 GiB/1 vCPU/50 GiB $12/mo; includes traffic quota — verify backups/public-IP extras',
          monthlyFrom: verified(6, 'USD per month (Basic 1 GiB/1 vCPU/25 GiB, public list price)', 'https://www.digitalocean.com/pricing/droplets'),
        },
        {
          vendor: 'Hetzner CX23/CX33',
          note: 'CX23 (DE/FI) $6.49/mo; CX33 $9.99/mo; EXCLUDES IPv4 and tax (price list 2026-06 adjustment page)',
          monthlyFrom: verified(6.49, 'USD per month (CX23, excl. IPv4 + tax)', 'https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/'),
        },
      ],
    },

    payments: {
      refundRate: 0.02,   // fraction of gross revenue refunded (assumption, editable)
      taxRate: 0.0,       // 0 = prices quoted tax-inclusive; set >0 if prices are net
      adapters: [
        {
          name: 'creem',
          percentFee: verified(0.039, 'fraction of gross revenue per successful charge', CREEM),
          fixedPerCharge: verified(0.40, 'USD per successful charge', CREEM),
        },
        {
          name: 'paddle',
          percentFee: verified(0.05, 'fraction of gross revenue per checkout', PADDLE),
          fixedPerCharge: verified(0.50, 'USD per checkout', PADDLE),
        },
      ],
    },

    pricing: {
      monthlyPrice: 5,    // USD per month, paid tier (sync hosting)
      yearlyPrice: 48,    // USD per year
      yearlyShare: 0.3,   // fraction of payers on the yearly plan
    },

    fixed: [
      // Workers Paid is an OPTIONAL control-plane/payment account, NOT decided and
      // NOT required by the Node-relay MVP. monthly=0 keeps it out of totals;
      // flip to 5 (verified) only if the control plane actually lands on Workers.
      { name: 'workers-paid control plane (optional, undecided)', monthly: 0, source: { url: WORKERS, verifiedAt: '2026-10-10' } },
      { name: 'monitoring + alerting', monthly: 0, source: { url: 'ASSUMPTION: run on the same host / free observability tier initially', verifiedAt: 'UNSET' } },
    ],

    growth: {
      monthly: 0.05,      // MAU monthly growth rate for the 12/36-month projections
    },
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function mergeDeep(base, patch) {
  if (Array.isArray(patch)) return patch.slice()
  if (patch && typeof patch === 'object') {
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {}
    for (const k of Object.keys(patch)) out[k] = mergeDeep(base ? base[k] : undefined, patch[k])
    return out
  }
  return patch === undefined ? base : patch
}

export const getIn = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
export function setIn(obj, path, value) {
  const keys = path.split('.')
  const clone = Array.isArray(obj) ? obj.slice() : { ...obj }
  let cur = clone
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    const next = cur[k]
    cur[k] = Array.isArray(next) ? next.slice() : { ...next }
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
  return clone
}

const ceilPositive = x => Math.max(0, Math.ceil(x))
const price = entry => (entry && typeof entry.value === 'number' ? entry.value : 0)
const isNotModeled = entry => !!(entry && entry.value == null)

// ---------------------------------------------------------------------------
// Per-user, per-tier usage -> cost profile
// ---------------------------------------------------------------------------

export function userUsage(config, tier) {
  const u = config.usage
  const cap = tier === 'paid' ? u.paidDeviceCap : u.freeDeviceCap
  const devices = Math.min(u.devicesPerUser, cap)
  const changesPerMonth = devices * u.changesPerDeviceActiveDay * u.activeDaysPerMonth
  const fanout = Math.max(0, devices - 1) // each envelope is pulled by every OTHER device
  return { tier, devices, changesPerMonth, fanout }
}

export function userCost(config, tier) {
  const u = config.usage
  const d = config.db
  const o = config.object
  const q = userUsage(config, tier)
  const isPaid = tier === 'paid'

  // --- DB track (envelope rows, hot, SQLite volume) ---
  const envelopeServerBytes = u.payloadBytesPerChange * u.storageCompressionFactor + d.rowOverheadBytesPerEnvelope
  const dbEnvelopeBytes = q.changesPerMonth * u.envelopeRetentionMonths * envelopeServerBytes
    * d.replicas * d.volumeOverheadFactor

  // --- Object track (encrypted snapshots + cold archive) ---
  const snapshotBytesPerGen = u.accountStateBytes * u.snapshotCompressionFactor
  const generations = isPaid ? u.generationsPaid : u.generationsFree
  const snapshotBytes = snapshotBytesPerGen * generations * o.replicas
  // cold archive holds packed compressed envelopes beyond the hot window; DB row
  // overhead does not apply (segments are packed ndjson, not rows)
  const coldBytes = q.changesPerMonth * u.coldArchiveMonths * u.payloadBytesPerChange
    * u.storageCompressionFactor * o.coldReplicas

  // --- Egress: two tracks ---
  const relayEgressBytes = q.changesPerMonth * q.fanout * u.payloadBytesPerChange * u.egressCompressionFactor
  const bootstrapEgressBytes = u.newDevicesPerUserMonth * snapshotBytesPerGen // R2 -> device

  // --- Requests ---
  const pushReqs = q.changesPerMonth / u.changesPerPushRequest // relay HTTP, no per-request fee on a VPS
  const snapshotWriteReqs = u.snapshotsPerAccountMonth                       // R2 Class A
  const snapshotReadReqs = u.newDevicesPerUserMonth                          // R2 Class B (bootstrap)
  const coldRestoreReqs = 0 // folded into retrieval volume below

  const gb = b => b / GB
  const dbGb = gb(dbEnvelopeBytes)
  const objectGb = gb(snapshotBytes)
  const coldGb = gb(coldBytes)
  const backupGb = (objectGb + coldGb) * o.backupCopies
  const retrievedGbMonth = coldGb * o.restoreShareOfYearlyPerMonth
  const relayQuotaGb = config.relayEgress.includedQuotaGbMonthPerInstance // shared; attributed at totals level

  const dbCost = dbGb * price(d.pricePerGbMonth)
  const objectCost = objectGb * price(o.pricePerGbMonth)
  const coldCost = coldGb * price(o.pricePerGbMonth) * o.coldPriceFactor
  const backupCost = backupGb * price(o.pricePerGbMonth) * o.backupPriceFactor
  const retrievalCost = retrievedGbMonth * price(o.egressPricePerGb)
    + retrievedGbMonth * price(o.pricePerGbMonth) * o.coldPriceFactor
  const relayEgressCost = gb(relayEgressBytes) * price(config.relayEgress.pricePerGb)
  const objectEgressCost = gb(bootstrapEgressBytes) * price(o.egressPricePerGb)
  const objectWriteCost = snapshotWriteReqs / 1e6 * price(o.requests.writePricePerMillion)
  const objectReadCost = snapshotReadReqs / 1e6 * price(o.requests.readPricePerMillion)

  const storage = dbCost + objectCost + coldCost + backupCost + retrievalCost
  const network = relayEgressCost + objectEgressCost + objectWriteCost + objectReadCost
  const pureVariable = storage + network

  return {
    tier, devices: q.devices, changesPerMonth: q.changesPerMonth, fanout: q.fanout,
    pushReqs, pullReqs: pushReqs * 2, // pull + ack round per push batch
    dbGb, objectGb, coldGb, backupGb,
    relayEgressGb: gb(relayEgressBytes), objectEgressGb: gb(bootstrapEgressBytes),
    lines: {
      dbCost, objectCost, coldCost, backupCost, retrievalCost,
      relayEgressCost, objectEgressCost, objectWriteCost, objectReadCost,
      storage, network, pureVariable,
    },
  }
}

// ---------------------------------------------------------------------------
// Economics for a whole configuration
// ---------------------------------------------------------------------------

export function computeEconomics(config, { withScenarios = true } = {}) {
  const { mau, paidShare } = config.users
  const freeUsers = mau * (1 - paidShare)
  const paidUsers = mau * paidShare

  const free = userCost(config, 'free')
  const paid = userCost(config, 'paid')

  // compute scales with peak concurrent devices across ALL users
  const totalDevices = mau * config.usage.devicesPerUser
  const peakConcurrent = totalDevices * config.compute.peakConcurrentFraction
  const instances = Math.max(config.compute.instancesMin,
    ceilPositive(peakConcurrent / config.compute.connectionsPerInstance))
  const computeCost = instances * price(config.compute.instanceMonthly)

  const fixedMonthly = config.fixed.reduce((s, f) => s + f.monthly, 0)

  const freeVarMonthly = free.lines.pureVariable
  const paidVarMonthly = paid.lines.pureVariable
  const computePerUser = computeCost / mau
  const freeFullyLoaded = freeVarMonthly + computePerUser
  const paidFullyLoaded = paidVarMonthly + computePerUser

  // relay egress quota: per-instance included traffic covers what it can; anything
  // beyond is already priced via relayEgress.pricePerGb. Surface utilization only.
  const relayEgressGbTotal = free.relayEgressGb * freeUsers + paid.relayEgressGb * paidUsers
  const quotaGbTotal = instances * config.relayEgress.includedQuotaGbMonthPerInstance
  const quotaOverrunPct = quotaGbTotal > 0 ? Math.max(0, relayEgressGbTotal / quotaGbTotal - 1) : 0

  const totals = {
    mau, freeUsers, paidUsers,
    devices: totalDevices, peakConcurrent, instances,
    storageDbGb: free.dbGb * freeUsers + paid.dbGb * paidUsers,
    storageObjectGb: free.objectGb * freeUsers + paid.objectGb * paidUsers,
    storageColdGb: free.coldGb * freeUsers + paid.coldGb * paidUsers,
    storageBackupGb: free.backupGb * freeUsers + paid.backupGb * paidUsers,
    relayEgressGbTotal, relayEgressQuotaGb: quotaGbTotal, quotaOverrunPct,
    computeCost, fixedMonthly,
    variableTotal: freeVarMonthly * freeUsers + paidVarMonthly * paidUsers,
    totalMonthly: freeVarMonthly * freeUsers + paidVarMonthly * paidUsers + computeCost + fixedMonthly,
  }

  // --- revenue / margin per payer, per payment adapter ---
  const p = config.pricing
  const grossPerPayerMonthly = p.yearlyShare * (p.yearlyPrice / 12) + (1 - p.yearlyShare) * p.monthlyPrice
  const chargesPerPayerMonth = p.yearlyShare * (1 / 12) + (1 - p.yearlyShare) * 1
  const payers = config.payments.adapters.map(a => {
    const net = grossPerPayerMonthly * (1 - config.payments.refundRate) * (1 - config.payments.taxRate)
    const pct = price(a.percentFee)
    const fixed = price(a.fixedPerCharge)
    const paymentCost = net * pct + chargesPerPayerMonth * fixed
    const contribution = net - paymentCost - paidFullyLoaded
    return {
      adapter: a.name,
      percentFee: pct, fixedPerCharge: fixed,
      grossPerPayerMonthly, chargesPerPayerMonth,
      netPerPayerMonthly: net, paymentCostPerPayerMonthly: paymentCost,
      contributionPerPayerMonthly: contribution,
      marginPct: net > 0 ? contribution / net : null,
    }
  })
  const primary = payers[0]

  // --- break-even (primary adapter): fixedRemaining already IS (compute + fixed +
  // free-user pure-variable drag) because paid users' own variable cost cancels
  // out of totalMonthly; each side's compute share is charged exactly once via
  // the contribution denominator ---
  const fixedRemaining = totals.totalMonthly - paidUsers * paidVarMonthly
  const breakEvenPaidUsers = primary.contributionPerPayerMonthly > 0
    ? ceilPositive(fixedRemaining / primary.contributionPerPayerMonthly)
    : null

  // --- growth projections (full steady-state storage at target MAU: conservative
  // upper bound — fresh cohorts do not yet carry retention-months of history) ---
  const project = months => {
    const g = config.growth.monthly
    const mauM = mau * Math.pow(1 + g, months)
    const cfg = months === 0 ? config : mergeDeep(config, { users: { mau: mauM } })
    const e = computeEconomics(cfg, { withScenarios: false })
    return { month: months, mau: mauM, totalMonthly: e.totals.totalMonthly, multiple: e.totals.totalMonthly / totals.totalMonthly }
  }
  const growth = withScenarios ? { month12: project(12), month36: project(36) } : null

  // --- sensitivity: cost-price inputs move totals; revenue-side inputs (payment
  // fee) move the break-even point instead — both are reported per dimension ---
  const SENSITIVITY_PATHS = [
    ['db.pricePerGbMonth.value', 'db storage price'],
    ['object.pricePerGbMonth.value', 'object storage price'],
    ['relayEgress.pricePerGb.value', 'relay egress price'],
    ['compute.instanceMonthly.value', 'compute instance price'],
    ['payments.adapters.0.percentFee.value', 'payment % fee'],
  ]
  const sensitivity = withScenarios ? SENSITIVITY_PATHS.map(([path, label]) => {
    const base = getIn(config, path)
    if (base == null) return { path, label, base: null, notModeled: true }
    const at = factor => {
      const e2 = computeEconomics(setIn(config, path, base * factor), { withScenarios: false })
      return {
        totalMonthly: e2.totals.totalMonthly,
        contributionPerPayerMonthly: e2.revenue[0].contributionPerPayerMonthly,
        breakEvenPaidUsers: e2.breakEvenPaidUsers,
      }
    }
    return { path, label, base, atHalf: at(0.5), atDouble: at(2.0), notModeled: false }
  }) : null

  // --- scenarios ---
  const u = config.usage
  const SCENARIOS = {
    neutral: {},
    pessimistic: {
      users: { paidShare: paidShare * 0.5 },
      usage: { changesPerDeviceActiveDay: u.changesPerDeviceActiveDay * 1.5, payloadBytesPerChange: u.payloadBytesPerChange * 1.5 },
      growth: { monthly: config.growth.monthly * 0.5 },
    },
    heavy: {
      usage: { changesPerDeviceActiveDay: u.changesPerDeviceActiveDay * 3, payloadBytesPerChange: u.payloadBytesPerChange * 2, devicesPerUser: u.devicesPerUser + 1 },
    },
  }
  const scenarios = withScenarios
    ? Object.fromEntries(Object.entries(SCENARIOS).map(([name, patch]) => {
        const e = computeEconomics(mergeDeep(config, patch), { withScenarios: false })
        return [name, {
          totalMonthly: e.totals.totalMonthly,
          storageDbGb: e.totals.storageDbGb,
          storageColdGb: e.totals.storageColdGb,
          contributionPerPayerMonthly: e.revenue[0].contributionPerPayerMonthly,
          marginPct: e.revenue[0].marginPct,
          breakEvenPaidUsers: e.breakEvenPaidUsers,
        }]
      }))
    : null

  // --- NOT-MODELED warnings: totals are incomplete until these are resolved ---
  const warnings = []
  for (const [track, reqs] of [['db', config.db.requests]]) {
    for (const [dir, entry] of Object.entries(reqs)) {
      if (isNotModeled(entry)) warnings.push(`${track}.${dir}: ${entry.source.url}`)
    }
  }
  if (totals.quotaOverrunPct > 0) warnings.push(`relay egress exceeds included VPS quota by ${(totals.quotaOverrunPct * 100).toFixed(0)}% (billed via relayEgress.pricePerGb)`)
  for (const f of config.fixed) {
    if (typeof f.source?.url === 'string' && f.source.url.startsWith('ASSUMPTION')) warnings.push(`fixed cost "${f.name}" is an unsourced assumption`)
  }
  for (const [name, entry] of [['compute.instanceMonthly', config.compute.instanceMonthly], ['relayEgress.pricePerGb', config.relayEgress.pricePerGb], ['db.pricePerGbMonth', config.db.pricePerGbMonth]]) {
    if (typeof entry?.source?.url === 'string' && entry.source.url.startsWith('ASSUMPTION')) warnings.push(`${name} is an unsourced assumption (${entry.unit})`)
  }

  return {
    currency: config.currency,
    perUser: {
      free: { usage: { devices: free.devices, changesPerMonth: free.changesPerMonth, fanout: free.fanout }, cost: free.lines },
      paid: { usage: { devices: paid.devices, changesPerMonth: paid.changesPerMonth, fanout: paid.fanout }, cost: paid.lines },
      computePerUserMonthly: computePerUser,
    },
    revenue: payers,
    totals,
    breakEvenPaidUsers,
    warnings, growth, sensitivity, scenarios,
  }
}
