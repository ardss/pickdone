<template>

  <div class="modal modal--abandon" role="dialog" aria-modal="true" :aria-label="$t('statsP.TomatoAbandonModal.dialogAria')" @keydown.esc="cancelAbandon">
    <div class="abandon-card">
      <button type="button" class="abandon-x" :aria-label="$t('statsK.TomatoAbandonModal.close')" @click="cancelAbandon">
        <svg viewBox="0 0 14 14" width="12" height="12"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
      <div class="abandon-title">{{ $t('statsK.TomatoAbandonModal.title') }}</div>
      <p class="abandon-hint" v-html="$t('statsK.TomatoAbandonModal.hint', { min: '<b>' + focusedMin + '</b>' })"></p>
      <input v-model="reason" class="abandon-reason-input" maxlength="100" :placeholder="$t('statsP.TomatoAbandonModal.reasonPh')" @keydown.enter.prevent="onReasonEnter"/>
      <div class="abandon-actions">
        <button type="button" class="abandon-btn" @click="cancelAbandon">{{ $t('statsK.TomatoAbandonModal.continue') }}</button>
        <button type="button" class="abandon-btn abandon-btn--giveup" :disabled="busy" @click="confirmAbandon">{{ $t('statsK.TomatoAbandonModal.giveUp') }}</button>
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
import { focusedMinutesText } from '../utils/tomatoShared.js'

export default {
  name: 'TomatoAbandonModal',
  mixins: [dialogA11y],
  data () { return { reason: '', busy: false } },
  computed: {
    // Minutes focused so far (store.startedAt is non-reactive; the value captured when the modal opens is enough).
    // A13 (2026-10-02): formula moved to utils/tomatoShared.js focusedMinutesText (single source).
    focusedMin () {
      return focusedMinutesText(this.$store.state.tomato.startedAt)
    }
  },
  methods: {
    // IME guard: the Enter that commits a composition (keyCode 229) must not abandon the focus session
    onReasonEnter (e) {
      if (e.isComposing || e.keyCode === 229) return
      this.confirmAbandon()
    },
    // [D22 P2] giveUp is now AWAITED: the modal used to announce success before the dispatch
    // resolved, and a failed abandon was silent (user believes it landed). The optimistic close
    // stays synchronous (the modal leaving is the immediate acknowledgement; also pinned by
    // tests/unit/components/tomato-abandon-modal-ime.test.mjs), but the success announce waits
    // for the dispatch and a FAILURE reopens the modal (reason preserved) with an error toast.
    confirmAbandon () {
      if (this.busy) return
      this.busy = true
      this.stopNoise() // U-17: actually fire the stop-noise event (main.js listens and stops the player)
      this.$store.commit('ui/closeTomatoAbandon') // optimistic close (synchronous; pinned by the IME regression test)
      const announce = () => this.$announce(this.$t('statsK.TomatoAbandonModal.k125') + (this.reason ? this.$t('statsK.TomatoAbandonModal.reasonSuffix', { r: this.reason }) : ''))
      this.$store.dispatch('tomato/giveUp', { record: true, reason: this.reason })
        .then(() => { this.busy = false; announce() })
        .catch(e => {
          console.error('[tomato] giveUp failed:', e)
          this.busy = false
          this.$store.commit('ui/openTomatoAbandon') // reopen: the abandon did NOT land, retry stays possible
          if (this.$message) this.$message.error(this.$t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
        })
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
