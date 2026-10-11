/**
 * Price provenance rules: nothing without a real source URL + verification date
 * may leave the building as a "quote". tools/cost-model/price-source.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, verified, assumption, notModeled, setIn } from '../../../tools/cost-model/cost-model.mjs'
import { collectPriceEntries, classifyEntry, auditSources, assertQuotable } from '../../../tools/cost-model/price-source.mjs'

test('default config: every entry classified; nothing missing; verified set non-empty', () => {
  const audit = auditSources(defaultConfig())
  assert.equal(audit.missing.length, 0)
  assert.ok(audit.verified.length >= 7, `expected R2 x4 + Workers + Creem + Paddle verified, got ${audit.verified.length}`)
  assert.ok(audit.assumption.length >= 3, 'VPS price / relay egress / DB volume are honest assumptions')
  assert.ok(audit.notModeled.length >= 2, 'D1 row billing is explicitly not modeled')
})

test('classification rules', () => {
  assert.equal(classifyEntry(verified(1, 'x', 'https://a.b/c')), 'verified')
  assert.equal(classifyEntry(verified(1, 'x', 'https://a.b/c', '2026-01-02')), 'verified')
  assert.equal(classifyEntry(assumption(1, 'x')), 'assumption')
  assert.equal(classifyEntry(verified(1, 'x', 'ASSUMPTION: not real')), 'assumption')
  assert.equal(classifyEntry(notModeled('x', 'because')), 'notModeled')
  assert.equal(classifyEntry({ value: 1, unit: 'x' }), 'missing')
  assert.equal(classifyEntry({ value: 1, unit: 'x', source: { url: 'ftp://nope', verifiedAt: '2026-10-10' } }), 'missing')
  assert.equal(classifyEntry({ value: 1, unit: 'x', source: { url: 'https://ok', verifiedAt: 'whenever' } }), 'missing')
})

test('collectPriceEntries walks nested + arrayed price nodes', () => {
  const config = defaultConfig()
  const entries = collectPriceEntries(config)
  const paths = entries.map(e => e.path)
  assert.ok(paths.includes('object.pricePerGbMonth'))
  assert.ok(paths.some(p => p.startsWith('payments.adapters[0]')), JSON.stringify(paths))
  assert.ok(paths.includes('compute.instanceMonthly'))
})

test('assertQuotable throws on the default config (assumptions present) and passes on an all-verified one', () => {
  assert.throws(() => assertQuotable(defaultConfig()), /PRICE_SOURCE_MISSING|cannot produce an external quote/)
  const clean = setIn(setIn(setIn(defaultConfig(),
    'compute.instanceMonthly', verified(10, 'USD/mo', 'https://vps.example/pricing')),
    'relayEgress.pricePerGb', verified(0.05, 'USD/GB', 'https://vps.example/traffic')),
    'db.pricePerGbMonth', verified(0.1, 'USD/GB-mo', 'https://vps.example/volume'))
  const cleaned = JSON.parse(JSON.stringify(clean))
  // strip every remaining assumption / not-modeled entry into verified placeholders
  for (const { path } of collectPriceEntries(cleaned)) {
    const entry = path.split('.').reduce((o, k) => o?.[k], cleaned)
    if (entry && entry.value != null && entry.source?.url?.startsWith('ASSUMPTION')) {
      entry.source = { url: 'https://ops.example/internal-approved', verifiedAt: '2026-10-10' }
    }
  }
  // not-modeled entries (null values) are allowed: they are excluded from totals, not quoted
  const audit = assertQuotable(cleaned)
  assert.equal(audit.assumption.length, 0)
  assert.equal(audit.missing.length, 0)
})
