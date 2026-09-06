<template>

  <div>
    <!-- modelType 2 -> div.double > chart-b(direction:left) + 25px spacer + chart-b(direction:right) -->
    <div v-if="kind==='double'" class="double">
      <div class="chart-b double__item" :style="{background:model.leftBackColor}">
        <div class="chart-b__title">{{ model.leftTitle }}</div>
        <div class="chart-b__content">
          <div class="chart-b__content__text">{{ model.leftContent }}</div>
          <div class="chart-b__content__subcontent"><div>{{ model.leftDataExplain }}</div><div>{{ model.leftDataRate }}</div></div>
        </div>
      </div>
      <div style="width:25px"></div>
      <div class="chart-b double__item" :style="{background:model.rightBackColor}">
        <div class="chart-b__title">{{ model.rightTitle }}</div>
        <div class="chart-b__content">
          <div class="chart-b__content__text">{{ model.rightContent }}</div>
          <div class="chart-b__content__subcontent"><div>{{ model.rightDataExplain }}</div><div>{{ model.rightDataRate }}</div></div>
        </div>
      </div>
    </div>

    <!-- modelType 1/layoutId 0 -> chart-a (icon + content; without backColor, white background with dark text) -->
    <div v-else-if="kind==='a'" class="chart-a single"
         :style="{background:model.backColor||fallbackBg}">
      <img v-if="model.imageUrl" class="chart-a__icon" :src="model.imageUrl">
      <div class="chart-a__content" :style="model.backColor?null:{color:fallbackText}">{{ model.content }}</div>
    </div>

    <!-- modelType 1/layoutId 1 -> chart-d big-number card (without backColor, white background with #333/#979797 text) -->
    <div v-else-if="kind==='d'" class="chart-d single"
         :style="{background:model.backColor||fallbackBg}">
      <div class="chart-d__count" :style="model.backColor?null:{color:fallbackText}">{{ model.title }}</div>
      <div class="chart-d__content" :style="model.backColor?null:{color:fallbackSub}">{{ model.subTitle }}</div>
    </div>

    <!-- modelType 3/4/5/6 -> chart-c/e/f/g: title + subtitle + canvas + summary footer -->
    <div v-else-if="canvasKind" :class="'single chart-'+canvasKind">
      <div v-if="model.title" :class="'chart-'+canvasKind+'__title'">{{ model.title }}</div>
      <div v-if="model.subTitle" :class="'chart-'+canvasKind+'__subtitle'">{{ model.subTitle }}</div>
      <div v-if="!model.chartList || !model.chartList.length || listAllZero" class="chart-empty">{{ $t('statsA.ChartCard.empty') }}</div>
      <div v-else class="chart-box"><canvas ref="canvas" :class="'chart-'+canvasKind+'__chart'"></canvas></div>
      <div v-if="model.summary" :class="'chart-'+canvasKind+'__footer'">{{ model.summary }}</div>
    </div>

    <!-- modelType 88 -> chart-h premium account upgrade card -->
    <div v-else-if="kind==='h'" class="chart-h single">
      <div class="chart-h__pic"></div>
      <div class="chart-h__title">{{ model.content }}</div>
      <div class="chart-h__btn"><button class="base-button"> {{ $t('statsA.ChartCard.upgrade') }} </button></div>
    </div>

    <!-- Fallback: mirrors .none "chart not adapted" + a pre showing the raw data -->
    <div v-else class="none single" style="color:var(--text-1,#333);font-size:12px"> {{ $t('statsA.ChartCard.notAdapted') }}<br><pre style="white-space:pre-wrap">{{ JSON.stringify(model) }}</pre></div>
  </div>
</template>

<script lang="ts">
/**
 * Statistics page chart card component (split out from StatisticsView) — dispatches by modelType to
 * chart-a/d (static card) / double (two columns) / c/e/f/g (canvas charts) / h (upgrade prompt) / none (fallback).
 */
import { chartCConfig, chartEConfig, chartFConfig, chartGConfig, isDarkTheme } from './chartConfigs.js'
import { loadScript, VENDOR } from '../../utils/lazy-script.js'

const ChartCard = {
  name: 'ChartCard',
  props: { model: { type: Object, required: true }, idx: { type: Number, default: 0 } },
  data () { return { theme: isDarkTheme() ? 'dark' : 'light' } },
  computed: {
    kind () {
      const m = this.model
      if (m.modelType === 1 && m.layoutId === 0) return 'a'
      if (m.modelType === 1 && m.layoutId === 1) return 'd'
      if (m.modelType === 2) return 'double'
      if ([3, 4, 5, 6].includes(m.modelType)) return String(m.modelType)
      if (m.modelType === 88) return 'h'
      return 'none'
    },
    canvasKind () { return ['3', '4', '5', '6'].includes(this.kind) ? this.kind : null },
    listAllZero () { const l = this.model.chartList || []; return !l.length || l.every(i => !i.value) },
    list () { return this.model.chartList || [] },
    dark () { return this.theme === 'dark' },
    /** Fallback card background when there's no backColor (dark #1c1f26 / light white) */
    fallbackBg () { return this.dark ? '#1c1f26' : '#ffffff' },
    /** Fallback text color (dark #e8eaed / light #333) */
    fallbackText () { return this.dark ? '#e8eaed' : '#333' },
    /** Fallback secondary text color (dark #8b919c / light #979797) */
    fallbackSub () { return this.dark ? '#8b919c' : '#979797' },
    config () {
      switch (this.canvasKind) {
        case '3': return chartCConfig(this.list, this.model.baselineValue, this.model.legendLabel)
        case '4': return chartEConfig(this.list, this.model.overlayList)
        case '5': return chartFConfig(this.list)
        case '6': return chartGConfig(this.list)
        default: return null
      }
    }
  },
  watch: {
    // Legend copy enters the Canvas via chartConfigs' tt(); a locale change requires manual redraw
    '$i18n.locale' () { this.renderChart() }
  },
  mounted () {
    this.renderChart()
    // Theme-switch reactivity: observes the data-theme attribute; on change, updates and re-renders the chart
    this._themeMo = new MutationObserver(() => {
      const next = isDarkTheme() ? 'dark' : 'light'
      if (next !== this.theme) { this.theme = next; this.$nextTick(() => this.renderChart()) }
    })
    this._themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  },
  beforeUnmount () {
    this.destroyChart()
    if (this._themeMo) this._themeMo.disconnect()
  },
  methods: {
    destroyChart () {
      if (this._chart) { this._chart.destroy(); this._chart = null }
    },
    renderChart () {
      this.destroyChart()
      if (!this.config || this.canvasKind !== String(this.model.modelType)) return
      // Chart.js lazy load (2026-09-02 startup optimization): injected on first draw, re-entering this function after injection
      if (!window.Chart) {
        loadScript(VENDOR.chart).then(() => this.renderChart()).catch(() => {})
        return
      }
      const el = this.$refs.canvas
      if (el) {
        const cfg = JSON.parse(JSON.stringify(this.config))
        cfg.options = Object.assign({}, cfg.options, { responsive: true, maintainAspectRatio: false })
        // Chart growth animation: unified easing for bars/rings/lines (overriding a possible animation:false in older configs)
        cfg.options.animation = Object.assign({ duration: 700, easing: 'easeOutQuart' }, cfg.options.animation || {})
        // Dark theme: only modify this chart instance (don't pollute global Chart.defaults,
        // which once permanently grayed chart text app-wide after switching back to light — sharp review P0-2)
        if (this.dark && cfg.options) {
          cfg.options.color = '#b8bdc7'
          const darkGrid = 'rgba(255,255,255,.08)'
          const scales = cfg.options.scales
          if (scales) {
            if (scales.y && scales.y.grid) scales.y.grid.color = darkGrid
            if (scales.r && scales.r.grid) scales.r.grid.color = darkGrid
            if (scales.r && scales.r.angleLines) scales.r.angleLines = Object.assign({}, scales.r.angleLines, { color: darkGrid })
          }
        }
        this._chart = new window.Chart(el, cfg)
      }
    }
  },

}

export default ChartCard
</script>
