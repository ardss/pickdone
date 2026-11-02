/* w29 P3 regression: statistics "most focused day" lied on zero data.
 *
 * Bug: buildWeekdayModel computed the summary as
 * `labels[focusByWeekday.indexOf(Math.max(...focusByWeekday))]` — with EVERY day at 0 focus
 * minutes, Math.max() === 0 and indexOf(0) === 0, so the dashboard claimed Monday was the day
 * with the most focus minutes. Fix: all-zero focus renders the dedicated i18n placeholder
 * (statsA.StatisticsView.weekdaySummaryEmpty) instead; a real maximum still resolves to its
 * weekday through the existing key. No hardcoded copy — the placeholder key must exist in BOTH
 * locale packs (en/zh parity).
 *
 * Run: node --test tests/unit/renderer/w29-weekday-zero-summary.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
globalThis.window = globalThis.window || { location: { hash: '' } }

const { buildWeekdayModel } = await import('../../../renderer/js/views/statistics/chartModels.js')

// translator stub: returns the KEY (plus the {d} interpolation marker) so assertions pin which
// i18n key the summary used — that is the user-visible string branch
const t = (key, params) => key + (params && params.d != null ? `[{d}=${params.d}]` : '')

const zeroModel = () => ({
  doneByWeekday: [0, 0, 0, 0, 0, 0, 0],
  focusByWeekday: [0, 0, 0, 0, 0, 0, 0]
})

test('P3: all-zero focus week does NOT claim Monday (or any day) as most-focused', () => {
  const m = buildWeekdayModel(zeroModel(), t)
  assert.ok(!m.summary.includes('statsA.StatisticsView.weekdaySummary['),
    'zero-data summary must not go through the named-day weekdaySummary branch')
  assert.equal(m.summary, 'statsA.StatisticsView.weekdaySummaryEmpty',
    'zero-data week renders the neutral empty-data placeholder')
})

test('P3: a real maximum still names its weekday (Wednesday)', () => {
  const m = buildWeekdayModel({
    doneByWeekday: [1, 0, 2, 0, 0, 0, 0],
    focusByWeekday: [10, 0, 45, 5, 0, 0, 0]
  }, t)
  assert.equal(m.summary, 'statsA.StatisticsView.weekdaySummary[{d}=statsA.StatisticsView.wd3]',
    'non-zero max resolves through weekdaySummary with the wd3 (Wednesday) label')
})

test('P3: ties keep first-max behavior but only when focus actually exists', () => {
  const m = buildWeekdayModel({
    doneByWeekday: [0, 0, 0, 0, 0, 0, 0],
    focusByWeekday: [0, 30, 0, 30, 0, 0, 0]
  }, t)
  assert.equal(m.summary, 'statsA.StatisticsView.weekdaySummary[{d}=statsA.StatisticsView.wd2]',
    'tie between real values resolves to the first of them (Tuesday), unchanged semantics')
})

test('P3: weekdaySummaryEmpty key exists in BOTH locale packs (i18n parity)', () => {
  for (const f of ['en-US-A.js', 'zh-CN-A.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'renderer/js/i18n/locales', f), 'utf8')
    assert.ok(src.includes('weekdaySummaryEmpty:'), `${f} is missing the weekdaySummaryEmpty key`)
  }
})
