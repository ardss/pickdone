<template>
  <!-- Pomodoro estimate/actual ledger row, extracted verbatim from EditPanel.vue (maint/dw-wave2 domain-2 split).
       Single ledger: estimated is editable (− number +), actual is read-only (reconciled from focus records;
       corrections go via the context-menu focus entry). Integrated control (user-finalized 2026-09-03):
       estimate stepper segment + actual segment share one equal-height housing; clicking the actual segment
       opens the ledger dialog. State + persistence stay in the parent. -->
  <div class="ep-row ep-tomato-est">
    <img class="ep-ico" src="app://app/assets/img/icon-tomato-timer2.svg" style="opacity:.6">
    <span class="ep-diff-label">{{ $t('statsG.EpTomato.est') }}</span><span class="hint-q" role="img" :title="$t('statsG.EpTomato.estTip')" :aria-label="$t('statsG.EpTomato.estTip')">?</span>
    <span class="ep-tom-account" :class="{gain: actual > 0}">
      <span class="ep-tom-seg ep-tom-seg--est">
        <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estDecrease')" @click.stop="$emit('est-delta', -1)">−</button>
        <span class="ep-tom-num">{{ estimate }}</span>
        <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estIncrease')" @click.stop="$emit('est-delta', 1)">+</button>
        <img class="ep-tom-ico" src="app://app/assets/img/icon-tomato-timer2.svg" alt="">
      </span>
      <span class="ep-tom-seg ep-tom-seg--act" role="button" tabindex="0"
            :title="$t('statsG.EpTomato.actTip')" @click.stop="$emit('open')" @keydown.enter.prevent.stop="$emit('open')">{{ $t('statsG.EpTomato.act') }} <b>{{ actual }}</b></span>
    </span>
  </div>
</template>

<script lang="ts">
/** Pomodoro estimate/actual row; purely presentational — the parent owns estDelta/openAccount and
 *  the tomatoEstimate/actualCountByTask data sources. */
export default {
  name: 'EpTomato',
  props: {
    /** current estimate (tomatoEstimateN in the parent, via utils/tomatoEstimate.js) */
    estimate: { type: Number, default: 0 },
    /** actual attributed focus count (parent getter tomato/actualCountByTask) */
    actual: { type: Number, default: 0 }
  },
  emits: ['est-delta', 'open']
}
</script>
