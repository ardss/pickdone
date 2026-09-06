<template>

  <main style="display:contents">
    <h1 class="sr-only">{{ $t('app.name') }}</h1>
  <div class="app-shell">
    <div class="sr-only" aria-live="polite" role="status">{{ announce }}</div>
    <win-controls/>
    <side-nav/>
    <section class="main-col">
      <div class="view-head" v-if="showQuickAdd">
        <quick-add class="qa-wrap"/>
        <!-- Right-panel expand button (the old collapsed thin strip ep-rail moved here; Notion/Linear-style top-right panel toggle) -->
        <button v-if="editVisible && editCollapsed" class="view-more-btn ep-expand" :title="$t('statsH.layout.expandEditPanel')" :aria-label="$t('statsH.layout.expandEditPanel')" @click="$store.commit('ui/expandEdit')">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10 3.5 L5 8 L10 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <!-- The Today page's ⋮ sits at the right end of the view-switch row (TodayView); other routes keep it at the header's right edge -->
        <view-more-menu v-if="!isToday"/>
      </div>
      <div class="main-scroll">
        <router-view/>
      </div>
      <tomato-bar v-if="tomatoVisible"/>
      <tomato-panel v-if="$store.state.ui.tomatoPanelVisible"/>
      <tomato-abandon-modal v-if="$store.state.ui.tomatoAbandonVisible"/>
        <task-account-modal/>
      <tomato-focus-record v-if="$store.state.ui.tomatoFocusRecordVisible"/>
    </section>
    <edit-panel v-if="editVisible && !editCollapsed"/>
    <context-menu-host/>
    <repeat-modal v-if="$store.state.ui.showRepeatModalFor"/>
    <repeat-delete-modal v-if="$store.state.ui.showRepeatDeleteConfirm"/>
    <settings-modal v-if="$store.state.ui.showSettingsModal"/>
    <feedback-modal v-if="$store.state.ui.showFeedbackModal"/>
    <onboarding/>
  </div>
  </main>
</template>

<script lang="ts">
/** Three-column main layout: sidebar | main content area (quick add + views + tomato focus bar) | right edit panel (when selected) */
import SideNav from './components/SideNav.vue'
import { navKeyOfRoute } from './views/registry.js'
import EditPanel from './components/EditPanel.vue'
import TomatoAbandonModal from './components/TomatoAbandonModal.vue'
import TomatoBar from './components/TomatoBar.vue'
import QuickAdd from './components/QuickAdd.vue'
import TomatoPanel from './components/TomatoPanel.vue'
import TomatoFocusRecord from './components/TomatoFocusRecordModal.vue'
import TaskAccountModal from './components/TaskAccountModal.vue'
import WinControls from './components/WinControls.vue'
import ViewMoreMenu from './components/ViewMoreMenu.vue'
import ContextMenuHost from './components/ContextMenuHost.vue'
import RepeatModal from './components/RepeatModal.vue'
import RepeatDeleteModal from './components/RepeatDeleteModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import FeedbackModal from './components/FeedbackModal.vue'
import Onboarding from './components/Onboarding.vue'

export default {
  name: 'AppLayout',
  components: { SideNav, EditPanel, TomatoBar, TaskAccountModal, TomatoAbandonModal, QuickAdd, TomatoPanel, TomatoFocusRecord, WinControls, ViewMoreMenu, ContextMenuHost, RepeatModal, RepeatDeleteModal, SettingsModal, FeedbackModal, Onboarding },
  data () { return { announce: '' } },
  methods: {
    announceMsg (m) {
      this.announce = ''
      this.$nextTick(() => { this.announce = m })
    }
  },
  computed: {
    /** Navigation key for the current route (activeNav can be stale on direct URL entry/refresh; visibility is always decided by the route) */
    routeNav () {
      const name = this.$route && this.$route.name
      if (name === 'todo-list-category' || name === 'todo-list-tag') return 'category'
      if (name === 'todo-list-filter') return 'filter' // The filter page doesn't show the quick-add bar (creation results can't be guaranteed to match the conditions)
      return navKeyOfRoute(name) || ''
    },
    showQuickAdd () {
      // Reference: list views have a quick-add bar on top; stats/search/calendar pages don't. The filter page also hides it: creation results can't be guaranteed to match the filter conditions — a context-free entry
      return !['statistics', 'calendar', 'search', 'filter'].includes(this.routeNav)
    },
    editVisible () { return this.$store.state.ui.rightSidebarTodoEdit.visible },
    editCollapsed () { return this.$store.state.ui.rightSidebarTodoEdit.collapsed },
    isToday () { return this.$route.name === 'todo-list-today' },
    tomatoVisible () {
      const st = this.$store.state.tomato
      // Design-finalized: the full tomato bar only on Today's todos (focus's home ground); other views show a narrow strip only while focus/rest is running (TomatoBar decides its render form internally)
      if (st.status && st.status !== 'default') return true
      return this.routeNav === 'today'
    }
  },

  watch: {
    // When the edit panel opens, ensure the window is wide enough for sidebar 250 + edit 335 + content 640 (auto-widen)
    '$store.state.ui.rightSidebarTodoEdit.visible' (v) {
      if (v && window.todoAPI) window.todoAPI.ensureWindowWidth(1225)
    }
  },
  mounted () {
    // Click anywhere outside the panel auto-collapses the expanded edit panel.
    // The listener is attached only while the panel is visible (attached on the next tick, to avoid counting "the click that opened the panel" as an outside click)
    this._onDocClick = (e) => {
      const st = this.$store.state.ui.rightSidebarTodoEdit
      if (!st.visible || st.collapsed) return
      if (e.target.closest && e.target.closest('.edit-panel')) return
      // Clicks inside dialogs (repeat rules/settings/tomato records etc.) don't count as "outside the panel" — canceling/generating after setting a repeat shouldn't also collapse the edit panel
      if (e.target.closest && e.target.closest('.modal-container')) return
      this.$store.commit('ui/collapseEdit')
    }
    this.$watch('editVisible', (v) => {
      if (v) this._attachTimer = setTimeout(() => { this._attachTimer = null; document.addEventListener('mousedown', this._onDocClick) }, 0)
      else document.removeEventListener('mousedown', this._onDocClick)
    }, { immediate: true })
  },
  beforeUnmount () {
    if (this._attachTimer) clearTimeout(this._attachTimer)
    document.removeEventListener('mousedown', this._onDocClick)
  }
}
</script>
