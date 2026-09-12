<template>
  <!-- Share card dialog: three styles (markup moved verbatim from StatisticsView.vue; el-dialog append-to-body keeps the DOM tree identical) -->
  <el-dialog :title="$t('statsA.StatisticsView.shareCreate')" :model-value="open" @update:model-value="v => !v && $emit('close')" width="420px" append-to-body class="share-dialog">
    <div class="share-style-tabs" role="radiogroup" :aria-label="$t('statsA.StatisticsView.ariaCardStyles')">
      <button v-for="s in shareStyles" :key="s.key" class="hm-range-btn"
              :class="{on: shareStyle===s.key}" role="radio" :aria-checked="shareStyle===s.key"
              @click="shareStyle=s.key">{{ s.label }}</button>
    </div>
    <!-- Preview area (fixed light rendering; share appearance is theme-independent) -->
    <div ref="shareCard">
      <div v-if="shareStyle==='narrative'" class="sc sc-narrative">
        <div class="sc-brand">{{ $t('statsA.StatisticsView.shareBrand') }}</div>
        <div class="sc-period">{{ periodLabel }} · {{ periodRange }}</div>
        <p class="sc-headline">{{ reviewHeadline }}</p>
        <ul class="sc-list">
          <li v-for="i in insights" :key="i.id">{{ $t(i.mainKey, i.mainParams) }}</li>
        </ul>
        <div class="sc-foot">{{ shareDate }}</div>
      </div>
      <div v-else-if="shareStyle==='data'" class="sc sc-data">
        <div class="sc-brand">{{ $t('statsA.StatisticsView.shareBrand') }}</div>
        <div class="sc-period">{{ periodLabel }} · {{ periodRange }}</div>
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
        <div class="sc-mini__meta">{{ $t('statsA.StatisticsView.shareMiniMeta', { n: heatmapStreak, date: shareDate }) }}</div>
      </div>
    </div>
    <template #footer>
      <div class="share-dialog__foot">
        <button class="mini" @click="$emit('close')">{{ $t('statsA.StatisticsView.cancel') }}</button>
        <button class="mini share-save" @click="saveShareCard">{{ $t('statsA.StatisticsView.saveImage') }}</button>
      </div>
    </template>
  </el-dialog>
</template>

<script lang="ts">
/**
 * Share card dialog extracted from StatisticsView.vue (2026-09-12 split, S1 pilot).
 * Pure presentation + PNG export; the open state stays owned by the parent (emits `close`).
 * All copy still resolves through the global statsA.* i18n shard — no keys moved.
 */
import { dayjs } from '../../utils/core.js'
import { loadScript, VENDOR } from '../../utils/lazy-script.js'

const T = 'statsA.StatisticsView.'

export default {
  name: 'StatsShareCard',
  props: {
    open: { type: Boolean, default: false },
    /** metrics.label — period name shown on the card */
    periodLabel: { type: String, default: '' },
    /** "MM.DD - MM.DD" range label */
    periodRange: { type: String, default: '' },
    reviewHeadline: { type: String, default: '' },
    /** top insights (key+params, resolved in template) */
    insights: { type: Array, default: () => [] },
    kpis: { type: Array, default: () => [] },
    heatmapStreak: { type: Number, default: 0 },
    shareDate: { type: String, default: '' },
    /** period key, used only in the exported file name */
    period: { type: String, default: '' }
  },
  emits: ['close'],
  data () {
    return { shareStyle: 'narrative' }
  },
  computed: {
    shareStyles () {
      return [
        { key: 'narrative', label: this.$t(T + 'shareStyleNarrative') },
        { key: 'data', label: this.$t(T + 'shareStyleData') },
        { key: 'mini', label: this.$t(T + 'shareStyleMini') }
      ]
    }
  },
  methods: {
    /* Share card: three style templates -> html2canvas PNG export (fixed light background for consistent share appearance) */
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
    }
  }
}
</script>
