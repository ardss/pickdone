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
          <button v-if="filter" class="mini" @click="editVisible = true">{{ $t('statsJ.FilterView.editCond') }}</button>
          <button v-if="filter" class="mini danger" @click="delFilter">{{ $t('statsJ.FilterView.delFilter') }}</button>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <div v-if="!filter" class="empty"><div class="empty__icon"></div><div class="empty__text">{{ $t('statsJ.FilterView.notFound') }}</div></div>
      <div v-else-if="!list.length" class="empty"><div class="empty__icon"></div><div class="empty__text">{{ $t('statsC.TodoBox.empty') }}</div></div>
      <div v-else class="todo-box-list">
        <div v-for="t in list" :key="t.taskId" class="todo-box-list-item"
             :class="{ 'todo-box-list-item--selected': selectedId === t.taskId }"
             @click="openEdit(t)" @contextmenu.prevent="ctxMenu(t, $event)">
          <span class="todo-box-list-item__category-dot tb-dot-check" :style="{ color: dotColor(t) }" role="checkbox"
                :aria-checked="t.complete ? 'true' : 'false'" :aria-label="$t('statsC.TodoBox.ariaComplete')" :title="$t('statsC.TodoBox.titleComplete', { name: t.taskContent })" tabindex="0"
                @click.stop="completeItem(t)" @keydown.enter.prevent.stop="completeItem(t)" @keydown.space.prevent.stop="completeItem(t)">
            <svg viewBox="0 0 512 512"><path fill="currentColor" d="M256 8C119 8 8 119 8 256s111 248 248 248 248-111 248-248S393 8 256 8zm0 448c-110.5 0-200-89.5-200-200S145.5 56 256 56s200 89.5 200 200-89.5 200-200 200z"/></svg>
          </span>
          <div class="todo-box-list-item__container">
            <div class="todo-box-list-item__content"> {{ t.taskContent }} </div>
            <div class="todo-box-list-item__workload"
                 :class="{ 'todo-box-list-item__workload--lv2': estOf(t) >= 3 && estOf(t) <= 4, 'todo-box-list-item__workload--lv3': estOf(t) >= 5 }"></div>
          </div>
        </div>
      </div>
    </div>
    <filter-modal v-if="editVisible && filter" :filter="filter" @saved="saved" @close="editVisible = false"/>
  </div>
</template>

<script lang="ts">
/**
 * Filter view (saved smart lists) —— locally filters uncompleted tasks by filter.conds:
 * conds = { catId: -1|categoryId, priority: -1|0|1|2, dateMode: 'all'|'today'|'week'|'overdue'|'none' }
 * Render structure matches the todo box (todo-box-list-item row family); complete/edit/context-menu entries share the same source.
 */
import { taskContextMenu } from '../utils/taskMenu.js'
import { DEFAULT_CAT_COLOR, dayjs } from '../utils/core.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import FilterModal from '../components/FilterModal.vue'

export default {
  name: 'FilterView',
  components: { FilterModal },
  data () { return { editVisible: false } },
  computed: {
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
      if (c.priority != null && c.priority !== -1) parts.push(this.$t('statsJ.FilterView.prio') + c.priority)
      if (c.dateMode && c.dateMode !== 'all') parts.push(this.$t('statsJ.FilterView.dm_' + c.dateMode))
      return parts.join(' · ') || this.$t('statsJ.FilterView.condAll')
    },
    list () {
      const f = this.filter
      if (!f) return []
      const c = f.conds || {}
      const today0 = +dayjs().startOf('day')
      const weekEnd = +dayjs().endOf('isoWeek')
      return this.$store.state.todo.todoList.filter(t => {
        if (t.delete || t.complete) return false
        if (c.catId != null && c.catId !== -1 && (t.categoryId || 0) !== c.catId) return false
        if (c.priority != null && c.priority !== -1 && (t.priority || 0) !== c.priority) return false
        if (c.dateMode && c.dateMode !== 'all') {
          const d = t.dayStart || 0
          if (c.dateMode === 'today' && d !== today0) return false
          if (c.dateMode === 'week' && !(d >= today0 && d <= weekEnd)) return false
          if (c.dateMode === 'overdue' && !(d && d < today0)) return false
          if (c.dateMode === 'none' && d !== 0) return false
        }
        return true
      }).sort((a, b) => (a.taskSort || 0) - (b.taskSort || 0))
    },
    selectedId () { return this.$store.state.ui.rightSidebarTodoEdit.taskId }
  },
  methods: {
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
      await this.$store.dispatch('filters/remove', f.id)
      this.$router.replace({ name: 'todo-list-today' })
    },
    saved (id) {
      this.editVisible = false
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
