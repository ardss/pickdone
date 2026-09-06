<template>

  <div class="qapage" style="background:transparent">
    <div class="qapage__card">
      <quick-add ref="qa" @created="onCreated"/>
    </div>
  </div>
</template>

<script lang="ts">
/** Global quick-add window page —— a mini input bar summoned by the global shortcut from any screen (standalone BrowserWindow, route __quick-add).
 *  Reuses the main window's QuickAdd component (NL date parsing/creation pipeline fully shared); the window hides on successful creation or Esc.
 *  The mini window can't host a $message popup; success feedback is conveyed by the task appearing directly in the main window's list. */
import QuickAdd from '../components/QuickAdd.vue'

export default {
  name: 'QuickAddPage',
  components: { QuickAdd },
  mounted () {
    document.documentElement.classList.add('widget-transparent')
    // Same as the float window: document.title overrides the window title, which DWM ghost repaints draw as text (2026-09-02)
    document.title = ''
    // Route enforcement: same guard as the float window; on abnormal recovery, push back to itself to prevent a leftover main-window hash from landing here
    if (this.$route.name !== '__quick-add') {
      this.$router.push({ name: '__quick-add' }).catch(() => {})
    }
    this._offFocus = window.todoAPI.onQuickAddFocus
      ? window.todoAPI.onQuickAddFocus(() => { this.$nextTick(() => { this.$refs.qa && this.$refs.qa.focusInput() }) })
      : null
    window.addEventListener('keydown', this.onKey)
    this.$nextTick(() => this.$refs.qa && this.$refs.qa.focusInput())
  },
  beforeUnmount () {
    document.documentElement.classList.remove('widget-transparent')
    if (this._offFocus) this._offFocus()
    window.removeEventListener('keydown', this.onKey)
  },
  methods: {
    onKey (e) {
      if (e.key === 'Escape') window.todoAPI.quickAddHide()
    },
    onCreated () {
      // Pause briefly so the input clearing is visible, then hide
      setTimeout(() => window.todoAPI.quickAddHide(), 250)
    }
  },

}
</script>
