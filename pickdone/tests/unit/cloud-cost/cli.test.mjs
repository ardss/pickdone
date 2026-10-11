/**
 * CLI contract tests for tools/cost-model/cost-cli.mjs â€?in-process run() with
 * captured output (no child processes, no locale dependence).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../../tools/cost-model/cost-cli.mjs'
import { defaultConfig } from '../../../tools/cost-model/cost-model.mjs'

function capture(argv) {
  const out = []
  const err = []
  const code = run(argv, { stdout: s => out.push(s), stderr: s => err.push(s) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

test('table output renders headline numbers and provenance disclaimer', () => {
  const { code, out } = capture([])
  assert.equal(code, 0)
  assert.match(out, /PickDone cloud cost model/)
  assert.match(out, /Break-even paid users/)
  assert.match(out, /PUBLIC LIST transcriptions/)
  assert.match(out, /NOT MODELED/, 'D1 row billing must be surfaced in every default report')
  assert.match(out, /VPS/, 'compute must be presented as a VPS, never Workers')
})

test('json output parses and carries economics + provenance counts', () => {
  const { code, out } = capture(['--format', 'json'])
  assert.equal(code, 0)
  const parsed = JSON.parse(out)
  assert.equal(parsed.scenario, 'neutral')
  assert.ok(parsed.totals.totalMonthly > 0)
  assert.equal(parsed.provenance.missing, 0)
  assert.ok(parsed.provenance.verified >= 7)
  assert.ok(parsed.warnings.length >= 1)
  assert.ok(parsed.growth.month36.mau > parsed.growth.month12.mau)
})

test('--mau override flows through', () => {
  const base = JSON.parse(capture(['--format', 'json']).out)
  const bigger = JSON.parse(capture(['--format', 'json', '--mau', '50000']).out)
  assert.equal(bigger.totals.mau, 50000)
  assert.ok(bigger.totals.totalMonthly > base.totals.totalMonthly)
})

test('scenarios switch; unknown scenario exits 2', () => {
  assert.match(capture(['--scenario', 'heavy']).out, /Heavy/)
  assert.match(capture(['--scenario', 'pessimistic']).out, /Pessimistic/)
  const bad = capture(['--scenario', 'nope'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /unknown scenario/)
})

test('--quote refuses while assumptions exist; passes once all entries are sourced', () => {
  const refused = capture(['--quote'])
  assert.equal(refused.code, 3)
  assert.match(refused.err, /QUOTE REFUSED/)
  assert.match(refused.err, /assumption/)
  // all-verified config on disk -> quote allowed (verified DO reference fills compute)
  const dir = mkdtempSync(join(tmpdir(), 'cloud-cost-quote-'))
  const file = join(dir, 'config.json')
  const config = defaultConfig()
  config.compute.instanceMonthly = { value: 6, unit: 'USD/mo (DO Basic 1GiB list)', source: { url: 'https://www.digitalocean.com/pricing/droplets', verifiedAt: '2026-10-10' } }
  config.relayEgress.pricePerGb = { value: 0.01, unit: 'USD/GB', source: { url: 'https://www.digitalocean.com/pricing/droplets', verifiedAt: '2026-10-10' } }
  config.db.pricePerGbMonth = { value: 0, unit: 'USD/GB-mo (droplet disk covers it)', source: { url: 'https://www.digitalocean.com/pricing/droplets', verifiedAt: '2026-10-10' } }
  config.fixed = config.fixed.map(f => f.source.url.startsWith('ASSUMPTION')
    ? { ...f, monthly: 0, source: { url: 'https://ops.example/none-yet', verifiedAt: '2026-10-10' } } : f)
  writeFileSync(file, JSON.stringify(config))
  const ok = capture(['--quote', '--config', file])
  assert.equal(ok.code, 0, ok.err)
})

test('totals never silently include the optional Workers plan', () => {
  const parsed = JSON.parse(capture(['--format', 'json']).out)
  assert.equal(parsed.totals.fixedMonthly, 0, 'Workers Paid stays out of totals until decided')
  assert.ok(JSON.stringify(parsed.warnings).match(/unsourced assumption|NOT MODELED|quota/) !== null)
})
