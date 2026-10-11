#!/usr/bin/env node
/**
 * PickDone cloud cost CLI.
 *
 *   node tools/cost-model/cost-cli.mjs [--scenario neutral|pessimistic|heavy]
 *       [--format table|json] [--mau N] [--paid-share 0.08] [--growth 0.05]
 *       [--config path/to/config.json] [--quote]
 *
 * Read-only calculator: touches nothing but its own arguments. --quote refuses
 * to emit anything unless every price entry carries a real source URL + date
 * (assumption-class entries fail it by design — see price-source.mjs).
 */
import { readFileSync } from 'node:fs'
import { defaultConfig, computeEconomics, mergeDeep } from './cost-model.mjs'
import { applyScenario, SCENARIOS } from './scenarios.mjs'
import { auditSources, assertQuotable } from './price-source.mjs'

function parseArgs(argv) {
  const arg = (name, fallback = undefined) => {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return fallback
    const v = argv[i + 1]
    return v && !v.startsWith('--') ? v : true
  }
  return {
    scenario: arg('scenario', 'neutral'),
    format: arg('format', 'table'),
    config: arg('config', null),
    quote: !!arg('quote', false),
    overrides: {
      ...(arg('mau') ? { users: { mau: Number(arg('mau')) } } : {}),
      ...(arg('paid-share') ? { users: { paidShare: Number(arg('paid-share')) } } : {}),
      ...(arg('growth') ? { growth: { monthly: Number(arg('growth')) } } : {}),
    },
  }
}

function loadConfig(opts) {
  let config = defaultConfig()
  if (opts.config) config = mergeDeep(config, JSON.parse(readFileSync(opts.config, 'utf8')))
  if (Object.keys(opts.overrides).length) config = mergeDeep(config, opts.overrides)
  return config
}

// ---------- table rendering ----------

const money = (v, cur) => v == null ? 'n/a' : `${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4)} ${cur}`
const gb1 = v => v == null ? 'n/a' : `${v.toFixed(1)} GB`

function renderTable(e, label, cur) {
  const L = []
  const push = s => L.push(s)
  push(`PickDone cloud cost model — ${label}`)
  push(`currency: ${cur} | prices are PUBLIC LIST transcriptions + flagged assumptions; see provenance below`)
  push('')
  push(`MAU ${e.totals.mau.toLocaleString('en-US')} (paid ${e.totals.paidUsers.toFixed(0)} / free ${e.totals.freeUsers.toFixed(0)}) | devices ${e.totals.devices.toFixed(0)} | peak conn ${e.totals.peakConcurrent.toFixed(0)} -> ${e.totals.instances} instance(s)`)
  push(`storage: db ${gb1(e.totals.storageDbGb)} | object ${gb1(e.totals.storageObjectGb)} | cold ${gb1(e.totals.storageColdGb)} | backup ${gb1(e.totals.storageBackupGb)}`)
  push(`relay egress ${gb1(e.totals.relayEgressGbTotal)}/mo vs included quota ${gb1(e.totals.relayEgressQuotaGb)}${e.totals.quotaOverrunPct > 0 ? ` (OVERRUN +${(e.totals.quotaOverrunPct * 100).toFixed(0)}%)` : ''}`)
  push('')
  push('Per-user per-month:')
  for (const tier of ['free', 'paid']) {
    const pu = e.perUser[tier]
    push(`  ${tier.padEnd(5)} devices=${pu.usage.devices} changes=${pu.usage.changesPerMonth.toFixed(0)} fanout=${pu.usage.fanout}`)
    push(`        pure variable ${money(pu.cost.pureVariable, cur)} (storage ${money(pu.cost.storage, cur)} + network ${money(pu.cost.network, cur)})`)
  }
  push(`  compute amortized ${money(e.perUser.computePerUserMonthly, cur)}/user`)
  push('')
  push('Revenue per paid user per month:')
  for (const r of e.revenue) {
    push(`  [${r.adapter}] gross ${money(r.grossPerPayerMonthly, cur)} -> net ${money(r.netPerPayerMonthly, cur)} | fee ${money(r.paymentCostPerPayerMonthly, cur)} | contribution ${money(r.contributionPerPayerMonthly, cur)} (margin ${(r.marginPct * 100).toFixed(1)}%)`)
  }
  push('')
  push(`Totals/month: variable ${money(e.totals.variableTotal, cur)} + compute ${money(e.totals.computeCost, cur)} + fixed ${money(e.totals.fixedMonthly, cur)} = ${money(e.totals.totalMonthly, cur)}`)
  push(`Break-even paid users (primary adapter): ${e.breakEvenPaidUsers == null ? 'never (contribution <= 0)' : e.breakEvenPaidUsers.toLocaleString('en-US')}`)
  if (e.growth) {
    push('')
    push('Growth (full steady-state storage at target MAU = conservative upper bound):')
    for (const g of [e.growth.month12, e.growth.month36]) {
      push(`  month ${String(g.month).padStart(2)}: MAU ${Math.round(g.mau).toLocaleString('en-US')} -> ${money(g.totalMonthly, cur)}/mo (${g.multiple.toFixed(2)}x today)`)
    }
  }
  if (e.sensitivity) {
    push('')
    push('Sensitivity (x0.5 .. x2.0 of the input price):')
    for (const s of e.sensitivity) {
      if (s.notModeled) { push(`  ${s.label.padEnd(24)} NOT MODELED — excluded from totals`); continue }
      push(`  ${s.label.padEnd(24)} total ${money(s.atHalf.totalMonthly, cur)} .. ${money(s.atDouble.totalMonthly, cur)} | break-even ${s.atHalf.breakEvenPaidUsers?.toLocaleString('en-US')} .. ${s.atDouble.breakEvenPaidUsers?.toLocaleString('en-US')}`)
    }
  }
  if (e.scenarios) {
    push('')
    push('Scenarios:')
    for (const [name, s] of Object.entries(e.scenarios)) {
      push(`  ${name.padEnd(12)} total ${money(s.totalMonthly, cur)}/mo | contribution/payer ${money(s.contributionPerPayerMonthly, cur)} | break-even ${s.breakEvenPaidUsers ?? 'never'}`)
    }
  }
  if (e.warnings.length) {
    push('')
    push('NOT MODELED / ASSUMED (totals are NOT complete until resolved):')
    for (const w of e.warnings) push(`  ! ${w}`)
  }
  return L.join('\n')
}

// ---------- entry ----------

export function run(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error } = {}) {
  const opts = parseArgs(argv)
  if (!SCENARIOS[opts.scenario]) {
    stderr(`unknown scenario "${opts.scenario}" (have: ${Object.keys(SCENARIOS).join(', ')})`)
    return 2
  }
  let config
  try {
    config = loadConfig(opts)
  } catch (err) {
    stderr(`config load failed: ${err.message}`)
    return 2
  }
  if (opts.quote) {
    try {
      assertQuotable(config)
    } catch (err) {
      stderr(`QUOTE REFUSED: ${err.message}`)
      return 3
    }
  }
  const { config: scoped, label } = applyScenario(config, opts.scenario)
  const e = computeEconomics(scoped)
  if (opts.format === 'json') {
    const audit = auditSources(scoped)
    stdout(JSON.stringify({
      scenario: opts.scenario, label,
      provenance: { verified: audit.verified.length, assumption: audit.assumption.length, missing: audit.missing.length, notModeled: audit.notModeled.length },
      ...e,
    }, null, 2))
  } else {
    stdout(renderTable(e, label, scoped.currency))
  }
  return 0
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  process.exit(run())
}
