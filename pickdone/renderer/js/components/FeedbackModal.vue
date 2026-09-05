<template>

  <!-- 弹窗显隐由父层 v-if 驱动,本 transition 实际不参与动画 -->
  <transition name="fade">
    <div class="modal-container" @click.self="close">
      <div class="modal-tablecloth" @click.self="close">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('feedback.title')" style="width:460px;max-width:min(460px,92vw);max-height:88%">
          <div class="modal__header"><span>{{ $t('feedback.title') }}</span><div class="modal__close close-x" role="button" tabindex="0" :aria-label="$t('feedback.title')" @click="close" @keydown.enter.prevent="close"></div></div>
          <div class="modal__body">
            <div class="fb-type-row" role="radiogroup" :aria-label="$t('feedback.typeLabel')">
              <button v-for="t in types" :key="t.key" type="button" class="fb-type-btn"
                      :class="{on: type===t.key}" @click="type=t.key">{{ t.label }}</button>
            </div>

            <textarea v-model="desc" class="fb-desc" rows="4" maxlength="500"
                      :placeholder="$t('feedback.descPh')" :aria-label="$t('feedback.descLabel')"></textarea>
            <div class="fb-desc-count">{{ desc.length }}/500</div>

            <input v-model="contact" class="fb-contact" maxlength="60"
                   :placeholder="$t('feedback.contactPh')" :aria-label="$t('feedback.contactLabel')"/>

            <label class="fb-attach">
              <input type="checkbox" v-model="attachLog"/>
              <span>{{ $t('feedback.attachLog') }}</span>
            </label>
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
 * Submit channel is a placeholder: the feedback submit API is not wired up; currently staged in localStorage (feedbackPending)
 * When the backend is integrated later, just replace the staging logic in submitFeedback
 */
import { appVersion } from '../utils/core.js'
import dialogA11y from '../utils/dialogA11y.js'

export default {
  name: 'FeedbackModal',
  mixins: [dialogA11y],
  data () {
    return {
      type: 'bug',
      desc: '',
      contact: '',
      attachLog: true,
      submitting: false
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
  methods: {
    close () { this.$store.commit('ui/closeFeedback') },
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
        let arr = []
        try {
          const parsed = JSON.parse(localStorage.getItem('feedbackPending') || '[]')
          if (Array.isArray(parsed)) arr = parsed
        } catch (e) { /* corrupt -> start fresh */ }
        arr.push(payload)
        localStorage.setItem('feedbackPending', JSON.stringify(arr))
        this.$message.success(this.$t('feedback.submitted'))
        this.desc = ''
        this.contact = ''
        this.close()
      } catch (e) {
        this.$message.error(this.$t('feedback.submitFailed'))
      }
    }
  },

}
</script>
