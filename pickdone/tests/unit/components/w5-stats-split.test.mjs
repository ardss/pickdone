/**
 * W5 S1 pilot: StatisticsView.vue (1127 lines) split into statistics/ subcomponents.
 * Source-level anchors pinning the split contract (same paradigm as w1/w2 tests):
 *   - chart shaping lives in the pure module chartModels.js (no component state, injected translator)
 *   - share dialog + achievements wall moved verbatim into StatsShareCard/StatsAchievements
 *   - the parent keeps URL-query sync, the page-root hover tips (fixed-position transform trap),
 *     and the shared EmptyState usage (untouched by the split)
 *   - i18n keys stay in the statsA.* shard: the pure module only emits key strings via injected t()
 *
 * Run: node --test tests/unit/components/w5-stats-split.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const parent = read('renderer/js/views/StatisticsView.vue')
const share = read('renderer/js/views/statistics/StatsShareCard.vue')
const ach = read('renderer/js/views/statistics/StatsAchievements.vue')
const models = read('renderer/js/views/statistics/chartModels.js')

test('w5 stats: chart shaping extracted as a pure module with an injected translator (no component imports)', () => {
  assert.ok(!models.includes('<template>'), 'chartModels.js must be a plain module, no SFC markup')
  assert.ok(models.includes('export function periodBounds'))
  assert.ok(models.includes('export function buildHeatmap'))
  assert.ok(models.includes('export function countGiveUps7'))
  assert.ok(models.includes('export function buildWeekdayModel'))
  assert.ok(models.includes('export function buildTrendModel'))
  assert.ok(models.includes('export function buildFocusTrendModel'))
  assert.ok(models.includes('export function buildTimelineRows'))
  // i18n stays at the template/computed layer: the module receives t(key, params) instead of $t
  assert.ok(!models.includes('$t('), 'chartModels.js must not call $t directly — translator is injected')
  assert.ok(models.includes('statsA.StatisticsView.'), 'keys stay in the statsA shard')
})

test('w5 stats: parent computeds delegate to the pure module', () => {
  assert.match(parent, /periodBounds \(\) \{\s*\n?\s*return periodBounds\(this\.period/)
  assert.match(parent, /heatmap \(\) \{\s*\n?\s*return buildHeatmap\(/)
  assert.match(parent, /timelineRows \(\) \{\s*\n?\s*return buildTimelineRows\(/)
  assert.match(parent, /return buildWeekdayModel\(this\.metrics/)
  assert.match(parent, /return buildTrendModel\(this\.metrics/)
  assert.match(parent, /return buildFocusTrendModel\(this\.metrics/)
  assert.match(parent, /giveUps7 \(\) \{ return countGiveUps7\(this\.tomatoRecordList\) \}/)
})

test('w5 stats: share dialog moved verbatim into StatsShareCard.vue; parent only wires props + close', () => {
  for (const cls of ['share-style-tabs', 'sc sc-narrative', 'sc sc-data', 'sc sc-mini', 'sc-kpis', 'share-dialog__foot', 'share-save']) {
    assert.ok(share.includes(cls), `StatsShareCard must carry .${cls}`)
  }
  assert.ok(!parent.includes('class="share-style-tabs"'), 'share markup must not remain in the parent')
  assert.match(parent, /<stats-share-card :open="shareOpen" @close="shareOpen=false"/)
  // export logic (html2canvas lazy load) lives in the child now
  assert.ok(share.includes('loadScript(VENDOR.html2canvas)'))
  assert.ok(!parent.includes('saveShareCard'))
})

test('w5 stats: achievements wall moved verbatim into StatsAchievements.vue', () => {
  for (const cls of ['ach-card', 'ach-totals', 'ach-total__v', 'ach-fams', 'ach-fam__badges', 'ach-progress__bar']) {
    assert.ok(ach.includes(cls), `StatsAchievements must carry .${cls}`)
  }
  assert.ok(!parent.includes('class="tl-card ach-card"'), 'achievements markup must not remain in the parent')
  assert.match(parent, /<stats-achievements :achievements="achievements"\/>/)
  // key fallback chain preserved verbatim
  assert.ok(ach.includes("$t(f.nextNameKey || 'statsA.Achievements.achMax')"))
})

test('w5 stats: hover tips stay mounted at the parent page root (.page transform hijacks fixed inside cards)', () => {
  assert.match(parent, /<div v-show="hmTip\.show" ref="hmTip" class="hm-tip"/)
  assert.match(parent, /<div v-if="tlTip" ref="tlTip" class="tl-tip"/)
  // they sit at the .view-page root, after .page closes (guarded by the mount-point comment)
  assert.match(parent, /Heatmap\/timeline hover tips: mounted at the page root/)
  const tpl = parent.match(/<template>[\s\S]*<\/template>/)[0]
  const pageClose = tpl.lastIndexOf('</div>')
  const hmTipIdx = tpl.indexOf('<div v-show="hmTip.show"')
  const tlTipIdx = tpl.indexOf('<div v-if="tlTip"')
  assert.ok(hmTipIdx > 0 && tlTipIdx > hmTipIdx && pageClose > tlTipIdx,
    'tips must be the last children of the template root (after .page)')
})

test('w5 stats: URL query sync stays in the parent; EmptyState usage untouched', () => {
  assert.match(parent, /syncQuery \(\) \{/)
  assert.match(parent, /this\.\$router\.replace\(\{ query: q \}\)/)
  assert.match(parent, /<empty-state v-if="!hasAnyData"><template #text>/)
})

test('w5 stats: parent registered the new components', () => {
  assert.match(parent, /components: \{ ChartCard, EmptyState, StatsShareCard, StatsAchievements \}/)
})
