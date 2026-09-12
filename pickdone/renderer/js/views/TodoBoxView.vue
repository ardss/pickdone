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
                <li v-for="m in sortMethodOptions" :key="m.value" tabindex="0"
                    :class="{ on: m.value === settings.todoBoxSortMethod }" @click="setSort(m.value)" @keydown.enter.prevent="setSort(m.value)">{{ m.label }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label" role="button" tabindex="0" @keydown.enter.prevent="tbTriggerKey">{{ sortMethodLabel }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <div class="dropdown-select" :class="{ 'is-open': openDd === 'order' }">
            <el-popover placement="bottom-start" width="120" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'order'" @hide="openDd = null">
              <ul class="dd-menu">
                <li v-for="o in sortOrderOptions" :key="o.value" tabindex="0"
                    :class="{ on: o.value === settings.todoBoxSortOrder }" @click="setOrder(o.value)" @keydown.enter.prevent="setOrder(o.value)">{{ o.label }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label" role="button" tabindex="0" @keydown.enter.prevent="tbTriggerKey">{{ sortOrderLabel }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <div class="dropdown-select" :class="{ 'is-open': openDd === 'cat' }">
            <el-popover placement="bottom-start" width="180" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'cat'" @hide="openDd = null">
              <ul class="dd-menu">
                <li :class="{ on: settings.todoBoxCategoryId === -1 }" tabindex="0" @click="setCat(-1)" @keydown.enter.prevent="setCat(-1)">{{ $t('statsC.TodoBox.allCats') }}</li>
                <li v-for="c in cats" :key="c.categoryId" tabindex="0"
                    :class="{ on: c.categoryId === settings.todoBoxCategoryId }" @click="setCat(c.categoryId)" @keydown.enter.prevent="setCat(c.categoryId)">{{ c.categoryName }}</li>
              </ul>
              <template #reference><span class="dropdown-select__label" role="button" tabindex="0" @keydown.enter.prevent="tbTriggerKey">{{ settings.todoBoxCategoryId === -1 ? $t('statsC.TodoBox.allCats') : catNameOf(settings.todoBoxCategoryId) }}<i class="dd-caret">&#9662;</i></span></template>
            </el-popover>
          </div>
          <button class="mini" :class="{ primary: batchMode }" @click="toggleBatch">{{ batchMode ? $t('statsC.TodoBox.batchExit') : $t('statsC.TodoBox.batchManage') }}</button>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <empty-state v-if="!list.length"><template #text>{{ $t('statsC.TodoBox.empty') }}</template></empty-state>
      <div v-else class="todo-box-list">
        <div v-for="t in list" :key="t.taskId" class="todo-box-list-item"
             :class="{ 'todo-box-list-item--selected': selectedId === t.taskId, 'todo-box-list-item--checked': batchMode && checkedIds.includes(t.taskId) }"
             @click="batchMode ? toggleCheck(t) : openEdit(t)" @contextmenu.prevent="ctxMenu(t, $event)">
          <span v-if="batchMode" class="tb-batch-check" :class="{ on: checkedIds.includes(t.taskId) }" role="checkbox" tabindex="0"
                :aria-checked="checkedIds.includes(t.taskId) ? 'true' : 'false'" :aria-label="$t('statsC.TodoBox.ariaCheck')" @click.stop="toggleCheck(t)" @keydown.enter.prevent.stop="toggleCheck(t)">✓</span>
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
import { batchMoveWithUndo, deleteWithUndo } from '../utils/confirm.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import EmptyState from '../components/EmptyState.vue'

// [navgate-fix] pure-start (extracted by tests/unit-navgate-fix-ui.test.mjs)
/** Split a batch selection for deletion (same repeat criterion as utils/confirm.js deleteWithUndo:
 *  repeatId is a valid repeatId). Recurring instances must not bypass the dedicated scope-confirm
 *  modal, and the modal handles one repeat group per pass, so only the first returns as repeatAsk
 *  and the rest return as repeatRest (the view keeps them checked for the next pass). Plain rows
 *  all go through the unified deleteWithUndo exit, semantics identical to single-item delete. */
function splitBatchDelete (rows) {
  const isRepeat = t => !!(t && t.repeatId && t.repeatId !== 'null')
  const plain = []
  let repeatAsk = null
  const repeatRest = []
  for (const t of rows || []) {
    if (!isRepeat(t)) plain.push(t)
    else if (!repeatAsk) repeatAsk = t
    else repeatRest.push(t)
  }
  return { plain, repeatAsk, repeatRest }
}
// [navgate-fix] pure-end

export default {
  name: 'TodoBoxView',
  components: { EmptyState },
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
    // keyboard activation for the sort/filter dropdown triggers; the cast lives here because the
    // structure guard rejects TS `as` expressions inside templates (silent-undefined identifier scan)
    tbTriggerKey (e) { (e.currentTarget as HTMLElement).click() },
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
      // Resolve against the live list first (dead ids deleted elsewhere during batching are excluded),
      // then split: recurring instances divert to ui/askRepeatDelete (RepeatDeleteModal owns their
      // deletion), plain tasks go through the unified deleteWithUndo exit -- no hand-rolled undo here
      const rows = this.checkedIds
        .map(id => this.$store.state.todo.todoList.find(x => x.taskId === id))
        .filter(Boolean)
      const { plain, repeatAsk, repeatRest } = splitBatchDelete(rows)
      // Keep the recurring selections that did not get a modal this pass checked, so "delete" asks
      // about the next repeat group when the user confirms again
      this.checkedIds = repeatRest.map(t => t.taskId)
      for (const raw of plain) await deleteWithUndo(this, this.$store, raw)
      if (repeatAsk) this.$store.commit('ui/askRepeatDelete', repeatAsk.taskId)
    },
    ctxMenu (t, e) {
      // Unified task context menu (2026-08-31 consistency consolidation): one set of semantics for edit/complete/move date/pomodoro/copy/recycle bin
      taskContextMenu(this, t, e)
    }
  },

}
</script>
<style>
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
.icon-append{display:block;color:var(--text-4);font-size:16px;line-height:20px}
/* ---- F1. 待办箱条目（原 TodoBoxListItem scoped，限定于 .todo-box-list 下）---- */
.todo-box-list .todo-box-list-item{position:relative;border-bottom:1px solid var(--line);background-color:var(--panel, #fff);padding:10px 26px;transition:all .3s cubic-bezier(.23,1,.32,1);box-sizing:border-box;display:flex}
.todo-box-list .todo-box-list-item__append,.todo-box-list .todo-box-list-item__prepend{flex-shrink:0}
.todo-box-list .todo-box-list-item__category-dot{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:20px;height:20px;margin-right:8px;font-size: var(--fs-sm)}
.todo-box-list .todo-box-list-item__category-dot>svg{display:block}
.todo-box-list .todo-box-list-item__container{flex:1;overflow:hidden}
.todo-box-list .todo-box-list-item__content{display:-webkit-box;overflow:hidden;color:var(--text-1);font-weight:400;font-size: var(--fs-base);line-height:20px;white-space:pre-line;text-overflow:ellipsis;overflow-wrap:break-word;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.todo-box-list .todo-box-list-item__workload{position:absolute;top:8px;left:0;bottom:8px;background-color:transparent;width:3px}
.todo-box-list .todo-box-list-item__workload--lv2{background-color:#f49a4f}
.todo-box-list .todo-box-list-item__workload--lv3{background-color:var(--danger)}
.todo-box-list .todo-box-list-item__tools{display:flex;gap:15px}
.todo-box-list .todo-box-list-item:hover{background-color:var(--hover-bg)}
.todo-box-list .todo-box-list-item:active{background-color:var(--active-bg)}
.todo-box-list .todo-box-list-item--is-drop{pointer-events:none}
.todo-box-list .todo-box-list-item--is-drop:active,.todo-box-list .todo-box-list-item--is-drop:hover{background-color:var(--hover-bg)}
.todo-box-list .todo-box-list-item--is-drag{background-color:var(--active-bg)}
.todo-box-list .todo-box-list-item--selected,.todo-box-list .todo-box-list-item--selected:hover{background-color:#f5fafb}
/* 裸文字按钮仅限待办箱条目（旧 scoped id）；回收站条目用原版药丸组（见 F2 补充） */
.todo-box-list .todo-box-list-item__tools .btn{padding:0;color:var(--brand-dark);font-size: var(--fs-sm);background:none;border:none;cursor:pointer;transition:all .2s}
.todo-box-list .todo-box-list-item__tools .btn:focus{outline:0}
.todo-box-list .todo-box-list-item__tools .btn:hover{color:var(--brand-hover)}
.todo-box-list .todo-box-list-item__tools .btn:active{color:var(--brand-active)}
.todo-box-list .todo-box-list-item__tools .btn--dark{color:#4f4f4f}
.todo-box-list .todo-box-list-item__tools .btn--dark:focus{outline:0}
.todo-box-list .todo-box-list-item__tools .btn--dark:hover{color:#474747}
.todo-box-list .todo-box-list-item__tools .btn--dark:active{color:#3b3b3b}
/* 工具栏下拉菜单（原 DropdownSelect 的弹出层无独立样式文件，按设计稿设计语言补齐：白底/分隔/主色高亮） */
.dd-menu{list-style:none;margin:0 -4px;padding:0;font-size: var(--fs-sm);color:var(--text-1)}
.dd-menu li{padding:7px 16px;cursor:pointer;white-space:nowrap;border-radius: var(--radius-md)}
.dd-menu li:hover{background:var(--gray-bg, #f5f7fa)}
.dd-menu li.on{color:var(--brand);font-weight:600}
/* 下拉面板（popper 挂 body，须 popper-class 钩住）：紧内边距+圆角投影，过渡 120ms 干脆利落 */
.dd-pop{--el-popover-padding:6px;border-radius:var(--radius-lg) !important;box-shadow:0 10px 32px rgba(0,0,0,.13) !important}
.dd-menu li{padding:7px 12px}
.dd-pop.el-fade-in-linear-enter-active{transition:opacity .12s ease,transform .12s ease}
.dd-pop.el-fade-in-linear-enter-from{opacity:0;transform:translateY(-5px) scale(.97)}
.dd-pop.el-fade-in-linear-leave-active{transition:opacity .06s ease-out;pointer-events:none}
.dd-pop.el-fade-in-linear-leave-to{opacity:0}
.dd-caret{font-style:normal;font-size:0;line-height:1;flex-shrink:0}
.dd-caret::before{content:"";display:block;width:6px;height:6px;border-right:1.5px solid var(--text-3);border-bottom:1.5px solid var(--text-3);transform:rotate(45deg) translate(-1px,-1px);transition:transform .18s,border-color .15s}
.dd-q,.tip-q{
  width:16px;height:16px;margin-left:2px;border:1px solid currentColor;border-radius:50%;
  font-size: var(--fs-xs);line-height:15px;text-align:center;text-indent:1px;cursor:pointer;
  color:var(--text-4);flex-shrink:0;
}
</style>
