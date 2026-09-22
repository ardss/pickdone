<template>

  <div class="qapage" style="background:transparent">
    <div class="qapage__card">
      <!-- quiet: the success toast would be destroyed with this window 250ms later; hiding the window is the ack -->
      <quick-add ref="qa" quiet @created="onCreated"/>
    </div>
  </div>
</template>

<script lang="ts">
/** Global quick-add window page —— a mini input bar summoned by the global shortcut from any screen (standalone BrowserWindow, route __quick-add).
 *  Reuses the main window's QuickAdd component (NL date parsing/creation pipeline fully shared); the window hides on successful creation or Esc.
 *  The mini window can't host a $message popup; success feedback is conveyed by the task appearing directly in the main window's list. */
import QuickAdd from '../components/QuickAdd.vue'

/** D6-F12: draft persistence for the mini window (Esc used to silently discard the typed text) */
const DRAFT_KEY = 'quickAddDraft'

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
      ? window.todoAPI.onQuickAddFocus(() => {
        // Review P3 (2026-09-22): the window is hidden-not-destroyed on hide, so mounted()'s one-shot
        // restore never ran again — draft restore moved into the focus callback (runs on EVERY summon)
        this.$nextTick(() => { this.restoreDraft(); this.$refs.qa && this.$refs.qa.focusInput() })
      })
      : null
    window.addEventListener('keydown', this.onKey)
    // Persist on blur too: hide paths other than Esc (focus loss) used to silently drop the draft
    window.addEventListener('blur', this.persistDraft)
    // D6-F12: restore a draft left by a previous Esc-hide so the mini window behaves like the
    // main window's quick-add bar (which keeps its text while mounted)
    this.restoreDraft()
    this.$nextTick(() => this.$refs.qa && this.$refs.qa.focusInput())
  },
  beforeUnmount () {
    document.documentElement.classList.remove('widget-transparent')
    if (this._offFocus) this._offFocus()
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('blur', this.persistDraft)
  },
  methods: {
    // D6-F12 + review P3: draft persistence is idempotent — safe to call from mount, focus and blur
    restoreDraft () {
      try {
        const draft = localStorage.getItem(DRAFT_KEY)
        if (draft && this.$refs.qa && !this.$refs.qa.text) this.$refs.qa.text = draft
      } catch { /* draft persistence is best-effort */ }
    },
    persistDraft () {
      try {
        const qa = this.$refs.qa
        const txt = qa && qa.text ? qa.text : ''
        if (txt.trim()) localStorage.setItem(DRAFT_KEY, txt)
        else localStorage.removeItem(DRAFT_KEY)
      } catch { /* best-effort */ }
    },
    onKey (e) {
      if (e.key === 'Escape') {
        // D6-F12: persist the draft before hiding instead of silently discarding it
        this.persistDraft()
        window.todoAPI.quickAddHide()
      }
    },
    onCreated () {
      // The draft is consumed by a successful creation; clear it so a stale line never resurfaces
      try { localStorage.removeItem(DRAFT_KEY) } catch { /* best-effort */ }
      // Pause briefly so the input clearing is visible, then hide
      setTimeout(() => window.todoAPI.quickAddHide(), 250)
    }
  },

}
</script>
<style>
/* 独立 BrowserWindow 为 frameless+transparent：页面根须透明（QuickAdd/番茄浮窗在 <html> 上挂 widget-transparent） */
html.widget-transparent,
html.widget-transparent body,
html.widget-transparent #app {
  background: transparent !important;
  height: 100%;
  overflow: hidden;
}
/* —— 全局快速添加小窗（scoped）：悬浮输入条卡片 —— */
.qapage { width: 100%; height: 100%; display: flex; align-items: flex-start; justify-content: center; }
.qapage__card {
  width: 100%; border-radius: var(--radius-lg); background: var(--panel, #fff);
  box-shadow: 0 8px 32px rgba(0,0,0,.18); padding: 8px 6px;
}
</style>
