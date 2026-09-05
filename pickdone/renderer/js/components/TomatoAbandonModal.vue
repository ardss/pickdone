<template>

  <div class="modal modal--abandon" role="dialog" aria-modal="true" :aria-label="$t('statsP.TomatoAbandonModal.dialogAria')" @keydown.esc="cancelAbandon">
    <div class="abandon-card">
      <button type="button" class="abandon-x" :aria-label="$t('statsK.TomatoAbandonModal.close')" @click="cancelAbandon">
        <svg viewBox="0 0 14 14" width="12" height="12"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <div class="abandon-title">{{ $t('statsK.TomatoAbandonModal.title') }}</div>
      <p class="abandon-hint" v-html="$t('statsK.TomatoAbandonModal.hint', { min: '<b>' + focusedMin + '</b>' })"></p>
      <input v-model="reason" class="abandon-reason-input" maxlength="100" :placeholder="$t('statsP.TomatoAbandonModal.reasonPh')" @keydown.enter.prevent="confirmAbandon"/>
      <div class="abandon-actions">
        <button type="button" class="abandon-btn" @click="cancelAbandon">{{ $t('statsK.TomatoAbandonModal.continue') }}</button>
        <button type="button" class="abandon-btn abandon-btn--giveup" @click="confirmAbandon">{{ $t('statsK.TomatoAbandonModal.giveUp') }}</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Abandon-focus modal -- rendered independently at the layout level (not nested inside the tomato bar)
 * Reason: position:fixed degrades to relative positioning inside an ancestor with transform/filter, squeezing the modal into a tiny box within the tomato bar (verified by the user).
 * Optional reason input (may be left empty), persisted as abandonReason for review and AI retrospective.
 */

import dialogA11y from '../utils/dialogA11y.js'

export default {
  name: 'TomatoAbandonModal',
  mixins: [dialogA11y],
  data () { return { reason: '' } },
  computed: {
    // Minutes focused so far (store.startedAt is non-reactive; the value captured when the modal opens is enough)
    focusedMin () {
      const s = this.$store.state.tomato
      if (!s.startedAt) return '0'
      return String(Math.max(0, Math.floor((Date.now() - s.startedAt) / 60000)))
    }
  },
  methods: {
    confirmAbandon () {
      this.$store.dispatch('tomato/giveUp', { record: true, reason: this.reason })
      this.$store.commit('ui/closeTomatoAbandon')
      if (this.$announce) this.$announce(this.$t('statsK.TomatoAbandonModal.k125') + (this.reason ? this.$t('statsK.TomatoAbandonModal.reasonSuffix', { r: this.reason }) : ''))
    },
    cancelAbandon () {
      this.$store.commit('ui/closeTomatoAbandon')
    },
    stopNoise () {
      try { window.dispatchEvent(new CustomEvent('tomato-stop-noise')) } catch (e) { /* no-op */ }
    }
  },

}
</script>
