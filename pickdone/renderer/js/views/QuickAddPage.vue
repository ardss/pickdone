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

/** D6-F12 (updated D14-A9 2026-10-02): draft persistence for the mini window — covers ACCIDENTAL
 *  hides (blur / focus loss) only. An explicit Esc cancel DISCARDS the draft, matching the main
 *  window's QuickAdd (J1, uiux-2026-10-01). */
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
        // Review P3 (2026-09-22): draft restore moved into the focus callback (runs on EVERY summon);
        // [d21-A12] a re-summon during the pending auto-hide cancels it — the user wants the window
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null }
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
    // D6-F12 + review P3: draft persistence is idempotent — safe to call from mount, focus and blur.
    // D14-A9 scope note: persistence now covers ACCIDENTAL hides (blur/focus loss) only; an
    // explicit Esc cancel discards the draft (aligned with the main window's QuickAdd).
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
      // [d21-A12] any real keystroke cancels the pending post-create auto-hide (fast typing right
      // after creation used to race the 250ms timer). Esc still hides explicitly below.
      if (this._hideTimer && e.key !== 'Escape') { clearTimeout(this._hideTimer); this._hideTimer = null }
      // [D15-A2] IME guard (same contract as HabitView add / TomatoAbandonModal / EpTags):
      // the Enter/Esc key events that COMMIT or CANCEL a composition arrive with keyCode 229 /
      // isComposing set. Dismissing the IME candidate window with Esc used to be treated as an
      // explicit cancel — wiping the draft and hiding the mini window mid-composition.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        // D14-A9 (2026-10-02): Esc is an EXPLICIT cancel — discard the draft, matching the main
        // window's QuickAdd (J1, uiux-2026-10-01) which clears on Esc. The old persist-on-Esc
        // contradicted that newer behavior (and its own stale D6-F12 comment). Draft persistence
        // stays for ACCIDENTAL hides only (the blur path below); the restore-on-summon clears it.
        try { localStorage.removeItem(DRAFT_KEY) } catch { /* best-effort */ }
        if (this.$refs.qa) this.$refs.qa.text = ''
        window.todoAPI.quickAddHide()
      }
    },
    onCreated () {
      // The draft is consumed by a successful creation; clear it so a stale line never resurfaces
      try { localStorage.removeItem(DRAFT_KEY) } catch { /* best-effort */ }
      // [d21-A12] the 250ms auto-hide used to be a fire-and-forget timer: fast typing (or a
      // re-summon focus) within the window raced it. Store the handle, cancel it on keydown and
      // on re-summon focus, and hide only when the input is STILL empty.
      if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null }
      this._hideTimer = setTimeout(() => {
        this._hideTimer = null
        const qa = this.$refs.qa
        if (qa && qa.text && String(qa.text).trim()) return // user already typed again — keep the window up
        window.todoAPI.quickAddHide()
      }, 250)
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
