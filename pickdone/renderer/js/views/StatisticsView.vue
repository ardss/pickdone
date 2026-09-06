<template>

  <div class="view-page stat-page">
    <div class="page">
      <div class="page__header page__header--no-shadow">
        <div class="title">
          <div class="title__prepend">
            <i class="icon-prepend"></i>
            <div class="title__text"> {{ $t('statsA.StatisticsView.pageTitle') }} </div>
          </div>
          <div class="title__append">
            <div class="stat-view-tabs" role="tablist" :aria-label="$t('statsA.StatisticsView.ariaReviewViews')">
              <button v-for="v in views" :key="v.key" class="stat-view-tab"
                      :class="{on: view===v.key}" role="tab" :aria-selected="view===v.key"
                      tabindex="0" @click="view=v.key" @keydown.enter.prevent="view=v.key">{{ v.text }}</button>
            </div>
            <button class="mini" @click="openShare"><app-icon name="pic" :size="13"/> {{ $t('statsA.StatisticsView.shareCreate') }}</button>
            <button class="mini" @click="exportTable"><app-icon name="file" :size="13"/> {{ $t('statsA.StatisticsView.exportTable') }}</button>
          </div>
        </div>
      </div>

      <!-- Share card dialog: three styles -->
      <el-dialog :title="$t('statsA.StatisticsView.shareCreate')" v-model="shareOpen" width="420px" append-to-body class="share-dialog">
        <div class="share-style-tabs" role="radiogroup" :aria-label="$t('statsA.StatisticsView.ariaCardStyles')">
          <button v-for="s in shareStyles" :key="s.key" class="hm-range-btn"
                  :class="{on: shareStyle===s.key}" role="radio" :aria-checked="shareStyle===s.key"
                  @click="shareStyle=s.key">{{ s.label }}</button>
        </div>
        <!-- Preview area (fixed light rendering; share appearance is theme-independent) -->
        <div ref="shareCard">
          <div v-if="shareStyle==='narrative'" class="sc sc-narrative">
            <div class="sc-brand">{{ $t('statsA.StatisticsView.shareBrand') }}</div>
            <div class="sc-period">{{ metrics.label }} · {{ periodRangeLabel }}</div>
            <p class="sc-headline">{{ reviewHeadline }}</p>
            <ul class="sc-list">
              <li v-for="i in shareTopInsights" :key="i.id">{{ insightText(i) }}</li>
            </ul>
            <div class="sc-foot">{{ shareDate }}</div>
          </div>
          <div v-else-if="shareStyle==='data'" class="sc sc-data">
            <div class="sc-brand">{{ $t('statsA.StatisticsView.shareBrand') }}</div>
            <div class="sc-period">{{ metrics.label }} · {{ periodRangeLabel }}</div>
            <div class="sc-kpis">
              <div v-for="k in kpis" :key="k.key" class="sc-kpi">
                <div class="sc-kpi__v">{{ k.value }}</div>
                <div class="sc-kpi__t">{{ k.title }}</div>
              </div>
            </div>
            <div class="sc-foot">{{ shareDate }}</div>
          </div>
          <div v-else class="sc sc-mini">
            <div class="sc-brand">{{ $t('statsA.StatisticsView.shareBrandMini') }}</div>
            <p class="sc-headline">{{ reviewHeadline }}</p>
            <div class="sc-mini__meta">{{ $t('statsA.StatisticsView.shareMiniMeta', { n: heatmap.streak, date: shareDate }) }}</div>
          </div>
        </div>
        <template #footer>
          <div class="share-dialog__foot">
            <button class="mini" @click="shareOpen=false">{{ $t('statsA.StatisticsView.cancel') }}</button>
            <button class="mini share-save" @click="saveShareCard">{{ $t('statsA.StatisticsView.saveImage') }}</button>
          </div>
        </template>
      </el-dialog>


      <div class="page__main">
        <div class="container">
          <div v-if="!hasAnyData" class="empty">
            <div class="empty__icon"></div>
            <div class="empty__text">{{ $t('statsA.StatisticsView.emptyState') }}</div>
          </div>

          <div v-else class="stat-subpage">
            <!-- Period switcher: segmented pills (shared by review and charts) -->
            <div v-if="view!=='ach'" class="stat-period-pills" role="radiogroup" :aria-label="$t('statsA.StatisticsView.ariaPeriod')">
              <button v-for="p in periodOptions" :key="p.key" class="stat-period-pill"
                      :class="{on: period===p.key}" role="radio" :aria-checked="period===p.key"
                      tabindex="0" @click="period=p.key" @keydown.enter.prevent="period=p.key">{{ p.label }}</button>
              <el-popover ref="rangePop" placement="bottom-end" :width="360" trigger="click" @show="initCustomDraft">
                <template #reference>
                  <span class="stat-period-range" :class="{custom: period==='custom'}" role="button" tabindex="0"
                        :title="$t('statsA.StatisticsView.customTitle')" aria-haspopup="dialog">{{ periodRangeLabel }}</span>
                </template>
                <!-- Custom range popover (finalized by user 2026-08-31: pops up directly, does not expand into a row): after applying, the whole page recomputes for the chosen range -->
                <div class="stat-custom-range" @keydown.enter.prevent="applyCustomRange">
                  <el-date-picker v-model="customDraft" type="daterange" value-format="YYYY-MM-DD"
                                  :clearable="false" unlink-panels teleported
                                  :start-placeholder="$t('statsA.StatisticsView.customStart')" :end-placeholder="$t('statsA.StatisticsView.customEnd')"/>
                  <div class="stat-custom-range__actions">
                    <button class="mini" @click="applyCustomRange">{{ $t('statsA.StatisticsView.customApply') }}</button>
                    <span v-if="customDraftDays > 366" class="stat-custom-warn">{{ $t('statsA.StatisticsView.customTooLong', { n: 366 }) }}</span>
                  </div>
                </div>
              </el-popover>
            </div>

            <template v-if="view!=='ach'">
            <!-- 2. KPI comparison bars -->
            <div class="kpi-row">
              <div v-for="k in kpis" :key="k.key" class="kpi-tile">
                <div class="kpi-tile__title">{{ k.title }}</div>
                <div class="kpi-tile__value">{{ k.value }}</div>
                <div class="kpi-tile__sub">
                  {{ k.sub }}
                  <span v-if="k.delta" class="kpi-delta" :class="deltaClass(k, k.delta)">{{ k.delta.pct }}</span>
                </div>
              </div>
            </div>

            <!-- Baseline comparison (factual insights, no suggestions) -->
            <div v-if="review.insights.length" class="tl-card">
            <div class="stat-hero__headline" v-if="reviewHeadline">{{ reviewHeadline }}</div>
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.reviewTag') }}</b></div>
              <ul class="review-card__list">
                <li v-for="i in review.insights" :key="i.id">
                  <span class="review-dot" aria-hidden="true"></span>
                  <span>{{ insightText(i) }}</span>
                </li>
              </ul>
            </div>

            <!-- Period bests -->
            <div class="tl-card best-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.bestsTitle') }}</b><span class="tl-sub">{{ $t('statsA.StatisticsView.bestsSub') }}</span></div>
              <div class="best-row">
                <div v-for="b in periodBests"  :key="$t(b.titleKey || b.title)" class="best-item">
                  <div class="best-item__title">{{ $t(b.titleKey || b.title) }}</div>
                  <div class="best-item__value">{{ b.value }}</div>
                  <div class="best-item__sub">{{ b.sub }}</div>
                </div>
              </div>
            </div>

            <!-- 3. Activity heatmap -->
            <div class="tl-card hm-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.heatTitle') }}</b>
                <span class="hm-range-toggle" role="radiogroup" :aria-label="$t('statsA.StatisticsView.ariaHeatRange')">
                  <button v-for="r in heatRangeOptions" :key="r.key" class="hm-range-btn"
                          :class="{on: heatRange===r.key}" role="radio" :aria-checked="heatRange===r.key"
                          @click="heatRange=r.key">{{ r.label }}</button>
                </span>
                <span class="tl-sub">{{ $t('statsA.StatisticsView.hmStats', { n: heatmap.streak, m: heatmap.totalDone, g: giveUps7 }) }}</span></div>
              <div class="hm-scroll" @scroll="hmTipHide">
                <div class="hm-grid" :class="heatRange==='year' ? 'hm-grid--year' : 'hm-grid--half'"
                     :style="{gridTemplateColumns:'repeat('+heatmap.weeks+', 1fr)'}"
                     @mouseleave="hmTipHide">
                  <div v-for="c in heatmap.cells" :key="c.key" class="hm-cell"
                       :class="'hm-l'+c.level" :style="{gridColumn:c.col+1, gridRow:c.dow+1}"
                       role="img" :aria-label="heatCellTitle(c)"
                       @mouseenter="hmTipShow(c, $event)" @mouseleave="hmTipHide"></div>
                </div>
              </div>
              <div class="hm-legend"><span>{{ $t('statsA.StatisticsView.hmLess') }}</span>
                <span class="hm-cell hm-l0"></span><span class="hm-cell hm-l1"></span><span class="hm-cell hm-l2"></span><span class="hm-cell hm-l3"></span><span class="hm-cell hm-l4"></span>
                <span>{{ $t('statsA.StatisticsView.hmMore') }}</span></div>
            </div>

            <!-- 4. Attention allocation -->
            <div v-if="attentionRows.length" class="tl-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.attTitle') }}</b><span class="tl-sub">{{ attentionUnitLabel }}</span></div>
              <div class="att-rows">
                <div v-for="r in attentionRows" :key="r.label" class="att-row">
                  <span class="att-label">{{ r.label }}</span>
                  <div class="att-track"><div class="att-bar" :style="{width:r.pct+'%'}"></div></div>
                  <span class="att-value">{{ r.valueText }}</span>
                </div>
              </div>
            </div>

            <!-- 4.1 Where focus went: task-level focus duration ranking -->
            <div v-if="taskFocusRows.length" class="tl-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.taskFocusTitle') }}</b><span class="tl-sub">{{ $t('statsA.StatisticsView.taskFocusSub') }}</span></div>
              <div class="att-rows">
                <div v-for="r in taskFocusRows" :key="r.label" class="att-row" :title="r.label">
                  <span class="att-label">{{ r.label }}</span>
                  <div class="att-track"><div class="att-bar" :style="{width:r.pct+'%'}"></div></div>
                  <span class="att-value">{{ r.valueText }}</span>
                </div>
              </div>
            </div>

            <!-- 5. Weekday distribution -->
            <chart-card :model="weekdayModel"/>

            <!-- 6. Completion trend -->
            <chart-card :model="trendModel"/>

            <!-- 6.1 Focus trend (minutes, same baseline semantics as the completion trend) -->
            <chart-card :model="focusTrendModel"/>

            <!-- 6.2 Give-up notes: free-text reasons from the abandon modal (shown only when reasons were recorded) -->
            <div v-if="metrics.giveupNotes.length" class="tl-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.giveupCardTitle') }}</b><span class="tl-sub">{{ $t('statsA.StatisticsView.giveupCardSub') }}</span></div>
              <ul class="review-card__list">
                <li v-for="(n, i) in metrics.giveupNotes" :key="i">
                  <span class="review-dot" aria-hidden="true"></span>
                  <span>{{ n.label }} · {{ n.text }}</span>
                </li>
              </ul>
            </div>

            <!-- 6. 24-hour timeline -->
            <div class="tl-card" @mouseleave="tlTip=null">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.tlTitle') }}</b>
                <span class="tl-chips" aria-hidden="true">
                  <i class="tl-chip tl-chip--focus"></i>{{ $t('statsA.StatisticsView.tlFocusLg') }}
                  <i class="tl-chip tl-chip--rest"></i>{{ $t('statsA.StatisticsView.tlRestLg') }}
                  <i class="tl-chip tl-chip--idle"></i>{{ $t('statsA.StatisticsView.tlIdleLg') }}
                </span>
                <span class="tl-sub">{{ $t('statsA.StatisticsView.tlActiveDays', { a: tlActiveCount, b: 7 }) }}</span>
                <button type="button" class="tl-grid-toggle" :class="{ on: tlGrid }" role="switch" :aria-checked="tlGrid ? 'true' : 'false'"
                        :title="$t('statsA.StatisticsView.tlGridToggle')" :aria-label="$t('statsA.StatisticsView.tlGridToggle')"
                        @click="toggleTlGrid">{{
                  $t('statsA.StatisticsView.tlGridToggle') }}</button>
              </div>
              <!-- Hour scale placed above the rows (finalized by user): the current time span can be aligned at a glance -->
              <div class="tl-hours">
                <span v-for="h in [0,3,6,9,12,15,18,21,24]" :key="h" class="tl-hour" :style="{left:(h/24*100)+'%'}">{{h}}</span>
              </div>
              <div class="tl-rows" :class="{ 'tl-rows--nogrid': !tlGrid }">
                <div v-for="row in timelineRows" :key="row.dateKey" class="tl-row" :class="{'tl-row--empty': row.empty}">
                  <span class="tl-date">{{row.dateKey.slice(5)}}</span>
                  <div class="tl-track">
                    <template v-for="b in (row.bands || [])" :key="b.left+'_'+b.width">
                      <div class="tl-band" :style="{left:b.left+'%', width:b.width+'%'}"
                           @mouseenter="e => tlTip = { text: b.title, x: e.clientX, y: e.clientY }"
                           @mousemove="e => { if (tlTip) { tlTip.x = e.clientX; tlTip.y = e.clientY } }"
                           @mouseleave="tlTip=null">
                        <div v-for="seg in b.segs" :key="seg.key" class="tl-seg unit"
                             :style="{ left: ((seg.left-b.left)/b.width*100)+'%', width: (seg.width/b.width*100)+'%', '--ff': seg.ff+'%' }"
                             @mouseenter.stop="e => tlTip = { text: seg.title, x: e.clientX, y: e.clientY }"
                             @mousemove="e => { if (tlTip) { tlTip.x = e.clientX; tlTip.y = e.clientY } }"
                             @mouseleave="tlTip=null"></div>
                      </div>
                    </template>
                    <div v-for="seg in row.segments.filter(x => x.kind==='rest')" :key="seg.key" class="tl-seg rest"
                         :style="{left:seg.left+'%', width:seg.width+'%'}"
                         @mouseenter="e => tlTip = { text: seg.title, x: e.clientX, y: e.clientY }"
                         @mousemove="e => { if (tlTip) { tlTip.x = e.clientX; tlTip.y = e.clientY } }"
                         @mouseleave="tlTip=null"></div>
                  </div>
                  <!-- Row-end metric: pomodoro count (hand-drawn tomato icon) + hover shows focus duration (set by user) -->
                  <span v-if="row.empty" class="tl-min tl-min--ghost" aria-hidden="true"></span>
                  <span v-if="!row.empty" class="tl-min"
                        @mouseenter="e => tlTip = { text: $t('statsA.StatisticsView.tlRowMetricTip', { d: row.done, c: row.count, m: row.minutes }), x: e.clientX, y: e.clientY }"
                        @mousemove="e => { if (tlTip) { tlTip.x = e.clientX; tlTip.y = e.clientY } }"
                        @mouseleave="tlTip=null">
                    <span class="tl-min__n">{{ row.count }}</span><app-icon name="timer" :size="13" class="tl-min__ico"/>
                  </span>
                </div>
              </div>
              <!-- Segment hover tip: native title has high latency and uncontrolled styling; replaced with a following custom tooltip -->
              <!-- The tip popover moved up to the page root: a .page container with transform hijacks the fixed coordinate system, mounting inside the card would render offscreen -->
            </div>
            </template>
            
            <template v-else>
            <!-- 7. Achievements wall -->
            <div class="tl-card ach-card">
              <div class="tl-head"><b>{{ $t('statsA.StatisticsView.achTitle') }}</b><span class="tl-sub">{{ $t('statsA.StatisticsView.achSub', { n: achievements.earnedCount }) }}</span></div>
              <div class="ach-totals">
                <div class="ach-total">
                  <div class="ach-total__v">{{ achievements.totals.done }}</div>
                  <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalDone') }}</div>
                </div>
                <div class="ach-total">
                  <div class="ach-total__v">{{ achievements.totals.focusHours }}<span class="ach-total__u">{{ $t('statsA.StatisticsView.unitHour') }}</span></div>
                  <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalFocus') }}</div>
                </div>
                <div class="ach-total">
                  <div class="ach-total__v">{{ achievements.totals.streak }}<span class="ach-total__u">{{ $t('statsA.StatisticsView.unitDay') }}</span></div>
                  <div class="ach-total__t">{{ $t('statsA.StatisticsView.achTotalStreak') }}</div>
                </div>
              </div>
              <div class="ach-fams">
                <div v-for="f in achievements.families" :key="f.id" class="ach-fam" :class="{'ach-fam--max': f.maxed}">
                  <span class="ach-fam__icon" v-html="f.icon"></span>
                  <div class="ach-fam__info">
                    <div class="ach-fam__row1">
                      <span class="ach-fam__name">{{ $t(f.famNameKey) }}</span>
                      <span class="ach-fam__lv" :class="{'ach-fam__lv--max': f.maxed}">Lv.{{ f.level }}<template v-if="f.maxed"> MAX</template></span>
                    </div>
                    <div class="ach-fam__num">
                      <span class="ach-fam__cur">{{ f.cur }}</span>
                      <span class="ach-fam__next">/ {{ f.nextV }} {{ $t(f.unitKey) }} · {{ $t(f.nextNameKey || 'statsA.Achievements.achMax') }}</span>
                    </div>
                    <div class="ach-progress"><div class="ach-progress__bar" :style="{width: f.pct+'%'}"></div></div>
                  </div>
                  <span class="ach-fam__badges" :title="$t('statsA.Achievements.achEarnedN', { n: f.earnedBadgesOfFam })">
                    <template v-if="f.earnedBadgesOfFam">✓×{{ f.earnedBadgesOfFam }}</template>
                  </span>
                </div>
              </div>
            </div>
            </template>
          </div>
        </div>
      </div>
    </div>
    <!-- Heatmap/timeline hover tips: mounted at the page root to avoid the .page transform hijacking fixed positioning and hm-card overflow clipping -->
    <div v-show="hmTip.show" ref="hmTip" class="hm-tip" :class="{ 'hm-tip--below': hmTip.below }" :style="{ left: (hmTip.px != null ? hmTip.px : hmTip.x) + 'px', top: (hmTip.py != null ? hmTip.py : hmTip.y) + 'px' }">{{ hmTip.text }}</div>
    <div v-if="tlTip" ref="tlTip" class="tl-tip" :style="{ left: (tlTip.px != null ? tlTip.px : tlTip.x) + 'px', top: (tlTip.py != null ? tlTip.py : tlTip.y) + 'px' }">{{ tlTip.text }}</div>
  </div>
</template>

<script lang="ts">
/**
 * Insights —— a review-narrative-first weekly review page (systematically rebuilt in 2026-08, moving away from the stats-page form):
 *   1. Review narrative card (local rule engine insights.js: headline + insights + suggestions)
 *   2. KPI comparison bars (done/focus/completion rate/give-ups, all from a "vs personal baseline" perspective, no absolute-count bragging)
 *   3. Activity heatmap (half-year/full-year toggle) 4. 24-hour focus timeline
 *   5. Attention allocation (per-category focus bars) 6. Completion trend line (with baseline reference band)
 *   7. Export long image / CSV
 * Engine and metrics live in statistics/metrics.js + insights.js (pure functions, covered by unit tests).
 * All copy goes through vue-i18n (statsA.* namespace); internal state like period/heatmap range uses stable keys,
 * display text is resolved via $t (the insights/achievements pure-function layer returns key+params, resolved in computeds/methods).
 */
import { dayjs, DAY_MS, FMT } from '../utils/core.js'
import ChartCard from './statistics/ChartCard.vue'

import { buildReviewMetrics } from './statistics/metrics.js'
import { composeReview, kpiDelta } from './statistics/insights.js'
import { buildAchievements } from './statistics/achievements.js'
import { loadScript, VENDOR } from '../utils/lazy-script.js'

// Periods: named calendar periods take priority (finalized by user); span periods remain as a supplement (internal keys, display copy in periodOptions)
// Custom date range (finalized by user 2026-08-31): no standalone pill; clicking the date-range label on the right opens the picker; the period internal key stays 'custom', route persists from/to
const PERIODS = ['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last7', 'last30']
const CUSTOM_MAX_DAYS = 366 // cap the custom span so the per-day trend series stays readable
const T = 'statsA.StatisticsView.'

export default {
  errorCaptured (err, vm, info) {
    console.error('[Stats-ErrorBoundary]', info, err && (err as any).stack || err)
    return false
  },
  name: 'StatisticsView',
  components: { ChartCard },
  data () {
    return { view: 'stat', period: 'thisWeek', heatRange: 'halfYear', shareOpen: false, shareStyle: 'narrative', tlTip: null, customRange: null, customDraft: null, tlGrid: (() => { try { return localStorage.getItem('tlHoverGrid') !== '0' } catch { return true } })(), hmTip: { show: false, text: '', x: 0, y: 0 } as any, nowTick: Date.now() }
  },
  /* Period/view state is written to route query (matching the calendar page convention): refresh/back-forward keeps the selection */
  watch: {
    view (v) { this.syncQuery() },
    period (v) { this.syncQuery() },
    /* After tooltip text/position changes, clamp into the viewport by measured size: near the right edge flip to the mouse's left, past the bottom edge flip back above */
    tlTip () { this.$nextTick(() => this.clampTip('tlTip', 'tlTip')) },
    hmTip () { this.$nextTick(() => this.clampHmTip()) }
  },
  created () {
    const q = this.$route.query || {}
    if (['stat', 'ach'].includes(q.view)) this.view = q.view
    if (q.from && q.to && dayjs(String(q.from)).isValid() && dayjs(String(q.to)).isValid()) {
      // Hand-edited URLs can bypass applyCustomRange's 366-day cap (a 2400-day span = thousands of byDaySeries points + 4x baseline windows, page-freeze level),
      // and an inverted from>to range leaves all KPIs empty: clamp and normalize here
      let a = dayjs(String(q.from)).startOf('day')
      let b = dayjs(String(q.to)).startOf('day')
      if (b.isBefore(a)) { const tmp = a; a = b; b = tmp }
      if (b.diff(a, 'day') > CUSTOM_MAX_DAYS) b = a.add(CUSTOM_MAX_DAYS, 'day')
      this.customRange = [a.format('YYYY-MM-DD'), b.format('YYYY-MM-DD')]
      this.period = 'custom'
    } else if (PERIODS.includes(q.period)) this.period = q.period
    // Low-frequency clock: periodBounds is a computed but depends on the wall clock; with no reactive dependency it's cached forever after first eval —
    // the page never refreshes, and after crossing days/time slots the endpoints of "last 7 days" etc. are stale (audit 2026-09-01). 30s granularity suffices.
    this._nowTimer = setInterval(() => { this.nowTick = Date.now() }, 30000)
  },
  beforeUnmount () {
    clearInterval(this._nowTimer)
  },
  computed: {
    todoList () { return this.$store.state.todo.todoList },
    tomatoRecordList () { return (this.$store.state.tomato && this.$store.state.tomato.tomatoRecordList) || [] },
    periodOptions () { return PERIODS.map(p => ({ key: p, label: this.$t(T + 'period_' + p) })) },
    heatRangeOptions () {
      return [
        { key: 'halfYear', label: this.$t(T + 'heatHalfYear') },
        { key: 'year', label: this.$t(T + 'heatYear') }
      ]
    },
    views () {
      return [
        { key: 'stat', text: this.$t(T + 'viewStat') },
        { key: 'ach', text: this.$t(T + 'viewAch') }
      ]
    },
    /** Current period bounds (end is an exclusive upper bound; "this week" runs up to now, avoiding comparing a half week against full weeks) */
    periodBounds () {
      const now = dayjs(this.nowTick) // read the reactive clock so the computed re-evaluates as time advances (see created comment)
      switch (this.period) {
        case 'lastWeek': {
          const s = now.subtract(1, 'week').startOf('isoWeek')
          return { start: +s, end: +s.add(7, 'day'), label: this.$t(T + 'period_lastWeek') }
        }
        case 'thisMonth': return { start: +now.startOf('month'), end: +now, label: this.$t(T + 'period_thisMonth') }
        case 'lastMonth': {
          const s = +now.subtract(1, 'month').startOf('month')
          const e = +now.startOf('month')
          return { start: s, end: e, label: this.$t(T + 'period_lastMonth') }
        }
        case 'last7': return { start: +now.subtract(7, 'day').startOf('day'), end: +now, label: this.$t(T + 'period_last7') }
        case 'last30': return { start: +now.subtract(30, 'day').startOf('day'), end: +now, label: this.$t(T + 'period_last30') }
        case 'custom': {
          if (!this.customRange) return { start: +now.subtract(7, 'day').startOf('day'), end: +now, label: this.$t(T + 'period_custom') }
          const s = +dayjs(this.customRange[0]).startOf('day')
          const e = +dayjs(this.customRange[1]).add(1, 'day').startOf('day') // end is an exclusive upper bound, covering the whole selected final day
          return { start: s, end: e, label: this.$t(T + 'period_custom') }
        }
        default: return { start: +now.startOf('isoWeek'), end: +now, label: this.$t(T + 'period_thisWeek') }
      }
    },
    periodRangeLabel () {
      const { start, end } = this.periodBounds
      return `${dayjs(start).format('MM.DD')} - ${dayjs(Math.min(end, +dayjs().endOf('day'))).format('MM.DD')}`
    },
    /** Number of days in the custom range (for the cap validation message) */
    customDraftDays () {
      if (!this.customDraft || !this.customDraft[0] || !this.customDraft[1]) return 0
      return Math.round((+dayjs(this.customDraft[1]).startOf('day') - +dayjs(this.customDraft[0]).startOf('day')) / DAY_MS) + 1
    },
    metrics () {
      return buildReviewMetrics({
        todos: this.todoList,
        records: this.tomatoRecordList,
        catNameOf: id => {
          const c = this.$store.getters['category/byId'](id)
          return c ? c.categoryName : this.$t(T + 'uncategorized')
        }
      }, this.periodBounds)
    },
    review () { return composeReview(this.metrics) },
    achievements () {
      return buildAchievements({ todos: this.todoList, records: this.tomatoRecordList })
    },
    shareDate () { return dayjs().format('YYYY.MM.DD') },
    /** Compact data shared by share cards */
    shareTopInsights () { return this.review.insights.slice(0, 3) },
    shareStyles () {
      return [
        { key: 'narrative', label: this.$t(T + 'shareStyleNarrative') },
        { key: 'data', label: this.$t(T + 'shareStyleData') },
        { key: 'mini', label: this.$t(T + 'shareStyleMini') }
      ]
    },
    hasAnyData () { return this.todoList.length > 0 || this.tomatoRecordList.length > 0 },
    /* Four KPI tiles: the main number is the period total, delta vs baseline daily average x days (equal-length conversion) */
    kpis () {
      const m = this.metrics
      const d = (cur, base) => kpiDelta(cur, base == null ? null : base * m.days, 15)
      const ratePct = m.doneRate == null ? null : Math.round(m.doneRate * 100)
      const baseRatePct = m.baseline.doneRate == null ? null : Math.round(m.baseline.doneRate * 100)
      // Give-up rate: give-ups / total starts (completed + given up); without any starts there is no rate
      const totalRuns = m.tomatoCount + m.giveUps
      const giveupRatePct = totalRuns ? Math.round(m.giveUps / totalRuns * 100) : null
      return [
        { key: 'done', title: this.$t(T + 'kpiDone'), value: `${m.done}`, sub: this.$t(T + 'kpiDoneSub', { n: m.added }), delta: d(m.done, m.baseline.done), goodDir: 'up' },
        { key: 'focus', title: this.$t(T + 'kpiFocus'), value: `${m.focusMins}min`, sub: this.$t(T + 'kpiFocusSub', { n: m.tomatoCount }), delta: d(m.focusMins, m.baseline.focus), goodDir: 'up' },
        { key: 'rate', title: this.$t(T + 'kpiRate'), value: ratePct == null ? '—' : `${ratePct}%`, sub: this.$t(T + 'kpiRateSub', { n: m.planned }), delta: this.rateDelta(ratePct, baseRatePct), goodDir: 'up' },
        { key: 'giveup', title: this.$t(T + 'kpiGiveup'), value: `${m.giveUps}`, sub: giveupRatePct == null ? this.$t(T + 'kpiGiveupSub') : this.$t(T + 'kpiGiveupRate', { n: giveupRatePct }), delta: d(m.giveUps, m.baseline.giveUps), goodDir: 'down' }
      ]
    },
    /** Attention allocation: per-category focus minute bars (falls back to completion counts when focus records are sparse) */
    attentionRows () {
      const m = this.metrics
      const useFocus = m.focusMins >= 15 && m.catFocus.length
      const list = useFocus ? m.catFocus : m.catDone
      const total = list.reduce((s, i) => s + i.value, 0) || 1
      const unit = useFocus ? this.$t(T + 'unitMinutes') : this.$t(T + 'unitCount')
      return list.slice(0, 6).map(i => ({
        label: i.label, valueText: this.$t(T + 'attValue', { v: i.value, unit }),
        pct: Math.max(4, Math.round(i.value / total * 100)), raw: i.value
      }))
    },
    attentionUnitLabel () { return this.metrics.focusMins >= 15 ? this.$t(T + 'attByFocus') : this.$t(T + 'attByCount') },
    /** Period bests: three highlights of the review page */
    periodBests () {
      const m = this.metrics
      const fmtD = d => d ? d.label : '—'
      const bests: any[] = [
        { title: this.$t(T + 'bestFocusDay'), value: m.bestFocusDay ? this.$t(T + 'bestFocusVal', { n: m.bestFocusDay.mins }) : '—', sub: m.bestFocusDay ? fmtD(m.bestFocusDay) : this.$t(T + 'bestNoFocus') },
        { title: this.$t(T + 'bestDoneDay'), value: m.bestDoneDay ? this.$t(T + 'bestDoneVal', { n: m.bestDoneDay.count }) : '—', sub: m.bestDoneDay ? fmtD(m.bestDoneDay) : this.$t(T + 'bestNoDone') },
        { title: this.$t(T + 'bestStreak'), value: this.$t(T + 'bestStreakVal', { n: m.streak }), sub: m.streak >= 2 ? this.$t(T + 'streakHabit') : this.$t(T + 'streakStart') }
      ]
      return bests
    },
    /** Weekday distribution (Monday-Sunday, dual axis: bars = completed events / line = focus minutes; the right axis uses real minutes, no longer normalized) */
    weekdayModel () {
      const m = this.metrics
      const labels = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7'].map(k => this.$t(T + k))
      return {
        modelType: 4,
        title: this.$t(T + 'weekdayTitle'),
        subTitle: this.$t(T + 'weekdaySubtitle'),
        chartList: labels.map((l, i) => ({ label: l, value: m.doneByWeekday[i] })),
        overlayList: labels.map((l, i) => ({ label: l, value: m.focusByWeekday[i] })),
        summary: this.$t(T + 'weekdaySummary', { d: labels[m.focusByWeekday.indexOf(Math.max(...m.focusByWeekday))] || '—' })
      }
    },
    /* Completion trend + baseline reference band (chart-c extended with a baselineValue dashed line) */
    trendModel () {
      const m = this.metrics
      const baseDaily = m.baseline.done
      return {
        modelType: 3,
        title: this.$t(T + 'trendTitle'),
        subTitle: this.periodRangeLabel,
        chartList: m.doneByDay,
        baselineValue: baseDaily == null ? null : +baseDaily.toFixed(2), // daily-average reference line
        summary: baseDaily == null ? this.$t(T + 'trendSummaryEmpty') : this.$t(T + 'trendSummaryBase', { n: baseDaily.toFixed(1) })
      }
    },
    /* Focus trend (minutes): the second half of "event caliber + focus caliber" side by side, baseline same as focus KPI */
    focusTrendModel () {
      const m = this.metrics
      const baseDaily = m.baseline.focus
      return {
        modelType: 3,
        title: this.$t(T + 'focusTrendTitle'),
        subTitle: this.periodRangeLabel,
        chartList: m.focusByDay,
        legendLabel: this.$t(T + 'legendFocusMins'),
        baselineValue: baseDaily == null ? null : +baseDaily.toFixed(1),
        summary: baseDaily == null ? this.$t(T + 'trendSummaryEmpty') : this.$t(T + 'focusTrendSummary', { n: baseDaily.toFixed(1) })
      }
    },
    /* Where focus went: task-level focus duration ranking (unlinked = free focus, listed separately) */
    taskFocusRows () {
      const m = this.metrics
      if (m.focusMins < 15 || !m.taskFocus.length) return []
      return m.taskFocus.slice(0, 6).map(i => {
        let label
        if (i.label === '_free') label = this.$t(T + 'freeFocus')
        else {
          const t = this.todoList.find(x => x.taskId === i.label)
          label = t ? (t.taskContent || this.$t(T + 'untitled')) : this.$t(T + 'taskGone')
        }
        return {
          label,
          valueText: this.$t(T + 'attValue', { v: i.value, unit: this.$t(T + 'unitMinutes') }),
          pct: Math.max(4, Math.round(i.value / m.focusMins * 100))
        }
      })
    },
    /* ---------- Heatmap (half year 26 weeks / full year 52 weeks) ---------- */
    heatWeeks () { return this.heatRange === 'year' ? 52 : 26 },
    heatmap () {
      const day = DAY_MS
      // 用响应式时钟 nowTick 而非 dayjs():跨零点停留时热力图窗口不冻结(同 periodBounds)
      const today = dayjs(this.nowTick).startOf('day')
      const end = +today.add(6 - ((today.day() + 6) % 7), 'day')
      const start = +dayjs(end).subtract(this.heatWeeks * 7 - 1, 'day')
      const doneByDay = new Map(); const focusByDay = new Map()
      this.todoList.forEach(t => {
        if (!t.complete || t.delete) return
        const ts = t.completedAt || t.updateTime
        if (!ts) return
        const k = dayjs(ts).format(FMT.date)
        doneByDay.set(k, (doneByDay.get(k) || 0) + 1)
      })
      this.tomatoRecordList.forEach(r => {
        if (r.succeed === false) return
        const k = dayjs(Number(r.endTime)).format(FMT.date)
        focusByDay.set(k, (focusByDay.get(k) || 0) + (r.focusDuration || 0))
      })
      const maxDone = Math.max(1, ...doneByDay.values())
      const cells = []
      for (let ts = start; ts <= end; ts += day) {
        const d = dayjs(ts)
        const k = d.format(FMT.date)
        const done = doneByDay.get(k) || 0
        const focus = focusByDay.get(k) || 0
        let level = 0
        if (done > 0) level = 1
        if (done >= maxDone * 0.34 || (done > 0 && focus >= 25)) level = 2
        if (done >= maxDone * 0.67 || (done > 0 && focus >= 50)) level = 3
        if (done >= maxDone || (done > 0 && focus >= 100)) level = 4
        cells.push({ key: k, date: d.format(FMT.cnFull), done, focus, level,
          col: Math.floor((ts - start) / day / 7), dow: (d.day() + 6) % 7 })
      }
      const totalDone = cells.reduce((s, c) => s + c.done, 0)
      const streak = (() => {
        let n = 0
        for (let i = cells.length - 1; i >= 0; i--) { if (cells[i].done > 0) n++; else if (i !== cells.length - 1) break }
        return n
      })()
      return { cells, weeks: this.heatWeeks, totalDone, streak }
    },
    giveUps7 () {
      const since = +dayjs().subtract(7, 'day').startOf('day')
      return this.tomatoRecordList.filter(r => r.succeed === false && Number(r.endTime) >= since).length
    },
    /** Review headline: insights.js returns key+params, resolved here via $t (including localized focus duration format) */
    reviewHeadline () {
      const h = this.review.headline
      const n = h.focusMins
      const focus = n >= 60
        ? (n % 60 ? this.$t('statsA.Insights.hoursMins', { h: Math.floor(n / 60), m: n % 60 }) : this.$t('statsA.Insights.hours', { h: Math.floor(n / 60) }))
        : this.$t('statsA.Insights.mins', { n })
      const tail = h.toneKey ? this.$t(h.toneKey) : ''
      return this.$t(h.key, Object.assign({}, h.params, { focus })) + tail
    },
    /* 24-hour timeline: last 7 days. Empty rows compressed (4px thin line), segment boundaries clamped to the day, fully duplicated records deduplicated */
    timelineRows () {
      const recs = this.tomatoRecordList
      const byDay = new Map()
      for (const r of recs) {
        const end = Number(r.endTime) || 0
        if (!end) continue
        const key = dayjs(end).format(FMT.date)
        if (!byDay.has(key)) byDay.set(key, [])
        byDay.get(key).push(r)
      }
      const rows = []
      for (let d = 6; d >= 0; d--) {
        const dayStart = dayjs().startOf('day').valueOf() - d * DAY_MS
        const key = dayjs(dayStart).format(FMT.date)
        const segs = []
        let count = 0
        const seen = new Set() // fully identical records (same start/end, duration, task) drawn once: dirty historical data from multi-window races no longer stacks up
        let minutes = 0
        // Completed events that day (completion time falls on that date, same semantics as the heatmap)
        const done = this.todoList.reduce((n, t) => {
          if (!t.complete || t.delete) return n
          const ts = t.completedAt || t.updateTime
          return ts && dayjs(ts).format(FMT.date) === key ? n + 1 : n
        }, 0)
        const list = (byDay.get(key) || []).sort((a, b) => a.endTime - b.endTime)
        // Focus session aggregation: consecutive pomodoros with gaps <=10min merge into one session band (visually turns "alternating light/dark bricks" into "one work session";
        // dark within a band = focus, light = rest; band-level hover reports the whole session summary, block-level hover keeps per-pomodoro detail)
        const bands = []
        let bandCursor = null
        for (const r of list) {
          const end = Number(r.endTime)
          const focusMs = (Number(r.focusDuration) || 0) * 60000
          const restMs = (Number(r.restDuration) || 0) * 60000
          const fStart = end - focusMs
          if (r.succeed !== false) { minutes += Number(r.focusDuration) || 0; count++ }
          const dupKey = fStart + '|' + end + '|' + (r.focusDuration || 0) + '|' + (r.focus || '')
          if (seen.has(dupKey)) continue
          seen.add(dupKey)
          // One pomodoro = one integral unit: the focus body plus the adjacent rest tail (finalized by user: rest and focus belong to the same moment; splitting them hurts readability)
          const clamp = (v, w) => Math.max(0, Math.min(v, 100 - Math.min(w, 100)))
          const restW = restMs > 0 ? Math.min(restMs, 5 * 60000) / DAY_MS * 100 : 0
          const focusW = focusMs / DAY_MS * 100
          const uLeft = clamp((fStart - dayStart) / DAY_MS * 100, focusW + restW)
          const uWidth = focusW + restW
          const GAP = 10 * 60000 / DAY_MS * 100 // session split threshold: 10 minutes
          if (focusMs > 0) {
            // The hover explains what this focus session was about: report the linked task's name, otherwise show placeholder copy (finalized by user)
            const what = r.focus ? this.$t(T + 'segAttach', { name: r.focus }) : this.$t(T + 'segFree')
            const title = this.$t(T + 'segFocus', { time: dayjs(fStart).format('HH:mm') + '–' + dayjs(end).format('HH:mm'), n: r.focusDuration }) + ' · ' + what + (restW ? ' + ' + this.$t(T + 'segRest') : '')
            const seg = { key: r.tomatoId + '_u', kind: 'unit',
              left: uLeft, width: uWidth, ff: uWidth ? focusW / uWidth * 100 : 100,
              title, focus: r.focus || '' }
            segs.push(seg)
            if (bandCursor && uLeft - (bandCursor.left + bandCursor.width) <= GAP) {
              bandCursor.width = Math.max(bandCursor.width, uLeft + uWidth - bandCursor.left)
              bandCursor.segs.push(seg)
              bandCursor.n += 1
              if (!bandCursor.tasks.includes(r.focus || '')) bandCursor.tasks.push(r.focus || '')
              bandCursor.endMin = Math.max(bandCursor.endMin, end)
            } else {
              bandCursor = { left: uLeft, width: uWidth, segs: [seg], n: 1, tasks: [r.focus || ''], endMin: end, startMin: fStart }
              bands.push(bandCursor)
            }
          } else if (restW > 0) {
            segs.push({ key: r.tomatoId + '_r', kind: 'rest',
              left: clamp((end - dayStart) / DAY_MS * 100, restW), width: restW, title: this.$t(T + 'segRest') })
          }
        }
        // Band-level summary: hovering a band reveals the whole work session (N pomodoros / start-end / deduped linked tasks)
        for (const b of bands) {
          const tasks = b.tasks.filter(Boolean)
          const what = tasks.length
            ? tasks.map(n => this.$t(T + 'segAttach', { name: n })).join('、')
            : this.$t(T + 'segFree')
          b.title = this.$t(T + 'segFocus', {
            time: dayjs(b.startMin).format('HH:mm') + '–' + dayjs(b.endMin).format('HH:mm'), n: b.n
          }) + ' · ' + what
        }
        rows.push({ dateKey: key, segments: segs, bands, count, minutes, done, empty: segs.length === 0 })
      }
      return rows
    },
    tlActiveCount () {
      return this.timelineRows.filter(r => !r.empty).length
    }
  },
  methods: {
    /** Hover 3-hour dashed-grid toggle: state persisted to localStorage('tlHoverGrid'), on by default */
    toggleTlGrid () {
      this.tlGrid = !this.tlGrid
      try { localStorage.setItem('tlHoverGrid', this.tlGrid ? '1' : '0') } catch {}
    },
    syncQuery () {
      const q = { ...this.$route.query }
      if (this.view === 'stat') delete q.view; else q.view = this.view
      delete q.period; delete q.from; delete q.to
      if (this.period === 'custom' && this.customRange) {
        q.from = this.customRange[0]; q.to = this.customRange[1]
      } else if (this.period !== 'thisWeek') q.period = this.period
      this.$router.replace({ query: q }).catch(() => {})
    },
    /** Open the custom range picker: the draft defaults to the effective range, otherwise the last 7 days (called by onRangePopShow when the popover expands) */
    initCustomDraft () {
      const now = dayjs()
      this.customDraft = this.customRange ? [...this.customRange] : [now.subtract(6, 'day').format('YYYY-MM-DD'), now.format('YYYY-MM-DD')]
    },
    applyCustomRange () {
      if (!this.customDraft || !this.customDraft[0] || !this.customDraft[1]) return
      if (this.customDraftDays > CUSTOM_MAX_DAYS) { this.$message.warning(this.$t(T + 'customTooLong', { n: CUSTOM_MAX_DAYS })); return }
      this.customRange = [...this.customDraft]
      this.period = 'custom'
      this.$refs.rangePop && this.$refs.rangePop.hide()
    },
    rateDelta (curPct, basePct) {
      if (curPct == null || basePct == null || Math.abs(curPct - basePct) < 8) return null
      return { pct: (curPct - basePct > 0 ? '+' : '') + (curPct - basePct) + '%', dir: curPct > basePct ? 'up' : 'down' }
    },
    deltaClass (kpi, delta) {
      if (!delta) return 'flat'
      return delta.dir === kpi.goodDir ? 'good' : 'warn'
    },
    /** Insight/suggestion item copy: insights.js returns key+params, resolved here */
    insightText (i) { return this.$t(i.mainKey, i.mainParams) },
    heatCellTitle (c) {
      let s = this.$t(T + 'heatCellTitle', { date: c.date, done: c.done })
      if (c.focus) s += this.$t(T + 'heatCellFocus', { focus: c.focus })
      return s
    },
    /* Heatmap hover tip: native title styling doesn't match the project, so a project-style dark popover is used instead (one shared instance, no extra DOM for 365 cells) */
    hmTipShow (c, ev) {
      const r = ev.target.getBoundingClientRect()
      this.hmTip = { show: true, text: this.heatCellTitle(c), x: r.left + r.width / 2, y: r.top, ch: r.height, px: null, below: false }
    },
    hmTipHide () { this.hmTip.show = false },
    /** Timeline following tooltip: defaults to the mouse's upper right (CSS transform offset), then clamped by measured size after render to prevent overflow —
     *  near the right edge it flips horizontally to the mouse's left; if that goes past the top edge it flips below the mouse (user feedback: popovers overflowed at screen edges) */
    clampTip (stateKey, refName) {
      const t = this[stateKey]
      const el = this.$refs[refName]
      if (!t || !el || t.show === false) return
      const w = el.offsetWidth, h = el.offsetHeight, pad = 8, vw = window.innerWidth, vh = window.innerHeight
      let px, py
      if (stateKey === 'tlTip') {
        px = t.x + 12; py = t.y - h - 10                       // default: upper right
        if (px + w + pad > vw) px = Math.max(pad, t.x - w - 12) // near right edge -> flip left
        if (py < pad) py = Math.min(t.y + 16, vh - h - pad)     // near top edge -> flip below
        if (py + h + pad > vh) py = vh - h - pad
      } else {
        px = Math.min(Math.max(t.x, w / 2 + pad), vw - w / 2 - pad) // centered above the cell, clamped horizontally into the viewport
        py = t.y
      }
      if (px !== t.px || py !== t.py) this[stateKey] = { ...t, px, py }
    },
    clampHmTip () {
      const t = this.hmTip
      const el = this.$refs.hmTip
      if (!t || !t.show || !el) return
      const w = el.offsetWidth, h = el.offsetHeight, pad = 8
      const px = Math.min(Math.max(t.x, w / 2 + pad), window.innerWidth - w / 2 - pad)
      const below = t.y - h - 10 < pad            // cell close to screen top -> flip below the cell
      const py = below ? t.y + (t.ch || 0) + 8 : t.y
      if (px !== t.px || below !== t.below || py !== t.py) this.hmTip = { ...t, px, py, below }
    },
    /* Share card: three style templates -> html2canvas PNG export (fixed light background for consistent share appearance) */
    openShare () { this.shareOpen = true },
    async saveShareCard () {
      try {
        const el = this.$refs.shareCard
        if (!el) return this.$message.error(this.$t(T + 'msgNoCardContent'))
        // html2canvas lazy load (2026-09-02 startup optimization): injected only when exporting the share card
        if (!window.html2canvas) await loadScript(VENDOR.html2canvas)
        const canvas = await window.html2canvas(el, { scale: 2, backgroundColor: null, useCORS: true })
        const a = document.createElement('a')
        a.href = canvas.toDataURL('image/png')
        a.download = `${this.$t(T + 'fileShareCard')}_${this.period}_${dayjs().format('YYYYMMDD_HHmmss')}.png`
        a.click()
        this.$message.success(this.$t(T + 'msgShareSaved'))
      } catch (e) { this.$message.error(this.$t(T + 'msgExportFailed', { msg: e.message })) }
    },
    exportTable () {
      const m = this.metrics
      const rows = [[this.$t(T + 'csvPeriod'), m.label]]
      rows.push([this.$t(T + 'csvMetric'), this.$t(T + 'csvValue'), this.$t(T + 'csvBaseline')])
      rows.push([this.$t(T + 'kpiDone'), m.done, m.baseline.done == null ? '' : m.baseline.done.toFixed(1)])
      rows.push([this.$t(T + 'csvAdded'), m.added, ''])
      rows.push([this.$t(T + 'csvPlanned'), m.planned, ''])
      rows.push([this.$t(T + 'kpiRate'), m.doneRate == null ? '' : Math.round(m.doneRate * 100) + '%', m.baseline.doneRate == null ? '' : Math.round(m.baseline.doneRate * 100) + '%'])
      rows.push([this.$t(T + 'csvFocusMins'), m.focusMins, m.baseline.focus == null ? '' : m.baseline.focus.toFixed(1)])
      rows.push([this.$t(T + 'csvTomatoes'), m.tomatoCount, ''])
      rows.push([this.$t(T + 'kpiGiveup'), m.giveUps, m.baseline.giveUps == null ? '' : m.baseline.giveUps.toFixed(1)])
      rows.push([])
      rows.push([this.$t(T + 'csvNarrative')])
      rows.push([this.reviewHeadline])
      this.review.insights.forEach(i => rows.push([this.insightText(i)]))
      rows.push([])
      rows.push([this.$t(T + 'csvDate'), this.$t(T + 'csvDoneCount'), this.$t(T + 'csvFocusMins')])
      m.doneByDay.forEach((d, i) => rows.push([d.label, d.value, m.focusByDay[i] ? m.focusByDay[i].value : 0]))
      const csv = '﻿' + rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\n')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      a.download = `${this.$t(T + 'fileDataReview')}_${this.period}_${dayjs().format('YYYYMMDD')}.csv`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10000) // release the Blob URL
      this.$message.success(this.$t(T + 'msgTableExported'))
    }
  },

}
</script>
