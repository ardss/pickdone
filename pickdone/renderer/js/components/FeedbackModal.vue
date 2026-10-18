<template>

  <!-- Modal visibility is driven by the parent's v-if; this transition is not actually animated -->
  <!-- [F3-UX] the fb-* form controls below are styled in the scoped block at the bottom of this file -->

  <transition name="fade">
    <div class="modal-container" @click.self="close">
      <div class="modal-tablecloth" @click.self="close">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('feedback.title')" style="width:460px;max-width:min(460px,92vw);max-height:88%" @keydown.esc="close">
          <!-- D14-A16: the X must announce "close", not the dialog title (TaskAccountModal pattern) -->
          <div class="modal__header"><span>{{ $t('feedback.title') }}</span><div class="modal__close close-x" role="button" tabindex="0" :aria-label="$t('feedback.close')" @click="close" @keydown.enter.prevent="close"></div></div>
          <div class="modal__body">
            <!-- D14-A11: real radiogroup semantics — role=radio + aria-checked + Arrow key roving
                 (a radiogroup of plain buttons announced nothing about selection state) -->
            <div class="fb-type-row" role="radiogroup" :aria-label="$t('feedback.typeLabel')" @keydown="onTypeKeydown">
              <button v-for="t in types" :key="t.key" type="button" class="fb-type-btn"
                      role="radio" :aria-checked="type===t.key ? 'true' : 'false'" :tabindex="type===t.key ? 0 : -1"
                      :class="{on: type===t.key}" @click="type=t.key">{{ t.label }}</button>
            </div>

            <textarea v-model="desc" class="fb-desc" rows="4" maxlength="500"
                      :placeholder="$t('feedback.descPh')" :aria-label="$t('feedback.descLabel')"></textarea>
            <div class="fb-desc-count">{{ desc.length }}/500</div>

            <input v-model="contact" class="fb-contact" maxlength="60"
                   :placeholder="$t('feedback.contactPh')" :aria-label="$t('feedback.contactLabel')"/>

            <!-- D14-A2: the renderer has no access to the diagnostic log file (it lives in the main
                 process and logger.js exposes no tail reader), so the checkbox used to attach
                 NOTHING while claiming to. Honest minimal fix: disable it and say so — the flag
                 still travels with the payload for when the submit channel lands. -->
            <label class="fb-attach" :title="$t('feedback.attachLogPending')">
              <input type="checkbox" v-model="attachLog" disabled/>
              <span>{{ $t('feedback.attachLog') }}</span>
            </label>
            <!-- D14-A1: honesty about staging — feedback is stored on THIS device only (no submit
                 channel exists by design); surface the local queue instead of faking an upload -->
            <div class="fb-pending" v-if="pendingCount">{{ $t('feedback.pendingNote', { n: pendingCount }) }}</div>
          </div>
          <div class="modal__footer">
            <button class="mini" @click="close">{{ $t('feedback.cancel') }}</button>
            <button class="mini primary" :disabled="submitting || !desc.trim()" @click="submit">{{ $t('feedback.submit') }}</button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
/**
 * User feedback modal -- type / description / contact / optional diagnostic log attachment
 * D14-A1 (2026-10-02, product-decision skip): the submit channel remains UNWIRED by design —
 * there is no backend and none is being invented here; the finding's "register the upload
 * integration" item is recorded as a product decision to skip. What changed is honesty only:
 * the success toast no longer claims "submitted", it says the feedback is staged on this
 * device, the modal shows the local queue size, and overwriting the oldest staged entry when
 * the cap is hit now warns instead of dropping silently.
 * When a backend IS integrated later, replace the staging logic in submit() only.
 */
import { appVersion } from '../utils/core.js'
import dialogA11y from '../utils/dialogA11y.js'

/** P3-9 (maint/dw 2026-09-23): max locally-staged feedback entries (see submit()). */
const PENDING_CAP = 20

export default {
  name: 'FeedbackModal',
  mixins: [dialogA11y],
  data () {
    return {
      type: 'bug',
      desc: '',
      contact: '',
      // [P2 fix] this used to be `true`: the disabled-but-CHECKED box claimed a diagnostic log
      // was being attached. Reality: the renderer cannot read the log (D14-A2 above) and the
      // payload only stages the boolean locally — nothing attaches. Render the truth: unchecked
      // + disabled, with the tooltip explaining why.
      attachLog: false,
      submitting: false,
      pendingCount: 0
    }
  },
  computed: {
    types () {
      return [
        { key: 'bug', label: this.$t('feedback.typeBug') },
        { key: 'feature', label: this.$t('feedback.typeFeature') },
        { key: 'experience', label: this.$t('feedback.typeExperience') },
        { key: 'other', label: this.$t('feedback.typeOther') }
      ]
    }
  },
  mounted () {
    // D14-A1: surface the locally-staged queue size while the modal is open
    try {
      const parsed = JSON.parse(localStorage.getItem('feedbackPending') || '[]')
      this.pendingCount = Array.isArray(parsed) ? parsed.length : 0
    } catch (e) { this.pendingCount = 0 }
  },
  methods: {
    close () { this.$store.commit('ui/closeFeedback') },
    // D14-A11: Arrow Left/Right/Up/Down roving across the type radios (radio-group contract)
    onTypeKeydown (e) {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
      if (!keys.includes(e.key)) return
      e.preventDefault()
      const i = this.types.findIndex(t => t.key === this.type)
      const delta = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1
      this.type = this.types[(i + delta + this.types.length) % this.types.length].key
    },
    async submit () {
      if (!this.desc.trim()) { this.$message.warning(this.$t('feedback.needDesc')); return }
      this.submitting = true
      try {
        // [Placeholder] Feedback submit channel: replace this when the backend is integrated later
        // Expected payload: { type, desc, contact, attachLog, appVersion, locale, ts }
        const payload = {
          type: this.type,
          desc: this.desc.trim(),
          contact: this.contact.trim(),
          attachLog: this.attachLog,
          appVersion: appVersion(),
          locale: this.$i18n ? this.$i18n.locale : 'zh-CN',
          ts: Date.now()
        }
        // Stage locally (can be batch-uploaded later); corrupted data falls back to an empty array so push can't throw and lose user feedback
        // P3-9 (maint/dw 2026-09-23): the staging array used to grow without bound — cap it at
        // PENDING_CAP, dropping the OLDEST entry first (newest feedback is the most actionable).
        // D14-A1: the drop is no longer silent — the user is told their oldest entry was overwritten.
        let arr = []
        try {
          const parsed = JSON.parse(localStorage.getItem('feedbackPending') || '[]')
          if (Array.isArray(parsed)) arr = parsed
        } catch (e) { /* corrupt -> start fresh */ }
        arr.push(payload)
        let dropped = 0
        while (arr.length > PENDING_CAP) { arr.shift(); dropped++ }
        localStorage.setItem('feedbackPending', JSON.stringify(arr))
        this.pendingCount = arr.length
        // D14-A1: honest copy — feedback is saved on THIS device, nothing was uploaded
        this.$message.success(this.$t('feedback.submittedLocal'))
        if (dropped > 0) this.$message.warning(this.$t('feedback.pendingDropped', { n: dropped }))
        this.desc = ''
        this.contact = ''
        this.close()
      } catch (e) {
        this.$message.error(this.$t('feedback.submitFailed'))
      } finally {
        // [F4] the flag must reset on the failure path too — a rejected submit used to leave
        // submitting=true and the button disabled forever (the success path closes the modal,
        // so only failures were stuck).
        this.submitting = false
      }
    }
  },

}
</script>

<style>
/* [F3-UX] FeedbackModal had zero styling for its fb-* form controls (naked/unreadable modal).
   Visual language follows the app modal family (.mini / .modal__body controls): token-driven
   so both light and dark themes resolve via the shared --* variables. */
.fb-type-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.fb-type-btn {
  border: 1px solid var(--line-strong); background: var(--panel, #fff); color: var(--text-2);
  border-radius: var(--radius-md); padding: 4px 12px; font-size: var(--fs-sm); cursor: pointer;
}
.fb-type-btn:hover { border-color: var(--brand); color: var(--brand); }
.fb-type-btn.on {
  border-color: var(--brand); color: var(--brand); background: var(--brand-light);
}
.fb-desc, .fb-contact {
  display: block; width: 100%; box-sizing: border-box;
  border: 1px solid var(--line-strong); background: var(--panel, #fff); color: var(--text-1);
  border-radius: var(--radius-md); padding: 8px 10px; font-size: var(--fs-sm); font-family: inherit;
}
.fb-desc { resize: vertical; min-height: 72px; }
.fb-desc:focus, .fb-contact:focus { border-color: var(--brand); outline: none; }
.fb-desc-count { text-align: right; margin: 4px 0 10px; font-size: var(--fs-xs); color: var(--text-3); }
.fb-contact { margin-bottom: 12px; }
.fb-attach { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--text-2); cursor: not-allowed; }
.fb-attach input { accent-color: var(--brand); }
.fb-pending { margin-top: 10px; font-size: var(--fs-xs); color: var(--text-3); }
</style>
