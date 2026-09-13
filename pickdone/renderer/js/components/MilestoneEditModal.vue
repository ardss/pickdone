<template>
  <transition name="fade">
    <div class="modal-container" @click.self="close">
      <div class="modal-tablecloth" @click.self="close">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="title" style="width:420px;max-width:min(420px,92vw)">
          <div class="modal__header"><span>{{ title }}</span><div class="modal__close close-x" role="button" tabindex="0" :aria-label="title" @click="close" @keydown.enter.prevent="close"></div></div>
          <div class="modal__body">
            <div class="msm-field">
              <label class="msm-label" for="msm-title">{{ $t('statsB.ProjectView.msContent') }}</label>
              <input id="msm-title" ref="titleInput" v-model="title" class="msm-input" maxlength="60"
                     :placeholder="$t('statsB.ProjectView.msPhExample')" :aria-label="$t('statsB.ProjectView.msContent')"
                     @keydown.enter.prevent="save"/>
            </div>
            <div class="msm-field">
              <label class="msm-label" for="msm-date">{{ $t('statsB.ProjectView.msDateField') }}</label>
              <el-date-picker id="msm-date" v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false"
                              :placeholder="$t('statsB.ProjectView.msDatePh')" :aria-label="$t('statsB.ProjectView.msDateField')"
                              class="msm-date"/>
            </div>
          </div>
          <div class="modal__footer">
            <button class="mini" @click="close">{{ $t('statsB.ProjectView.msCancel') }}</button>
            <button class="mini primary" :disabled="!canSave" @click="save">{{ $t('statsB.ProjectView.msSave') }}</button>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
/**
 * Milestone add/edit — ONE dialog with title + date side by side (replaces the old two-step
 * ElMessageBox.prompt flow, which made date editing look broken). Parent v-if controls visibility;
 * `milestone` null = add mode, otherwise pre-fills for edit. Emits save({title, date: 'YYYY-MM-DD'}).
 */
export default {
  name: 'MilestoneEditModal',
  props: {
    milestone: { type: Object, default: null }
  },
  emits: ['close', 'save'],
  data () {
    return {
      title: this.milestone ? this.milestone.title : '',
      date: this.milestone ? this.tsToDate(this.milestone.date) : ''
    }
  },
  computed: {
    canSave () { return !!this.title.trim() && !!this.date }
  },
  mounted () {
    this.$nextTick(() => { try { this.$refs.titleInput.focus() } catch { /* headless */ } })
  },
  methods: {
    tsToDate (ts) {
      const d = new Date(ts)
      const p = n => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    },
    close () { this.$emit('close') },
    save () {
      if (!this.title.trim() || !this.date) return
      this.$emit('save', { title: this.title.trim(), date: this.date })
    }
  }
}
</script>

<style>
/* Milestone edit dialog fields; modal chrome (header/close-x/footer) comes from the shared modal-container system */
.msm-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.msm-label { font-size: var(--fs-xs); color: var(--text-3); }
.msm-input {
  height: 32px; padding: 0 10px; border: 1px solid var(--line-strong, #e4e7ed); border-radius: var(--radius-sm, 6px);
  background: var(--panel, #fff); color: var(--text-1); font-size: var(--fs-sm, 13px); outline: none;
  transition: border-color var(--t-fast);
}
.msm-input:focus { border-color: var(--brand); }
.msm-date { width: 100%; }
</style>
