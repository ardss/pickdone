<template>

  <div class="page box-page">
    <div class="page__header">
      <div class="title">
        <div class="title__prepend">
          <i class="icon-prepend"></i>
          <div class="title__text"> {{ $t('statsC.TodoBox.title') }} </div>
          <el-popover placement="top-start" width="300" trigger="hover"
                      :content="$t('statsC.TodoBox.tip')">
            <template #reference><span class="icon-append tip-icon dd-q">?</span></template>
          </el-popover>
        </div>
        <div class="title__append">
          <div class="dropdown-select" :class="{ 'is-open': openDd === 'sort' }">
            <el-popover placement="bottom-start" width="160" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'sort'" @hide="openDd = null">
              <ul class="dd-menu">
                <li v-for="m in sortMethodOptions" :key="m.value"
                    :class="{ on: m.value === settings.todoBoxSortMethod }" @click="setSort(m.value)">{{ m.label }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label">{{ sortMethodLabel }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <div class="dropdown-select" :class="{ 'is-open': openDd === 'order' }">
            <el-popover placement="bottom-start" width="120" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'order'" @hide="openDd = null">
              <ul class="dd-menu">
                <li v-for="o in sortOrderOptions" :key="o.value"
                    :class="{ on: o.value === settings.todoBoxSortOrder }" @click="setOrder(o.value)">{{ o.label }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label">{{ sortOrderLabel }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <div class="dropdown-select" :class="{ 'is-open': openDd === 'cat' }">
            <el-popover placement="bottom-start" width="180" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'cat'" @hide="openDd = null">
              <ul class="dd-menu">
                <li :class="{ on: settings.todoBoxCategoryId === -1 }" @click="setCat(-1)">{{ $t('statsC.TodoBox.allCats') }}</li>
                <li v-for="c in cats" :key="c.categoryId"
                    :class="{ on: c.categoryId === settings.todoBoxCategoryId }" @click="setCat(c.categoryId)">{{ c.categoryName }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label">{{ settings.todoBoxCategoryId === -1 ? $t('statsC.TodoBox.allCats') : catNameOf(settings.todoBoxCategoryId) }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <button class="mini" :class="{ primary: batchMode }" @click="toggleBatch">{{ batchMode ? $t('statsC.TodoBox.batchExit') : $t('statsC.TodoBox.batchManage') }}</button>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <div v-if="!list.length" class="empty">
        <div class="empty__icon"></div>
        <div class="empty__text">{{ $t('statsC.TodoBox.empty') }}</div>
      </div>
      <div v-else class="todo-box-list">
        <div v-for="t in list" :key="t.taskId" class="todo-box-list-item"
             :class="{ 'todo-box-list-item--selected': selectedId === t.taskId, 'todo-box-list-item--checked': batchMode && checkedIds.includes(t.taskId) }"
             @click="batchMode ? toggleCheck(t) : openEdit(t)" @contextmenu.prevent="ctxMenu(t, $event)">
          <span v-if="batchMode" class="tb-batch-check" :class="{ on: checkedIds.includes(t.taskId) }" role="checkbox"
                :aria-checked="checkedIds.includes(t.taskId) ? 'true' : 'false'" :aria-label="$t('statsC.TodoBox.ariaCheck')" @click.stop="toggleCheck(t)">✓</span>
          <span class="todo-box-list-item__category-dot tb-dot-check" :style="{ color: dotColor(t) }" role="checkbox"
                :aria-checked="t.complete ? 'true' : 'false'" :aria-label="$t('statsC.TodoBox.ariaComplete')" :title="$t('statsC.TodoBox.titleComplete', { name: t.taskContent })" tabindex="0"
                @click.stop="completeItem(t)" @keydown.enter.prevent.stop="completeItem(t)">
            <svg viewBox="0 0 512 512"><path fill="currentColor" d="M256 8C119 8 8 119 8 256s111 248 248 248 248-111 248-248S393 8 256 8zm0 448c-110.5 0-200-89.5-200-200S145.5 56 256 56s200 89.5 200 200-89.5 200-200 200z"/></svg>
          </span>
          <div class="todo-box-list-item__container">
            <div class="todo-box-list-item__drop-placeholder"></div>
            <div class="todo-box-list-item__content"> {{ t.taskContent }} </div>
            <!-- Workload bar: the difficulty field is retired, tiered by estimated pomodoros (1-2/3-4/5+) — estimated pomodoros are the single workload ledger -->
            <div class="todo-box-list-item__workload"
                 :class="{ 'todo-box-list-item__workload--lv2': estOf(t) >= 3 && estOf(t) <= 4, 'todo-box-list-item__workload--lv3': estOf(t) >= 5 }"></div>
          </div>
        </div>
      </div>
      <transition name="fade">
        <div v-if="batchMode && checkedIds.length" class="tb-batch-bar">
          <span>{{ $t('statsC.TodoBox.selectedCount', { n: checkedIds.length }) }}</span>
          <span class="ml-auto"></span>
          <button class="mini" @click="batchToday">{{ $t('statsC.TodoBox.btnToday') }}</button>
          <el-dropdown trigger="click" @command="batchCat">
            <button class="mini">{{ $t('statsC.TodoBox.btnMoveToCat') }}</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item :command="0">{{ $t('statsC.TodoBox.uncategorized') }}</el-dropdown-item>
                <el-dropdown-item v-for="c in cats" :key="c.categoryId" :command="c.categoryId">{{ c.categoryName }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <button class="mini danger" @click="batchDelete">{{ $t('statsC.TodoBox.btnDelete') }}</button>
          <button class="mini" @click="toggleBatch">{{ $t('statsC.TodoBox.btnDone') }}</button>
        </div>
      </transition>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Todo box (project baseline route todo-list-todo-box)
 * Structure aligned with the project baseline render function:
 *   todo-page-layout > .page__header > .title
 *     .title__prepend: i.icon-prepend (todo box icon) + .title__text + question-circle hint bubble
 *     .title__append: three dropdowns for sort mode / sort order / category filter
 *   body: [empty] .empty "no schedules"; [non-empty] .todo-box-list > .todo-box-list-item*
 * Item = i.__category-dot (list-colored dot) + .__container (.__content + .__workload difficulty bar)
 */
import { taskContextMenu } from '../utils/taskMenu.js'
import { DEFAULT_CAT_COLOR } from '../utils/core.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { batchMoveWithUndo } from '../utils/confirm.js'
import { showUndoToast } from '../utils/undoToast.js'
import { getEstimate } from '../utils/tomatoEstimate.js'

export default {
  name: 'TodoBoxView',
  data () {
    return { batchMode: false, checkedIds: [], openDd: null }
  },
  computed: {
    settings () { return this.$store.state.settings },
    // value is the persisted stable key; label is the display text resolved via $t
    sortMethodOptions () {
      return [
        { value: 'created', labelKey: 'statsC.TodoBox.sortByCreate' },
        { value: 'due', labelKey: 'statsC.TodoBox.sortByDue' },
        { value: 'difficulty', labelKey: 'statsC.TodoBox.sortByDifficulty' }
      ].map(o => ({ ...o, label: this.$t(o.labelKey) }))
    },
    sortOrderOptions () {
      return [
        { value: 'desc', labelKey: 'statsC.TodoBox.orderDesc' },
        { value: 'asc', labelKey: 'statsC.TodoBox.orderAsc' }
      ].map(o => ({ ...o, label: this.$t(o.labelKey) }))
    },
    sortMethodLabel () { const o = this.sortMethodOptions.find(x => x.value === this.settings.todoBoxSortMethod); return o ? o.label : this.settings.todoBoxSortMethod },
    sortOrderLabel () { const o = this.sortOrderOptions.find(x => x.value === this.settings.todoBoxSortOrder); return o ? o.label : this.settings.todoBoxSortOrder },
    cats () { return this.$store.state.category.list.filter(c => !c.delete) },
    list () { return this.$store.state.todo.views.todoBox },
    selectedId () { const ed = this.$store.state.ui.rightSidebarTodoEdit; return ed.visible ? ed.taskId : null }
  },
  methods: {
    estOf (t) { return getEstimate(t.taskId) },
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    set (patch) { this.$store.commit('settings/updateSettings', patch); this.$store.dispatch('todo/computeViews') },
    setSort (v) { this.set({ todoBoxSortMethod: v }) },
    setOrder (v) { this.set({ todoBoxSortOrder: v }) },
    setCat (v) { this.set({ todoBoxCategoryId: v }) },
    catNameOf (id) {
      const c = this.cats.find(x => x.categoryId === id)
      return c ? c.categoryName : ''
    },
    dotColor (t) {
      const c = t.categoryId && this.$store.getters['category/byId'](t.categoryId)
      return (c && c.categoryColor) || DEFAULT_CAT_COLOR
    },
    openEdit (t) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
      this.$store.commit('ui/openEdit', raw)
    },
    /* Dot doubles as the checkbox: the todo box item's completion entry matches other views; undated tasks get completedAt=now and count toward today */
    completeItem (t) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: raw, announce: this.$announce })
    },
    /* ===== Batch management ===== */
    toggleBatch () {
      this.batchMode = !this.batchMode
      this.checkedIds = []
    },
    toggleCheck (t) {
      const i = this.checkedIds.indexOf(t.taskId)
      if (i >= 0) this.checkedIds.splice(i, 1)
      else this.checkedIds.push(t.taskId)
    },
    // Batch move goes through the unified utils exit (snapshots original values, one undo within 5s restores the whole group), same layer as single-item moveWithUndo
    async batchToday () {
      const ts = +window.dayjs().startOf('day')
      // Filter against the current list first: dead ids deleted elsewhere during batching are excluded so the toast count matches reality
      const alive = this.checkedIds.filter(id => this.$store.state.todo.todoList.some(x => x.taskId === id))
      const snap = []
      for (const id of alive) {
        const raw = this.$store.state.todo.todoList.find(x => x.taskId === id)
        if (!raw) continue
        snap.push({ id, dayStart: raw.dayStart, todoTime: raw.todoTime })
        await this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: { dayStart: ts, todoTime: ts } })
      }
      this.$message.closeAll()
      batchMoveWithUndo(this, {
        label: this.$t('statsC.TodoBox.msgToday', { n: snap.length }),
        snap,
        revertOf: r => this.$store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { dayStart: r.dayStart, todoTime: r.todoTime } })
      })
      this.checkedIds = []
    },
    async batchCat (catId) {
      const alive = this.checkedIds.filter(id => this.$store.state.todo.todoList.some(x => x.taskId === id))
      const snap = []
      for (const id of alive) {
        const raw = this.$store.state.todo.todoList.find(x => x.taskId === id)
        if (!raw) continue
        snap.push({ id, categoryId: raw.categoryId })
        await this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: { categoryId: catId } })
      }
      this.$message.closeAll()
      batchMoveWithUndo(this, {
        label: this.$t('statsC.TodoBox.msgMoveCat', { n: snap.length, name: this.catNameOf(catId) || this.$t('statsC.TodoBox.uncategorized') }),
        snap,
        revertOf: r => this.$store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { categoryId: r.categoryId } })
      })
      this.checkedIds = []
    },
    async batchDelete () {
      const n = this.checkedIds.length
      try { await this.$confirm(this.$t('statsC.TodoBox.confirmDelete', { n }), this.$t('statsC.TodoBox.confirmTitle'), { type: 'warning' }) } catch { return }
      // Snapshot the ids first: checkedIds is cleared right after deletion, so reading it later in the undo closure would always be empty (root cause of the dead undo button)
      const ids = [...this.checkedIds]
      for (const id of ids) {
        const raw = this.$store.state.todo.todoList.find(x => x.taskId === id)
        if (raw) await this.$store.dispatch('todo/deleteTodo', raw)
      }
      // Undo: batch-restore from the recycle bin (after soft delete the rows are no longer in todoList, so recycleList must be queried)
      const undoDelete = async () => {
        for (const id of ids) {
          const raw = this.$store.state.todo.recycleList.find(x => x.taskId === id)
          if (raw) await this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: { delete: false, deletedAt: 0, status: 'update' } })
        }
        this.$message.closeAll()
      }
      // Unified exit showUndoToast (hover pauses / ✕ closes); the hand-rolled $message version was removed (interaction contract ①)
      showUndoToast(this.$message.bind(this), [
        this.$t('statsC.TodoBox.msgDeleted', { n }) + '　',
        this.$createElement('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undoDelete }, this.$t('statsC.TodoBox.undoDelete'))
      ])
      this.checkedIds = []
    },
    ctxMenu (t, e) {
      // Unified task context menu (2026-08-31 consistency consolidation): one set of semantics for edit/complete/move date/pomodoro/copy/recycle bin
      taskContextMenu(this, t, e)
    }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* ---- I. 工具栏下拉 label（原 DropdownSelect 的 .dropdown-select__label）---- */
.dropdown-select{display:flex;gap:8px}
.dropdown-select__label{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;line-height:20px;border-radius:var(--radius-pill);font-size:var(--fs-md);color:var(--text-2);cursor:pointer;transition:background .15s,color .15s}
.dropdown-select__label:hover{background:var(--gray-bg);color:var(--text-1)}
.dropdown-select__label:active{background:var(--line)}
.dropdown-select.is-open .dropdown-select__label{background:var(--gray-bg);color:var(--text-1)}
.dropdown-select__label:disabled{cursor:not-allowed;opacity:.5}
.dropdown-select__label:disabled:hover{background:transparent}
.dropdown-select__label--placeholder{color:var(--text-3)}
.dropdown-select__label:hover .dd-caret::before{border-color:var(--text-2)}
.dropdown-select.is-open .dd-caret::before{transform:rotate(225deg) translate(-1px,-1px)}
/* 其它 */
html[data-theme="dark"] .dropdown-select__label { color: var(--text-1); }
html[data-theme="dark"] .dropdown-select__label:hover,
html[data-theme="dark"] .dropdown-select.is-open .dropdown-select__label { background: var(--hover-bg); color: var(--text-1); }
</style>
