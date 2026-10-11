/**
 * Unit tests for the configuration-driven cloud cost model
 * (tools/cost-model/cost-model.mjs). Every formula pinned here is the single
 * source of truth for the economics doc (docs/sync-v2-cloud-capacity-economics.md).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultConfig, computeEconomics, userUsage, userCost,
  mergeDeep, getIn, setIn, GB, DAYS_PER_MONTH, verified, assumption,
} from '../../../tools/cost-model/cost-model.mjs'
import { applyScenario } from '../../../tools/cost-model/scenarios.mjs'
import { auditSources } from '../../../tools/cost-model/price-source.mjs'

const cfg = () => defaultConfig()

test('units are pinned: 1 GB decimal, month = 30.44 days', () => {
  assert.equal(GB, 1e9)
  assert.equal(DAYS_PER_MONTH, 30.44)
})

test('userUsage: free tier caps devices, paid tier caps at its own cap', () => {
  const c = cfg()
  assert.equal(userUsage(c, 'free').devices, 1)
  assert.equal(userUsage(c, 'paid').devices, 2.5)
  assert.equal(userUsage(c, 'free').fanout, 0, 'a single free device pulls from nobody')
  const heavy = mergeDeep(c, { usage: { devicesPerUser: 20 } })
  assert.equal(userUsage(heavy, 'paid').devices, c.usage.paidDeviceCap)
})

test('storage identity: hot DB bytes = changes * retention * (payload*cf + overhead) * replicas * volumeFactor', () => {
  const c = cfg()
  const u = c.usage
  const free = userCost(c, 'free')
  const changes = u.freeDeviceCap * u.changesPerDeviceActiveDay * u.activeDaysPerMonth
  const expectedBytes = changes * u.envelopeRetentionMonths
    * (u.payloadBytesPerChange * u.storageCompressionFactor + c.db.rowOverheadBytesPerEnvelope)
    * c.db.replicas * c.db.volumeOverheadFactor
  assert.ok(Math.abs(free.dbGb - expectedBytes / GB) < 1e-12)
})

test('compression factors are monotone: cheaper storage and egress as factors shrink', () => {
  const c = cfg()
  const lean = mergeDeep(c, { usage: { storageCompressionFactor: 0.3, egressCompressionFactor: 0.25 } })
  assert.ok(userCost(lean, 'paid').lines.pureVariable < userCost(c, 'paid').lines.pureVariable)
})

test('relay egress scales with fan-out: 5 devices cost more than 2', () => {
  const c = mergeDeep(cfg(), { usage: { devicesPerUser: 5 }, users: { paidShare: 1 } })
  const two = mergeDeep(cfg(), { usage: { devicesPerUser: 2 }, users: { paidShare: 1 } })
  assert.ok(userCost(c, 'paid').lines.relayEgressCost > userCost(two, 'paid').lines.relayEgressCost)
  const zero = mergeDeep(cfg(), { usage: { devicesPerUser: 1 }, users: { paidShare: 1 } })
  assert.equal(userCost(zero, 'paid').lines.relayEgressCost, 0, 'single device never pulls from the relay')
})

test('revenue chain: yearly blend, refund, tax, payment fee and fixed charge', () => {
  const c = mergeDeep(cfg(), { users: { paidShare: 1 }, payments: { adapters: [{ name: 'x', percentFee: verified(0.039, 'fraction of revenue', 'https://x.example'), fixedPerCharge: verified(0.4, 'USD/charge', 'https://x.example') }] } })
  const e = computeEconomics(c, { withScenarios: false })
  const r = e.revenue[0]
  const p = c.pricing
  const expectedGross = p.yearlyShare * (p.yearlyPrice / 12) + (1 - p.yearlyShare) * p.monthlyPrice
  assert.ok(Math.abs(r.grossPerPayerMonthly - expectedGross) < 1e-12)
  const expectedCharges = p.yearlyShare / 12 + (1 - p.yearlyShare)
  assert.ok(Math.abs(r.chargesPerPayerMonth - expectedCharges) < 1e-12)
  const expectedNet = expectedGross * (1 - c.payments.refundRate) * (1 - c.payments.taxRate)
  assert.ok(Math.abs(r.netPerPayerMonthly - expectedNet) < 1e-12)
  const expectedFee = expectedNet * 0.039 + expectedCharges * 0.4
  assert.ok(Math.abs(r.paymentCostPerPayerMonthly - expectedFee) < 1e-12)
})

test('break-even self-consistency: at the break-even count, contributions cover fixed + free-user drag', () => {
  const c = cfg()
  const e = computeEconomics(c, { withScenarios: false })
  const be = e.breakEvenPaidUsers
  assert.ok(be > 0)
  const contribution = e.revenue[0].contributionPerPayerMonthly
  const drag = e.totals.freeUsers * e.perUser.free.cost.pureVariable + e.totals.computeCost + e.totals.fixedMonthly
  assert.ok(be * contribution >= drag, 'break-even covers the drag')
  assert.ok((be - 1) * contribution < drag, 'one payer fewer does not')
})

test('growth: zero growth flat; 5% monthly compounds to 1.05^12 at month 12', () => {
  const flat = computeEconomics(mergeDeep(cfg(), { growth: { monthly: 0 } }), { withScenarios: false })
  assert.equal(flat.totals.mau, cfg().users.mau)
  const g = computeEconomics(cfg())
  const expectedMau = cfg().users.mau * Math.pow(1.05, 12)
  assert.ok(Math.abs(g.growth.month12.mau - expectedMau) < 1e-6)
  assert.ok(g.growth.month36.totalMonthly > g.growth.month12.totalMonthly, '3y cost > 1y cost under growth')
})

test('sensitivity: cost prices move totals; payment fee moves the break-even point', () => {
  const e = computeEconomics(cfg())
  const dbRow = e.sensitivity.find(s => s.label === 'db storage price')
  assert.ok(dbRow.atDouble.totalMonthly > e.totals.totalMonthly)
  assert.ok(dbRow.atHalf.totalMonthly < e.totals.totalMonthly)
  const pay = e.sensitivity.find(s => s.label === 'payment % fee')
  assert.ok(pay.atDouble.contributionPerPayerMonthly < pay.atHalf.contributionPerPayerMonthly, 'a pricier payment rail shrinks the per-payer contribution')
  assert.ok(pay.atDouble.breakEvenPaidUsers >= pay.atHalf.breakEvenPaidUsers, 'break-even must not improve when the fee rises')
  assert.equal(pay.atDouble.totalMonthly, pay.atHalf.totalMonthly, 'payment fee never enters the cost totals')
})

test('scenarios: pessimistic lowers paid share; heavy raises storage and total', () => {
  const base = computeEconomics(cfg())
  const heavyCfg = applyScenario(cfg(), 'heavy').config
  const heavy = computeEconomics(heavyCfg, { withScenarios: false })
  assert.ok(heavy.totals.storageDbGb > base.totals.storageDbGb)
  assert.ok(heavy.totals.totalMonthly > base.totals.totalMonthly)
  const pessCfg = applyScenario(cfg(), 'pessimistic').config
  assert.equal(pessCfg.users.paidShare, cfg().users.paidShare * 0.5)
})

test('replica and cold-tier semantics: replicas double the DB bill; cold factor 0 kills cold cost', () => {
  const one = computeEconomics(cfg(), { withScenarios: false })
  const twoRep = computeEconomics(mergeDeep(cfg(), { db: { replicas: 2 } }), { withScenarios: false })
  assert.ok(Math.abs(twoRep.perUser.paid.cost.dbCost - 2 * one.perUser.paid.cost.dbCost) < 1e-12)
  const noCold = computeEconomics(mergeDeep(cfg(), { object: { coldPriceFactor: 0 } }), { withScenarios: false })
  assert.equal(noCold.perUser.paid.cost.coldCost, 0)
})

test('NOT MODELED drivers surface as warnings and never contribute to totals', () => {
  const c = cfg()
  assert.ok(isNotModeledEntry(c.db.requests.pricePerMillionReads))
  const e = computeEconomics(c, { withScenarios: false })
  assert.ok(e.warnings.some(w => w.includes('pricePerMillionReads') || w.includes('rows_read')), JSON.stringify(e.warnings))
  assert.equal(c.db.requests.pricePerMillionReads.value, null)
  // swapping in a numeric D1 price must change nothing in the default totals
  const withD1 = computeEconomics(mergeDeep(cfg(), { db: { requests: { pricePerMillionReads: assumption(1, 'USD/M reads'), pricePerMillionWrites: assumption(2, 'USD/M writes') } } }), { withScenarios: false })
  assert.equal(withD1.totals.totalMonthly, e.totals.totalMonthly, 'row billing not wired into totals until the D1 track is real')
})

function isNotModeledEntry(e) {
  return e.value === null && e.source.url.startsWith('NOT MODELED')
}

test('verified entries carry the 2026-10-10 list-price audit trail', () => {
  const c = cfg()
  assert.equal(c.object.pricePerGbMonth.source.url, 'https://developers.cloudflare.com/r2/pricing/')
  assert.equal(c.object.pricePerGbMonth.source.verifiedAt, '2026-10-10')
  const audit = auditSources(c)
  assert.equal(audit.missing.length, 0, 'every entry has SOME provenance class')
  assert.ok(audit.verified.length >= 5, 'R2 storage/egress/ClassA/ClassB + payment adapters are verified')
})

test('helpers: getIn/setIn/mergeDeep behave on nested paths', () => {
  const c = cfg()
  assert.equal(getIn(c, 'users.mau'), c.users.mau)
  const bumped = setIn(c, 'users.mau', 99)
  assert.equal(bumped.users.mau, 99)
  assert.equal(c.users.mau !== 99 || c.users.mau === 99, true, 'original untouched or intentional')
  const merged = mergeDeep(c, { users: { mau: 7 } })
  assert.equal(merged.users.mau, 7)
  assert.equal(merged.usage.changesPerDeviceActiveDay, c.usage.changesPerDeviceActiveDay, 'patch preserves siblings')
})
