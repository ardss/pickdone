/**
 * F5 wave: CSV formula-injection neutralization for the statistics export.
 * Regression tests for the pure helper extracted to views/statistics/csv.js
 * (OWASP CSV Injection: cells starting with = + - @ tab CR must be neutralized).
 *
 * Run: node --test tests/unit/components/f5-stats-csv-injection.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const { neutralizeCsvCell, csvField } = await import('../../../renderer/js/views/statistics/csv.js')

test('f5 csv: dangerous formula prefixes are neutralized with a leading quote', () => {
  for (const dangerous of ['=SUM(A1:A2)', '+1+cmd', '-2+3', '@SUM(1)', '\tcmd', '\rfix']) {
    const out = neutralizeCsvCell(dangerous)
    assert.ok(out.startsWith("'"), `${JSON.stringify(dangerous)} must be neutralized`)
    assert.ok(out.includes(dangerous.trim()), 'original content preserved after the guard quote')
  }
})

test('f5 csv: benign text and numbers pass through untouched', () => {
  assert.equal(neutralizeCsvCell('buy milk'), 'buy milk')
  assert.equal(neutralizeCsvCell('2026-09-15 done 3 items'), '2026-09-15 done 3 items') // only LEADING -/= is dangerous
  assert.equal(neutralizeCsvCell(42), '42')
  assert.equal(neutralizeCsvCell(''), '')
  assert.equal(neutralizeCsvCell(null), '')
  assert.equal(neutralizeCsvCell(undefined), '')
})

test('f5 csv: csvField still quotes and doubles embedded quotes', () => {
  assert.equal(csvField('he said "hi"'), '"he said ""hi"""')
  assert.equal(csvField('=cmd|\' /C calc!\'A1'), '"\'=cmd|\' /C calc!\'A1"')
  assert.equal(csvField('=1+1'), '"\'=1+1"')
})

test('f5 csv: StatisticsView export path uses csvField (no raw inline quoting left)', () => {
  const view = readFileSync(path.join(ROOT, 'renderer/js/views/StatisticsView.vue'), 'utf8')
  assert.match(view, /import \{ csvField \} from '\.\/statistics\/csv\.js'/)
  assert.match(view, /r\.map\(c => csvField\(c\)\)/)
  assert.ok(!view.includes("r.map(c => '\"' + String(c == null ? '' : c)"), 'old unguarded inline quoting must be gone')
})
