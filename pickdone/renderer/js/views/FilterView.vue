<template>

  <div class="page box-page">
    <div class="page__header">
      <div class="title">
        <div class="title__prepend">
          <i class="icon-prepend"></i>
          <div class="title__text">{{ filter ? filter.name : $t('statsJ.FilterView.notFound') }}</div>
          <span class="filter-cond-text">{{ condText }}</span>
        </div>
        <div class="title__append">
          <span class="sn-badge">{{ list.length }}</span>
          <button v-if="filter" class="mini" @click="$store.commit('ui/toggleFilterModal', true)">{{ $t('statsJ.FilterView.editCond') }}</button>
          <button v-if="filter" class="mini danger" @click="delFilter">{{ $t('statsJ.FilterView.delFilter') }}</button>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <empty-state v-if="!filter"><template #text>{{ $t('statsJ.FilterView.notFound') }}</template></empty-state>
      <empty-state v-else-if="!list.length"><template #text>{{ $t('statsC.TodoBox.empty') }}</template></empty-state>
      <div v-else class="todo-box-list">
        <!-- [A7] role=button demoted from the row to the content (same TodoItem pattern): a button
             role wrapping role=checkbox children is broken ARIA nesting; the row stays a focusable
             container, the "open" semantics live on the content -->
        <div v-for="t in list" :key="t.taskId" class="todo-box-list-item"
             :class="{ 'todo-box-list-item--selected': selectedId === t.taskId }"
             tabindex="0"
             @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)" @contextmenu.prevent="ctxMenu(t, $event)">
          <span class="todo-box-list-item__category-dot tb-dot-check" :style="{ color: dotColor(t) }" role="checkbox"
                :aria-checked="t.complete ? 'true' : 'false'" :aria-label="$t('statsC.TodoBox.ariaComplete')" :title="$t('statsC.TodoBox.titleComplete', { name: t.taskContent })" tabindex="0"
                @click.stop="completeItem(t)" @keydown="onCompleteKey(t, $event)">
            <svg viewBox="0 0 512 512"><path fill="currentColor" d="M256 8C119 8 8 119 8 256s111 248 248 248 248-111 248-248S393 8 256 8zm0 448c-110.5 0-200-89.5-200-200S145.5 56 256 56s200 89.5 200 200-89.5 200-200 200z"/></svg>
          </span>
          <div class="todo-box-list-item__container">
            <div class="todo-box-list-item__content" role="button" tabindex="0" :aria-label="t.taskContent" @keydown="onContentKey(t, $event)"> {{ t.taskContent }} </div>
            <!-- [D18-DOM3] no estimate = no bar; tiering shared with TodoBoxView -->
            <div v-if="tierOf(t)" class="todo-box-list-item__workload"
                 :class="{ 'todo-box-list-item__workload--lv2': tierOf(t) === 2, 'todo-box-list-item__workload--lv3': tierOf(t) === 3 }"></div>
          </div>
        </div>
      </div>
    </div>
    <filter-modal v-if="showFilterModal && filter" :filter="filter" @saved="saved" @close="$store.commit('ui/toggleFilterModal', false)"/>
  </div>
</template>

<script lang="ts">
/**
 * Filter view (saved smart lists) —— locally filters uncompleted tasks by filter.conds:
 * conds = { catId: -1|categoryId, priority: -1|0|1|2, dateMode: 'all'|'today'|'week'|'overdue'|'none' }
 * Render structure matches the todo box (todo-box-list-item row family); complete/edit/context-menu entries share the same source.
 */
import { taskContextMenu } from '../utils/taskMenu.js'
import { DEFAULT_CAT_COLOR } from '../utils/core.js'
import { today0 } from '../utils/todayBounds.js'
import { isoWeekEnd } from '../utils/weekGrid.js'
import { matchesViewConds } from '../../../shared/filter-core.mjs' // D4 2026-09-24: saved-view matcher single source with db.js / cli applyViewConds
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { getEstimate, estimateTier } from '../utils/tomatoEstimate.js'
import FilterModal from '../components/FilterModal.vue'
import EmptyState from '../components/EmptyState.vue'
import { roleCheckboxActivate, roleButtonActivate } from '../utils/roleButtonKey.js' // [A8/D18-DOM3] Space+Enter activation

export default {
  name: 'FilterView',
  components: { FilterModal, EmptyState },
  // [maint-0925 A2] visibility lives in the ui store (ui.showFilterModal) so the global Esc guard
  // can see it; local component data was invisible to EditPanel._onKeydown
  computed: {
    showFilterModal () { return this.$store.state.ui.showFilterModal },
    filter () {
      const id = Number(this.$route.params.id)
      return this.$store.state.filters.list.find(f => f.id === id) || null
    },
    cats () { return this.$store.state.category.list.filter(c => !c.delete) },
    /** Condition summary (shown in the header) */
    condText () {
      const f = this.filter
      if (!f) return ''
      const c = f.conds || {}
      const parts = []
      if (c.catId != null && c.catId !== -1) {
        const cat = this.cats.find(x => x.categoryId === c.catId)
        parts.push(cat ? cat.categoryName : this.$t('statsJ.FilterView.uncategorized'))
      }
      // U-12: render the priority chip via the prio* label keys (priority 3 used to show as a bare "3")
      if (c.priority != null && c.priority !== -1) {
        const lbl = ['', this.$t('statsJ.TodoItem.prioLow'), this.$t('statsJ.TodoItem.prioMedium'), this.$t('statsJ.TodoItem.prioHigh')][c.priority]
        parts.push(this.$t('statsJ.FilterView.prio') + (lbl || c.priority))
      }
      if (c.dateMode && c.dateMode !== 'all') parts.push(this.$t('statsJ.FilterView.dm_' + c.dateMode))
      return parts.join(' · ') || this.$t('statsJ.FilterView.condAll')
    },
    list () {
      const f = this.filter
      if (!f) return []
      // Hard-Monday (isoWeek) window kept deliberately — pairs with cli/lib.js's week filter window;
      // whether it should follow settings.weekStartDay is pending product confirmation (see weekGrid.js).
      // D4 2026-09-24: the matcher itself moved to shared/filter-core.mjs (single source with db.js
      // conds parsing and cli/lib.js applyViewConds); done defaults to false = undone-only parity.
      const win = { today0: today0(), weekEnd: isoWeekEnd(Date.now()) }
      return this.$store.state.todo.todoList
        .filter(t => matchesViewConds(t, f.conds || {}, win))
        .sort((a, b) => (b.taskSort || 0) - (a.taskSort || 0)) // B8 (2026-09-24): display order is taskSort DESCENDING (sortMode.js custom mode) — the old ascending readout put pinned tasks at the bottom
    },
    selectedId () { return this.$store.state.ui.rightSidebarTodoEdit.taskId }
  },
  // [A2 review-fix] the flag moved out of component-local data into the ui store, so it no longer
  // resets itself on teardown: leaving the route with the modal open would leave showFilterModal
  // stuck true and the global Esc guard (EditPanel._onKeydown) swallowing Esc on every page
  beforeUnmount () {
    if (this.$store.state.ui.showFilterModal) this.$store.commit('ui/toggleFilterModal', false)
  },
  methods: {
    /* [A8] complete checkbox: Space joins Enter, stopped so the row's edit activation doesn't double-fire */
    onCompleteKey (t, e) {
      roleCheckboxActivate(function () { this.completeItem(t) }).call(this, e)
    },
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    openEdit (t) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
      this.$store.commit('ui/openEdit', raw)
    },
    completeItem (t) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: raw, announce: this.$announce })
    },
    ctxMenu (t, e) {
      // Unified task context menu (2026-08-31 consistency consolidation)
      taskContextMenu(this, t, e)
    },
    // 工作量条口径与待办箱对齐:按预估番茄分档,difficulty 字段已退役(2026-09-05 终审 P2)
    estOf (t) { return getEstimate(t.taskId) },
    /* [D18-DOM3] workload tiering shared with TodoBoxView: 0=unset(no bar) 1=1-2 2=3-4 3=5+ */
    tierOf (t) { return estimateTier(getEstimate(t.taskId)) },
    /* [D18-DOM3] row __content "open" button: Space joins Enter, stopped vs the row's own activation */
    onContentKey (t, e) { roleButtonActivate(function () { this.openEdit(t) }, { stop: true }).call(this, e) },
    dotColor (t) {
      const c = t.categoryId && this.$store.getters['category/byId'](t.categoryId)
      return (c && c.categoryColor) || DEFAULT_CAT_COLOR
    },
    async delFilter () {
      // The list may refresh while the confirm dialog is awaited and this.filter loses its reference — fetch once at click time and once at confirm time
      const clicked = this.filter
      if (!clicked) return
      try { await this.$confirm(this.$t('statsJ.FilterView.delConfirm', { n: clicked.name }), this.$t('statsJ.FilterView.delTitle'), { type: 'warning' }) } catch { return }
      const f = this.filter
      if (!f) return
      // P2 fix (2026-09-25): a failed delete used to bubble as an unhandled rejection and the view
      // navigated away anyway (the filter silently survived). Surface the error and stay put.
      try {
        await this.$store.dispatch('filters/remove', f.id)
      } catch (e) {
        this.$message.error(this.$t('statsJ.FilterView.delFilter') + ': ' + (e && e.message ? e.message : e))
        return
      }
      this.$router.replace({ name: 'todo-list-today' })
    },
    saved (id) {
      this.$store.commit('ui/toggleFilterModal', false)
      if (id && String(id) !== String(this.$route.params.id)) this.$router.replace({ name: 'todo-list-filter', params: { id: String(id) } })
    }
  },

}
</script>
<style>.box-page .icon-prepend{background-image:url(app://app/assets/img/icon-main-nav-todobox.svg)}
/* 待办箱圆点 = 完成入口（与其他视图勾选圈同语义）：悬停描边高亮，键盘可达 */
.tb-dot-check { cursor: pointer; border-radius: 50%; transition: transform .15s, box-shadow .15s, opacity .15s; }
.tb-dot-check:hover { box-shadow: 0 0 0 2px var(--brand-light); opacity: .85; }
.tb-dot-check:active { transform: scale(.88); }
.tb-dot-check:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.filter-cond-text { font-size: var(--fs-xs); color: var(--text-3); margin-left: var(--space-2); }
</style>
