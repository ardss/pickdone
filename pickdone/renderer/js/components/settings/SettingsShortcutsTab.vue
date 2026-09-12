<template>
  <!-- Shortcuts: key capture controls (extracted from SettingsModal.vue, W5 wave 1; zero behavior change) -->
  <div class="tab-panel">
    <div class="form">
      <div class="form-label">{{ $t('statsE.SettingsModal.shortcutsSection') }}</div>
      <template v-for="sc in shortcutDefs" :key="sc.key">
        <div class="form-item">
          <span class="form-item__label">{{ sc.label }}</span>
          <div class="form-item__control">
            <button type="button" class="sc-capture" :class="{listening: capturing===sc.key, conflict: hasConflict(sc.key)}"
                    tabindex="0"
                    @click="startCapture(sc.key)" @blur="onCaptureBlur">
              <span class="sc-kbd">{{ capturing===sc.key ? $t('statsE.SettingsModal.scPressKey') : (shortcutsLoaded ? formatShortcut(shortcutForm[sc.key]) : $t('statsE.SettingsModal.loadingPlaceholder')) }}</span>
            </button>
            <span v-if="capturing!==sc.key" class="tip">{{ $t('statsE.SettingsModal.scClickToEdit') }}</span>
          </div>
        </div>
      </template>
      <div class="form-item" v-if="capturing"><span class="form-item__hint">{{ $t('statsE.SettingsModal.scCaptureHint') }}</span></div>
      <div class="form-item"><span class="form-item__label"></span>
        <div class="form-item__control"><button class="primary mini-lg" @click="saveShortcuts">{{ $t('statsE.SettingsModal.saveShortcutBtn') }}</button></div></div>
      <div class="form-item"><span class="form-item__label"></span>
        <div class="form-item__control"><button class="mini" @click="resetShortcuts">{{ $t('statsE.SettingsModal.resetDefaultBtn') }}</button></div></div>
    </div>
  </div>
</template>

<script lang="ts">
/** Shortcuts tab of the settings center: the full key-capture suite
 *  (startCapture/handleCaptureKey/conflict detection/dirty/save) plus the fc970da
 *  loading-placeholder logic (kbd slots show a placeholder until getSettings resolves).
 *  Extracted verbatim from SettingsModal.vue (W5 wave 1) — no prop contract, talks to the
 *  settings store directly, exactly like the parent did. Generic form-control styles
 *  (.form-item/.sc-capture) stay in the parent's global stylesheet. */
export default {
  name: 'SettingsShortcutsTab',
  data () {
    return {
      // Empty skeleton before the async response arrives: the template renders before created's getSettings resolves; null would blow up with "reading 'toggleMainWindow'"
      shortcutForm: { sync: '', toggleMainWindow: '', quickAddGlobal: '', addEvent: '', deleteEvent: '' },
      // [component-r5] false until created's getSettings resolves: kbd slots show the loading placeholder instead of a blank skeleton
      shortcutsLoaded: false,
      capturing: null as any
    }
  },
  computed: {
    shortcutDefs () {
      return [
        { key: 'toggleMainWindow', label: this.$t('statsE.SettingsModal.scToggleWin') },
        { key: 'quickAddGlobal', label: this.$t('statsE.SettingsModal.scQuickAddGlobal') },
        { key: 'addEvent', label: this.$t('statsE.SettingsModal.scAddEvent') },
        { key: 'deleteEvent', label: this.$t('statsE.SettingsModal.scDeleteEvent') },
        { key: 'pinEvent', label: this.$t('statsE.SettingsModal.scPin') },
        { key: 'unpinEvent', label: this.$t('statsE.SettingsModal.scUnpin') },
        { key: 'toggleAllSubtasks', label: this.$t('statsE.SettingsModal.scSubtasks') },
        { key: 'startPomodoro', label: this.$t('statsE.SettingsModal.scPomodoro') },
        { key: 'sync', label: this.$t('statsE.SettingsModal.scSync') },
        { key: 'switchToDaytodo', label: this.$t('statsE.SettingsModal.scNavToday') },
        { key: 'switchToRecentTodos', label: this.$t('statsE.SettingsModal.scNavRecent') },
        { key: 'switchToSchedule', label: this.$t('statsE.SettingsModal.scNavCalendar') },
        { key: 'switchToInbox', label: this.$t('statsE.SettingsModal.scNavInbox') }
      ]
    },
    shortcutDirty () {
      // Snapshot not yet resolved (getSettings pending/failed): there is no discardable state,
      // so isDirty must be false — otherwise confirm-discard JSON.parses undefined and throws,
      // leaving the settings modal impossible to close
      if (this._shortcutSnapshot === undefined) return false
      return !!this.shortcutForm && this._shortcutSnapshot !== JSON.stringify(this.shortcutForm)
    }
  },
  created () {
    window.todoAPI.getSettings().then(c => {
      this.shortcutForm = Object.assign({ sync: '', toggleMainWindow: '', quickAddGlobal: '', addEvent: '', deleteEvent: '' }, c.shortcutKeySettings)
      this._shortcutSnapshot = JSON.stringify(this.shortcutForm)
      this.shortcutsLoaded = true
    }).catch(e => { this.shortcutsLoaded = true; console.error('[SettingsModal] getSettings', e) })
  },
  beforeUnmount () {
    this.stopCapture()
  },
  methods: {
    // -- Shortcut capture (control-ized: click to enter listening state, document capture phase takes over the keyboard) --
    startCapture (key) {
      if (this.capturing === key) { this.stopCapture(); return } // clicking again cancels
      this.stopCapture()
      this.capturing = key
      this._docKeyHandler = e => this.handleCaptureKey(e, key)
      document.addEventListener('keydown', this._docKeyHandler, true) // capture: true
    },
    stopCapture () {
      if (this._docKeyHandler) { document.removeEventListener('keydown', this._docKeyHandler, true); this._docKeyHandler = null }
      this.capturing = null
    },
    cancelCapture () { this.stopCapture() },
    handleCaptureKey (e, key) {
      if (this.capturing !== key) return
      e.preventDefault()
      e.stopPropagation()
      const k = (e.key || '').toLowerCase()
      if (k === 'escape') { this.stopCapture(); return } // Esc = cancel capture
      if (!k || k === 'control' || k === 'alt' || k === 'shift' || k === 'meta') return // do not commit when only modifier keys are pressed
      const parts = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      const map = { ' ': 'space', delete: 'delete' }
      const main = map[k] || k
      const combo = parts.concat(main).join('+')
      // Conflict detection: if it duplicates another shortcut, warn and do not write
      if (this.shortcutDefs.some(d => d.key !== key && this.shortcutForm[d.key] === combo)) {
        // The colon lives inside the i18n value: each locale punctuates with its own glyph
        this.$message.warning(this.$t('statsE.SettingsModal.shortcutConflictMsg', { combo }))
        this.stopCapture()
        return
      }
      this.shortcutForm[key] = combo
      this.stopCapture()
    },
    onCaptureBlur () { this.stopCapture() },
    hasConflict (key) {
      if (!this.shortcutForm) return false // the template renders before created's async response arrives
      const val = this.shortcutForm[key]
      if (!val) return false
      return this.shortcutDefs.some(d => d.key !== key && this.shortcutForm[d.key] === val)
    },
    formatShortcut (v) { return v || this.$t('statsE.SettingsModal.scEmpty') },
    resetShortcuts () {
      this.shortcutForm = { sync: 'ctrl+s', addEvent: 'ctrl+n', deleteEvent: 'ctrl+d', toggleMainWindow: 'ctrl+alt+t', quickAddGlobal: 'alt+shift+t', pinEvent: 'ctrl+p', unpinEvent: 'ctrl+shift+p', toggleAllSubtasks: 'ctrl+shift+s', startPomodoro: 'ctrl+alt+p', switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4' }
    },
    saveShortcuts () {
      // Same ledger as the parent's set(): go through the settings/update action in one hop so
      // the store's shortcutKeySettings is committed AND config.json is written. A bare
      // todoAPI.updateSettings left the store stale and the dbMirror debounce then wrote the
      // old value back over it (old shortcuts resurfaced on the next launch).
      const snap = JSON.parse(JSON.stringify(this.shortcutForm))
      this.$store.dispatch('settings/update', { shortcutKeySettings: snap })
      this._shortcutSnapshot = JSON.stringify(this.shortcutForm)
      this.$message.success(this.$t('statsE.SettingsModal.shortcutSavedMsg'))
      if (this.$announce) this.$announce(this.$t('statsE.SettingsModal.shortcutSavedMsg'))
    },
    /* Parent-facing dirty contract: the modal's close() warns about unsaved shortcut edits
       and discards them on confirm (behavior preserved from the pre-split monolith). */
    isDirty () { return this.shortcutDirty },
    discard () {
      if (this._shortcutSnapshot === undefined) return // snapshot never loaded: nothing to discard
      this.shortcutForm = JSON.parse(this._shortcutSnapshot)
    }
  }
}
</script>
