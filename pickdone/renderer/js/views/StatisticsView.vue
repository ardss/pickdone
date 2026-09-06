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
                      tabindex="0" @click="view=v.key" @keydown.enter.prevent="view=v.key"><app-icon :name="v.icon" :size="13"/>{{ v.text }}</button>
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
        { key: 'stat', icon: 'chart', text: this.$t(T + 'viewStat') },
        { key: 'ach', icon: 'flag', text: this.$t(T + 'viewAch') }
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
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* 热力图悬浮提示（项目风格深色浮层，替代原生 title）：挂页面根节点，fixed 定位在格子上方居中 */
.hm-tip {
  position: fixed; z-index: var(--z-pop); transform: translate(-50%, calc(-100% - 8px));
  background: var(--text-1, #303133); color: var(--panel, #fff);
  font-size: var(--fs-xs); line-height: 1.4; padding: 5px 10px; border-radius: var(--radius-md);
  white-space: nowrap; pointer-events: none; box-shadow: var(--shadow-pop);
  animation: hm-tip-in .12s ease-out;
}
.hm-tip::after {
  content: ''; position: absolute; left: 50%; top: 100%; transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: var(--text-1, #303133);
}
html[data-theme="dark"] .hm-tip { background: #333a44; color: #e8eaed; border: 1px solid #333a44; }
html[data-theme="dark"] .hm-tip::after { border-top-color: #333a44; }
/* 格子贴近屏幕顶部时翻到下方（clampHmTip 切换） */
.hm-tip--below { transform: translate(-50%, 14px); animation: hm-tip-in-below .12s ease-out; }
.hm-tip--below::after { top: auto; bottom: 100%; border-top-color: transparent; border-bottom-color: var(--text-1, #303133); }
html[data-theme="dark"] .hm-tip--below::after { border-top-color: transparent; border-bottom-color: #333a44; }
/* 复盘叙事卡（合并 324/557 两层定义为单层，品牌顶边） */
.review-card {
  max-width: 785px; margin: 0 auto 18px; padding: 24px 28px 22px;
  background: var(--panel, #fff);
  border: 1px solid var(--line); border-radius: var(--radius-xl);
  position: relative; overflow: hidden;
  box-shadow: 0 4px 18px rgba(31, 56, 88, .08);
}
.review-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--brand);
}
.review-card__head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.review-card__head b { font-size: var(--fs-base); letter-spacing: 1px; color: var(--text-1); }
.review-card__tag { font-size: var(--fs-xs); color: var(--brand); background: var(--brand-light); padding: 2px 8px; border-radius: var(--radius-pill); }
.review-card__headline {
  margin: 0 0 14px; padding: 12px 16px;
  background: color-mix(in srgb, var(--brand) 8%, transparent);
  border-left: 3px solid var(--brand); border-radius: 0 var(--radius-md) var(--radius-md) 0;
  font-size: var(--fs-lg); font-weight: 600; line-height: 1.6; color: var(--text-1);
}
.review-card__list { margin: 0; padding: 0; list-style: none; }
.review-card__list li {
  display: flex; align-items: baseline; gap: var(--space-2);
  padding: 6px 0; font-size: var(--fs-base); line-height: 1.65; color: var(--text-1);
}
/* 叙事卡质感：白底 + 品牌渐变顶边 + 数字强调 */
.review-card {
  background: var(--panel, #fff); border: 1px solid var(--line); border-radius: var(--radius-xl);
  padding: 26px 30px 24px; position: relative; overflow: hidden;
  box-shadow: 0 4px 18px rgba(31, 56, 88, .08);
}
.review-card::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
  background: var(--brand);
}
.review-card__head b { font-size: var(--fs-base); letter-spacing: 1px; }
.review-card__headline { font-size: 24px; font-weight: 800; margin: 14px 0 16px; letter-spacing: .3px; }
.review-card__list li { font-size: var(--fs-base); padding: 7px 0; }
.review-card__advice { margin-top: 18px; }
.ach-fam { display: flex; align-items: center; gap: var(--space-3); padding: 10px 14px; border: 1px solid var(--line, #e4e7ed); border-radius: var(--radius-md, 10px); }
.ach-fam--max { border-color: rgba(46, 158, 68, .4); }
.ach-fam__icon { color: var(--brand); flex-shrink: 0; display: flex; }
.ach-fam--max .ach-fam__icon { color: var(--ok, #2e9e44); }
.ach-fam__info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ach-fam__row1 { display: flex; align-items: baseline; gap: var(--space-2); }
.ach-fam__name { font-size: var(--fs-sm, 13px); font-weight: 600; color: var(--text-1, #333); }
.ach-fam__lv { font-size: var(--fs-2xs, 11px); color: var(--brand); font-weight: 600; }
.ach-fam__lv--max { color: var(--ok, #2e9e44); }
.ach-fam__num { font-size: var(--fs-xs, 12px); color: var(--text-3, #6d7278); }
.ach-fam__cur { font-size: var(--fs-lg); font-weight: 700; color: var(--text-1, #333); font-variant-numeric: tabular-nums; }
.ach-fam__badges { flex-shrink: 0; font-size: var(--fs-2xs, 11px); color: var(--ok, #2e9e44); font-weight: 600; }
html[data-theme="dark"] .review-card { background: var(--panel); border-color: var(--line); }
html[data-theme="dark"] .review-card::before { opacity: .8; }
html[data-theme="dark"] .review-card { background: var(--panel); }

/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
.stat-hero__headline {
  margin-top: 14px; padding: 12px 16px;
  background: linear-gradient(135deg, var(--brand-light, #eef1fe), transparent);
  border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0;
  font-size: var(--fs-lg); font-weight: 600; line-height: 1.6; color: var(--text-1);
}
/* 复盘卡 headline */
.stat-hero__headline {
  padding: 12px 16px; margin-bottom: var(--space-3);
  background: linear-gradient(135deg, var(--brand-light, #eef1fe), transparent);
  border-left: 3px solid var(--brand); border-radius: 0 8px 8px 0;
  font-size: var(--fs-lg); font-weight: 600; line-height: 1.6; color: var(--text-1);
}
.stat-page .container{padding:0 25px 25px}
/* 统计子页宽度（设计稿 getReportXxx 各子页共用） */
.stat-subpage{max-width:785px;margin-left:auto;margin-right:auto;padding-top:25px;padding-bottom:25px}
.stat-subpage .none pre{margin:4px 0;padding:0;font-family:inherit}
/* ============ 24 小时时间轴（番茄统计） ============ */
.tl-card { background: var(--panel, #fff); border-radius: var(--radius-md); padding: 16px 20px; margin-top: 14px; }
.tl-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: var(--space-3); }
.tl-head b { font-size: var(--fs-base); color: var(--text-1); }
.tl-sub { font-size: var(--fs-xs); color: var(--text-3); }
.tl-rows { display: flex; flex-direction: column; gap: 6px; }
.tl-row { display: flex; align-items: center; gap: 10px; }
.tl-date { width: 42px; font-size: var(--fs-xs); color: var(--text-2); text-align: right; flex-shrink: 0; }
.tl-track {
  position: relative; flex: 1; height: 16px; border-radius: var(--radius-md);
  background: var(--track-bg); overflow: hidden;
}
.tl-seg { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
/* 专注时段带:连续番茄(间隔<=10min)合并为一条圆角带,带底=休息浅色,带内实心块=专注;
   消除"一块专注一块休息"的砖块感,hover 带体报整段摘要(块级 hover 保留单番茄明细) */
.tl-band { position: absolute; top: 0; bottom: 0; border-radius: var(--radius-sm, 4px); background: var(--line, #c9ced6); cursor: default; }
.tl-band .tl-seg.unit { top: 2px; bottom: 2px; border-radius: 0; background: var(--brand); box-shadow: 1px 0 0 var(--panel, #fff); }
/* 带内纯品牌色直角相连(圆角会产生接缝);1px 白线仅作番茄分隔刻度 */
/* 一个番茄=一个单元块：专注主体(品牌绿)+紧连的休息尾巴(灰)，--ff 为专注占比分割点(内联覆盖) */
.tl-seg.unit { --ff: 80%; background: linear-gradient(to right, var(--brand) var(--ff), #c9ced6 var(--ff)); }
.tl-seg.unit:hover { filter: brightness(.94); }
.tl-seg.focus { background: var(--brand); }
.tl-seg.focus:hover { background: var(--brand-dark); }
.tl-seg.rest { background: #c9ced6; }
/* 空行不塌缩:无记录日保持整行轨道高度(压成细线曾显突兀),仅降透明度+日期变淡让注意力给有数据的日子 */
.tl-row--empty .tl-track { opacity: .45; }
.tl-row--empty .tl-date { color: var(--text-4); }
/* 悬停行显示 3 小时虚线分隔(3/6/…/21,即 12.5% 步进):竖线由 mask 切出列,虚线由纵向 repeating-gradient 画出 */
/* 悬停虚线开关:关闭时不画(::after 仅在非 nogrid 行悬停时出现);开关本体=头部小药丸,默认开 */
.tl-rows--nogrid .tl-track::after { content: none !important; }
.tl-grid-toggle {
  margin-left: auto; border: 1px solid var(--line-strong, #d8dde2); background: transparent; color: var(--text-3);
  font-size: var(--fs-2xs, 10px); padding: 1px 8px; border-radius: var(--radius-pill); cursor: pointer; flex-shrink: 0;
}
.tl-grid-toggle.on { border-color: var(--brand); color: var(--brand-dark); background: var(--brand-light, #e7f7f7); }
.tl-row:hover .tl-track::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 1;
  background-image: repeating-linear-gradient(to bottom, transparent 0 2px, var(--text-3, #8a9099) 2px 4px);
  -webkit-mask-image: repeating-linear-gradient(to right, transparent 0 calc(12.5% - 1px), #000 calc(12.5% - 1px) 12.5%);
  mask-image: repeating-linear-gradient(to right, transparent 0 calc(12.5% - 1px), #000 calc(12.5% - 1px) 12.5%);
}
/* 行尾番茄指标：个数 + 计时器线性图标（AppIcon 统一风格），悬停显示专注时长 */
.tl-min { margin-left: auto; width: 34px; justify-content: flex-end; font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); flex-shrink: 0; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 3px; cursor: default; }
/* 定宽:位数不同曾使各行轨道右缘参差 */
.tl-min--ghost { visibility: hidden; }
/* 空行也占位,轨道右缘全线对齐 */
.tl-min__n { color: var(--text-1); }
.tl-min__ico { color: var(--text-3); transition: transform var(--dur-fast); }
.tl-min:hover .tl-min__ico { transform: scale(1.12); color: var(--brand); }
/* 色块图例 */
.tl-chips { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--text-3); margin-right: 6px; }
.tl-chip { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin: 0 2px 0 8px; }
.tl-chip--focus { background: var(--brand); }
.tl-chip--rest { background: #c9ced6; }
.tl-chip--idle { background: var(--track-bg, #ececef); }
/* 时间刻度尺（行上方，0-24 每 3 小时一刻度） */
.tl-hours { position: relative; height: 14px; margin-left: 52px; margin-right: 44px; margin-bottom: 6px; }
/* 右缩=行尾指标列(34px+gap),使 24 刻度与轨道右缘对齐 */
.tl-hour { position: absolute; transform: translateX(-50%); font-size: var(--fs-2xs); color: var(--text-4); }
.tl-hour:first-child { transform: none; }
.tl-hour:last-child { transform: translateX(-100%); }
/* 段悬浮自定义 tooltip：跟随鼠标，卡片内相对定位由 fixed 实现 */
.tl-tip {
  position: fixed; z-index: calc(var(--z-modal, 3000) + 10); pointer-events: none;
  background: var(--text-1, #303133); color: var(--panel, #fff);
  font-size: var(--fs-xs); padding: 5px 9px; border-radius: var(--radius-sm);
  white-space: nowrap; box-shadow: var(--shadow-pop, 0 4px 14px rgba(0,0,0,.18));
}
/* ============ GitHub 风格活跃热力图 ============ */
.hm-card { overflow: hidden; }
.hm-scroll { overflow-x: auto; padding-bottom: var(--space-1); scrollbar-width: thin; }
.hm-grid {
  display: grid; grid-auto-flow: row; gap: var(--space-1); width: 100%;
  grid-template-rows: repeat(7, auto);
}
/* min-width:0:1fr 轨道默认不小于内容宽,整年 53 列会撑出横向滚动条(用户反馈);方形靠 aspect-ratio 保持 */
.hm-cell { width: 100%; min-width: 0; aspect-ratio: 1 / 1; border-radius: 2.5px; display: inline-block; }
.hm-l0 { background: var(--gray-bg); }
.hm-l1 { background: color-mix(in srgb, var(--brand) 30%, var(--gray-bg)); }
.hm-l2 { background: color-mix(in srgb, var(--brand) 55%, var(--gray-bg)); }
.hm-l3 { background: color-mix(in srgb, var(--brand) 80%, var(--gray-bg)); }
.hm-l4 { background: var(--brand); }
.hm-legend { display: flex; align-items: center; gap: var(--space-1); margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text-3); justify-content: flex-end; }
/* ============ 图表卡（合并历史三层覆盖为单层，全 token 化） ============ */
.stat-subpage .single { margin-bottom: 18px; }
.stat-subpage .double { display: flex; gap: var(--space-4); margin-bottom: 18px; }
.stat-subpage .chart-b { flex: 1; border-radius: var(--radius-md); padding: 18px 20px; color: #fff; }
.stat-subpage .chart-b__title { font-size: var(--fs-md); margin-bottom: var(--space-2); }
.stat-subpage .chart-b__content__text { font-size: 20px; font-weight: 600; line-height: 1.3; }
.stat-subpage .chart-b__content__subcontent { display: flex; gap: var(--space-3); font-size: var(--fs-sm); margin-top: var(--space-1); }
.stat-subpage .chart-a { border-radius: var(--radius-md); padding: 16px 18px; display: flex; align-items: center; gap: 14px; }
.stat-subpage .chart-a__icon { width: 40px; height: 40px; }
.stat-subpage .chart-a__content { font-size: var(--fs-md); line-height: 1.6; }
.stat-subpage .chart-d { border-radius: var(--radius-md); padding: 18px 20px; text-align: center; }
.stat-subpage .chart-d__count { font-size: 20px; font-weight: 600; }
.stat-subpage .chart-d__content { font-size: var(--fs-md); margin-top: var(--space-1); }
.stat-subpage .chart-empty {
  min-height: 120px; display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: var(--fs-md); border-radius: var(--radius-md);
}
.review-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--brand); transform: translateY(-2px); }
/* KPI 对比条（品牌顶线 + 差值胶囊，单层） */
.kpi-row { display: flex; gap: 14px; max-width: 785px; margin: 0 auto 18px; }
.kpi-tile {
  flex: 1; padding: 14px 16px 12px; background: var(--panel, #fff);
  border: 1px solid var(--line); border-radius: var(--radius-lg);
}
.kpi-tile__title { font-size: var(--fs-sm); color: var(--text-3); }
.kpi-tile__value { margin-top: var(--space-1); font-size: 20px; font-weight: 600; color: var(--text-1); line-height: 1.2; }
.kpi-tile__sub { margin-top: 6px; font-size: var(--fs-xs); color: var(--text-3); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.kpi-delta { font-weight: 700; padding: 1px 8px; border-radius: var(--radius-pill); font-size: var(--fs-xs); }
.kpi-delta.good { color: var(--ok, #1f7a55); background: color-mix(in srgb, var(--ok, #2ba471) 12%, transparent); }
.kpi-delta.warn { color: var(--warn, #9c6009); background: color-mix(in srgb, var(--warn, #d08b1f) 14%, transparent); }
.kpi-delta.flat { color: var(--text-3); font-weight: 400; }
/* 注意力去向（分类条形） */
.att-rows { display: flex; flex-direction: column; gap: 10px; padding: 14px 4px 8px; }
.att-row { display: flex; align-items: center; gap: var(--space-3); }
.att-label { flex-shrink: 0; width: 90px; font-size: var(--fs-sm); color: var(--text-2); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.att-track { flex: 1; height: 14px; background: var(--gray-bg); border-radius: var(--radius-md); overflow: hidden; }
.att-bar { height: 100%; border-radius: var(--radius-md); background: var(--brand); transition: width var(--dur-slow) ease; }
.att-value { flex-shrink: 0; width: 72px; font-size: var(--fs-sm); color: var(--text-3); font-variant-numeric: tabular-nums; }
/* 热力图范围切换 */
.hm-range-toggle { display: inline-flex; gap: var(--space-1); margin: 0 10px; }
.hm-range-btn {
  border: 1px solid var(--line); background: none; color: var(--text-3);
  font-size: var(--fs-xs); padding: 2px 10px; border-radius: var(--radius-pill); cursor: pointer;
}
.hm-range-btn.on { color: var(--brand); border-color: var(--brand); background: var(--brand-light); }
/* ============ 图表卡工具风统一（token 化，去海报装饰） ============ */
.stat-subpage .chart-b { border-radius: var(--radius-md); padding: 18px 20px; }
.stat-subpage .chart-b__title { font-size: var(--fs-md); }
.stat-subpage .chart-b__content__text { font-size: 20px; font-weight: 600; line-height: 1.3; }
.stat-subpage .chart-a { border-radius: var(--radius-md); padding: 16px 18px; }
.stat-subpage .chart-a__content { font-size: var(--fs-md); }
.stat-subpage .chart-a__icon { width: 40px; height: 40px; }
.stat-subpage .chart-d { border-radius: var(--radius-md); }
.stat-subpage .chart-d__count { font-size: 20px; font-weight: 600; }
.stat-subpage .chart-empty {
  min-height: 120px; display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: var(--fs-md);
  border-radius: var(--radius-md);
}
/* 热力图自适应尺寸：半年大格填满卡片、整年紧凑，整体居中消除右侧空白 */
.hm-grid--half .hm-cell { border-radius: var(--radius-sm); }
.hm-grid--year .hm-cell { border-radius: var(--radius-xs); }
/* 极窄窗口兜底：列多时允许横向滚动，格子保持最小可辨识尺寸 */
.hm-scroll { scrollbar-width: thin; }
/* ============ 分享卡片（固定浅色渲染，与主题无关） ============ */
.share-style-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.share-dialog__foot { display: flex; justify-content: flex-end; gap: var(--space-2); }
.share-save { background: var(--brand); color: #fff; border-color: var(--brand); }
.share-save:hover { background: var(--brand-dark, #3b4bc4); color: #fff; }
.sc-brand { font-size: var(--fs-sm); letter-spacing: 2px; opacity: .75; }
.sc-period { font-size: var(--fs-sm); margin-top: var(--space-1); opacity: .85; }
.sc-headline { font-size: 20px; font-weight: 800; line-height: 1.55; margin: 16px 0 12px; }
.sc-list { margin: 0; padding: 0; list-style: none; }
.sc-list li { font-size: var(--fs-md); line-height: 1.8; opacity: .92; padding-left: 14px; position: relative; }
.sc-list li::before { content: ''; position: absolute; left: 0; top: .8em; width: 5px; height: 5px; border-radius: 50%; background: rgba(255, 255, 255, .8); }
.sc-foot { margin-top: var(--space-5); font-size: var(--fs-xs); opacity: .6; }
.sc-narrative { background: var(--brand); min-height: 260px; }
.sc-data { background: #23324f; min-height: 220px; }
.sc-kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 18px; }
.sc-kpi { background: rgba(255, 255, 255, .09); border-radius: var(--radius-lg); padding: 14px 16px; }
.sc-kpi__v { font-size: 24px; font-weight: 800; }
.sc-kpi__t { font-size: var(--fs-xs); opacity: .75; margin-top: 3px; }
.sc-mini { background: #17191e; min-height: 170px; display: flex; flex-direction: column; }
.sc-mini .sc-headline { flex: 1; }
.sc-mini__meta { font-size: var(--fs-sm); opacity: .7; }
/* ============ 复盘页改版二：视图页签 + 周期药丸 + 质感升级（去 emoji，SVG 图标） ============ */
.stat-view-tabs {
  display: inline-flex; gap: var(--space-1); padding: 3px;
  background: var(--gray-bg); border-radius: var(--radius-pill); margin-right: auto;
}
.stat-view-tab {
  border: 0; background: none; color: var(--text-2); font-size: var(--fs-sm);
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 14px; border-radius: var(--radius-pill); cursor: pointer;
  transition: color var(--dur-fast), background-color var(--dur-fast);
}
.stat-view-tab.on { background: var(--panel, #fff); color: var(--brand-text); font-weight: 600; box-shadow: 0 1px 4px rgba(31, 56, 88, .12); }
.stat-view-tab:not(.on):hover { color: var(--text-1); }
/* 周期行对齐内容线：药丸靠左接齐各节标题,日期范围推到内容线右端(用户反馈居中悬浮与上下脱节) */
.stat-period-pills { display: flex; align-items: center; gap: 6px; margin: 0 auto 20px; flex-wrap: wrap; }
/* 药丸为独立控件，外缘与卡片轴线对齐（696/1481），不再走旧内容线缩进（2026-08-31 用户确认） */
.stat-period-pills .stat-period-range { margin-left: auto; font-size: var(--fs-sm); color: var(--text-3); cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm, 4px); transition: color var(--dur-fast), background var(--dur-fast); }
.stat-period-pills .stat-period-range:hover { color: var(--brand); background: var(--hover-bg, rgba(127,140,153,.1)); }
.stat-period-pills .stat-period-range.custom { color: var(--brand); font-weight: 600; }
/* 自定义日期区间浮层（2026-08-31 用户定稿：点日期标签直接弹出，不展开成行） */
.stat-custom-range { display: flex; flex-direction: column; gap: 10px; }
.stat-custom-range__actions { display: flex; align-items: center; gap: 10px; }
.stat-custom-warn { font-size: var(--fs-xs, 11px); color: var(--warn, #d08b1f); }
.stat-period-pill {
  border: 1px solid var(--line); background: var(--panel, #fff); color: var(--text-2);
  font-size: var(--fs-sm); padding: 6px 16px; border-radius: var(--radius-pill); cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background-color var(--dur-fast);
}
.stat-period-pill:hover { color: var(--brand); border-color: var(--brand); }
.stat-period-pill.on { color: #fff; background: var(--brand-text); border-color: var(--brand-text); font-weight: 600; }
/* 统一卡片语言（2026-08-31 用户反馈"有的有灰底有的没有"）：复盘页所有块共用同一条左缘轴线——
   KPI 四格本身是卡，去掉 20px 内容线缩进，外缘与 tl-card 对齐；
   图表卡(折线/柱状 canvas 类)上同款面板底+16/20 内边距，内容仍落在同一条内容线上；彩色整卡(chart-a/d/h)属卡片层不在此列 */
.stat-subpage .chart-3.single, .stat-subpage .chart-4.single,
.stat-subpage .chart-5.single, .stat-subpage .chart-6.single {
  background: var(--panel, #fff); border-radius: var(--radius-md); padding: 16px 20px;
}
/* 周期之最 */
.best-row { display: flex; gap: 14px; padding: 14px 2px 8px; }
.best-item { flex: 1; padding: 14px 18px; background: var(--gray-bg); border-radius: var(--radius-md); }
.best-item__title { font-size: var(--fs-sm); color: var(--text-3); }
.best-item__value { font-size: 16px; font-weight: 600; color: var(--text-1); margin-top: var(--space-1); }
.best-item__sub { font-size: var(--fs-xs); color: var(--text-3); margin-top: 3px; }
/* 成就总览大数字 */
.ach-totals { display: flex; gap: 14px; padding: 16px 2px 6px; }
.ach-total { flex: 1; text-align: center; padding: 16px 10px; background: linear-gradient(160deg, rgba(15, 157, 143, .07), rgba(43, 179, 163, .06)); border-radius: var(--radius-md); }
.ach-total__v { font-size: 18px; font-weight: 600; color: var(--brand); line-height: 1.2; }
.ach-total__u { font-size: var(--fs-md); font-weight: 600; margin-left: 2px; }
.ach-total__t { font-size: var(--fs-sm); color: var(--text-3); margin-top: var(--space-1); }
/* 图例色块保持固定小尺寸（.hm-cell 现为自适应网格格，图例不随行伸缩） */
.hm-legend .hm-cell { width: 12px; height: 12px; flex-shrink: 0; }
/* 成就系统 v2：每族一张进度卡（当前值/下一级/进度条/已获得数） */
.ach-fams { display: flex; flex-direction: column; gap: 10px; }
@keyframes hm-tip-in { from { opacity: 0; transform: translate(-50%, calc(-100% - 4px)); } to { opacity: 1; transform: translate(-50%, calc(-100% - 8px)); } }
@keyframes hm-tip-in-below { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 14px); } }
</style>
