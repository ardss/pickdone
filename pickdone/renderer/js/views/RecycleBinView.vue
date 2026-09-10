<template>

  <div class="page recycle-page">
    <div class="page__header">
      <div class="title">
        <div class="title__prepend">
          <i class="icon-prepend"></i>
          <div class="title__text"> {{ $t('statsC.RecycleBin.title') }} </div>
        </div>
        <div class="title__append">
          <el-button v-if="list.length" type="danger" size="small" @click="clearAll"> {{ $t('statsC.RecycleBin.clear') }} </el-button>
          <span v-if="list.length" class="rc-count">{{ $t('statsC.RecycleBin.count', { n: list.length }) }}</span>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <div v-if="!list.length" class="empty">
        <div class="empty__icon"></div>
        <div class="empty__text">{{ $t('statsC.RecycleBin.empty') }}</div>
      </div>
      <div v-else class="todo-list">
        <div v-for="t in list" :key="t.taskId" class="todo-box-list-item" @contextmenu.prevent="rowCtx(t, $event)">
          <div class="todo-box-list-item__container">
            <div class="todo-box-list-item__drop-placeholder"></div>
            <span class="td-check rc-check" :class="{on:t.complete}"
                  :style="t.complete ? { background: 'var(--brand)', borderColor: 'var(--brand)' } : {}"
                  role="checkbox" :aria-checked="t.complete ? 'true' : 'false'" :aria-label="$t('statsC.RecycleBin.ariaMarkComplete')"
                  tabindex="0" @click.stop="toggleComplete(t)" @keydown.enter.prevent.stop="toggleComplete(t)">
              <svg v-if="t.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true">
                <polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8"
                          stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
              </svg>
            </span>
            <div class="todo-box-list-item__content rc-editable" :title="$t('statsC.RecycleBin.clickEdit')" :class="{ 'rc-done': t.complete }"
                 role="button" tabindex="0" @click.stop="openEdit(t)" @keydown.enter.prevent.stop="openEdit(t)"> {{ t.taskContent }} </div>
            <div class="todo-box-list-item__tools">
              <div class="btn-group">
                <button class="btn" @click.stop="restore(t, false)"> {{ $t('statsC.RecycleBin.btnRestoreDate') }} </button>
                <button class="btn" @click.stop="restore(t, true)"> {{ $t('statsC.RecycleBin.btnRestoreToday') }} </button>
                <div class="btn rc-pick-btn" @click.stop> {{ $t('statsC.RecycleBin.btnPickDate') }}
                  <el-date-picker class="rc-pick" size="small" value-format="x" type="date"
                                  :model-value="t.dayStart || null" @update:model-value="pickDate(t, $event)"/>
                </div>
                <button class="btn btn--danger rc-danger-btn" @click.stop="purge(t)"> {{ $t('statsC.RecycleBin.btnPurge') }} </button>
              </div>
            </div>
          </div>
          <div class="todo-box-list-item__prepend">
            <div class="datetime" :class="{ 'datetime--gray': !t.dayStart, 'datetime--alert': t.dayStart && isOverdue(t) }">{{ prependDate(t) }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Recycle bin (project baseline route todo-list-recycle-bin, component scope)
 * Structure aligned with the project baseline render function + RecycleBinItem (reuses .todo-box-list-item classes, component scope):
 *   todo-page-layout > .page__header > .title
 *     .title__prepend: i.icon-prepend (recycle bin icon) + .title__text
 *     .title__append: [when non-empty] el-button(danger, mini) to clear all
 *   body: [empty] .empty "no schedules"; [non-empty] .todo-list > .todo-box-list-item*
 * Item = recycle bin item component: .__container (.__content + .__tools>.btn-group pill group)
 *   first, then .__prepend (.datetime date suffix: gray when undated / red when overdue, right-aligned); earlier versions had no category dot
 */
import {dayjs, FMT } from '../utils/core.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'

export default {
  name: 'RecycleBinView',
  computed: {
    list () { return this.$store.state.todo.views.recycleBin }
  },
  mounted () {
    // [component-r5] Hidden inline date pickers stay out of the Tab focus chain (opened via the pick button only)
    // — same placement as QuickAdd.vue's hidden calendar input
    this.$nextTick(() => {
      if (!this.$el || typeof this.$el.querySelectorAll !== 'function') return
      this.$el.querySelectorAll('.rc-pick input').forEach(inp => inp.setAttribute('tabindex', '-1'))
    })
  },
  methods: {
    isOverdue (t) {
      return t.dayStart && dayjs(t.dayStart).startOf('day').valueOf() < dayjs().startOf('day').valueOf()
    },
    /** Reference prepend copy: "no date" / "overdue M/D weekX" / "M/D weekX" */
    prependDate (t) {
      if (!t.dayStart) return this.$t('statsC.RecycleBin.noDate')
      const d = dayjs(t.dayStart).startOf('day')
      const wk = this.$t('statsD.DayDateStrip.wd' + d.day())
      const sameYear=d.year()===dayjs().year(); const label=sameYear ? this.$t('statsA.core.md',{m:d.month()+1,d:d.date()}) + ' ' + wk : d.format(FMT.cnFull)
      return (this.isOverdue(t) ? this.$t('statsC.RecycleBin.overdue') : '') + label
    },
    /** Recycle bin context menu: capabilities trimmed to restore (original date/today) + delete permanently, completing the last cell of the global ctx coverage matrix */
    rowCtx (t, e) {
      taskContextMenu(this, t, e,
        { recycle: true, edit: false, complete: false, move: false, tomato: false, copy: false, del: false },
        [
          { icon: 'calendar', label: this.$t('statsC.RecycleBin.btnRestoreDate'), fn: () => this.restore(t, false) },
          { icon: 'clock', label: this.$t('statsC.RecycleBin.btnRestoreToday'), fn: () => this.restore(t, true) },
          { icon: 'trash', label: this.$t('statsC.RecycleBin.btnPurge'), danger: true, fn: () => this.purge(t) }
        ])
    },
    restore (t, patchToToday) {
      const today = +dayjs().startOf('day')
      this.$store.dispatch('todo/updateTodoFields', {
        taskId: t.taskId,
        patch: patchToToday ? { delete: false, status: 'update', dayStart: today, todoTime: today } : { delete: false, status: 'update' }
      })
      this.$message.success(patchToToday ? this.$t('statsC.RecycleBin.restoredToToday') : this.$t('statsC.RecycleBin.restored'))
    },
    /** Earlier-version "pick date": a transparent date picker embedded in the button; picking restores to that date */
    pickDate (t, ts) {
      if (!ts) return
      const day = +dayjs(ts).startOf('day')
      this.$store.dispatch('todo/updateTodoFields', {
        taskId: t.taskId,
        patch: { delete: false, status: 'update', dayStart: day, todoTime: day }
      })
      this.$message.success(this.$t('statsC.RecycleBin.restoredToDate'))
    },
    /** Clicking the item content = open the right-side edit panel (consistent with the app-wide "click row to edit"); field changes auto-save while keeping the deleted state */
    openEdit (t) {
      this.$store.commit('ui/openEdit', t)
    },
    /** Check complete directly inside the recycle bin (keeps the deleted state, avoiding the three steps restore -> back to list -> check) — goes through the unified completion layer: subtask cascade/recurring renewal/undo toast share the same semantics as other pages */
    toggleComplete (t) {
      toggleCompleteWithUndo({ store: this.$store, message: m => this.$message(m), todo: t, announce: m => this.$announce && this.$announce(m) })
    },
    purge (t) {
      this.$confirm(this.$t('statsC.RecycleBin.purgeConfirm', { name: t.taskContent }), this.$t('statsC.RecycleBin.dangerAction'), { type: 'error' }).then(() => {
        this.$store.dispatch('todo/purgeIds', [t.taskId])
      }).catch(() => {})
    },
    clearAll () {
      const list = this.list
      if (!list.length) return
      const n = list.length
      // Triple confirmation: 1) $confirm warning 2) prompt to type a keyword 3) $confirm second confirmation with Enter (guards against accidental triggers)
      this.$confirm(this.$t('statsC.RecycleBin.clearConfirm', { n }), this.$t('statsC.RecycleBin.dangerAction'), {
        type: 'error',
        confirmButtonText: this.$t('statsC.RecycleBin.continueText')
      }).then(() => this.$prompt(
        this.$t('statsC.RecycleBin.clearKeywordPrompt', { n, kw: this.$t('statsC.RecycleBin.clearKeyword') }),
        this.$t('statsC.RecycleBin.dangerAction'),
        { confirmButtonText: this.$t('statsC.RecycleBin.continueText'), cancelButtonText: this.$t('statsC.RecycleBin.cancelText') }
      )).then(({ value }) => {
        if (String(value || '').trim() !== this.$t('statsC.RecycleBin.clearKeyword')) {
          this.$message.warning(this.$t('statsC.RecycleBin.clearKeywordMismatch'))
          return Promise.reject(new Error('keyword-mismatch'))
        }
        return this.$confirm(this.$t('statsC.RecycleBin.clearFinalConfirm', { n }), this.$t('statsC.RecycleBin.dangerAction'), {
          type: 'error',
          confirmButtonText: this.$t('statsC.RecycleBin.continueText')
        })
      }).then(() => {
        // Dedicated purgeAllRecycle: a single clear in the main process + event snapshot before clearing (the previous per-item hardDelete missed the snapshot semantics)
        this.$store.dispatch('todo/purgeAllRecycle')
        this.$message.success(this.$t('statsC.RecycleBin.cleared', { n }))
      }).catch(() => { /* user cancelled at any step */ })
    }
  },

}
</script>
<style>/* Header icon: data-uri SVG had hardcoded fill=%23ccc (invisible on dark) — use mask + currentColor, same pattern as QuickAdd's calendar icon */
.recycle-page .icon-prepend{background-color:currentColor;-webkit-mask:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22/></svg>') no-repeat 50% / contain;mask:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22/></svg>') no-repeat 50% / contain}
.datetime--alert{color:#bd401e}
.datetime--gray{color:var(--text-dim)}
/* 完成/标签/清单等页在条目右侧的悬停操作（恢复为未完成等），颜色取自设计稿 .btn-group .btn */
.row-btn{flex-shrink:0;align-self:center;margin-right:14px;padding:0;color:var(--brand-dark);font-size: var(--fs-sm);background:none;border:none;cursor:pointer;transition:all .2s;opacity:0}
.row-btn:focus-visible{opacity:1}
/* 待办箱：分类圆点使用圆形图标（原为 font-awesome far/fas circle），此处由内联 SVG 承担 */
.todo-box-list-item__category-dot svg{width:12px;height:12px;display:block}
/* 回收站页头计数与危险按钮微调（颜色取自设计稿 var(--danger) 系） */
.rc-count{font-size: var(--fs-sm);color:var(--text-dim)}
.rc-danger-btn{color:var(--danger) !important;background-color:#fdecea !important}
.rc-danger-btn:hover{color:var(--danger-strong) !important}
@keyframes trash-pulse { 50% { transform: scale(1.05); } }
</style>
