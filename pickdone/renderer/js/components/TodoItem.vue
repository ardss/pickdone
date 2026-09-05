<template>

  <div class="td-item" :class="{'is-complete':todo.complete, selected, dragging, 'td-item--enter': entering, 'pd-hoverlink': $store.state.ui.hoverTaskId === todo.taskId, ['prio-'+(todo.priority||0)]: (todo.priority||0)>0}"
       draggable="true"
       tabindex="0"
       @dragstart.stop="onDragStart" @dragover.stop.prevent="onDragOver" @dragleave.stop="onDragLeave"
       @drop.stop="onDrop" @dragend="onDragEnd"
       @click.stop="openEdit" @keydown.enter.prevent="openEdit" @contextmenu.stop.prevent="ctxMenu($event)"
       @keydown.ctrl.up.prevent="keyboardMove(-1)" @keydown.ctrl.down.prevent="keyboardMove(1)"
       @keydown.shift.delete.prevent="quickDelete"
       aria-keyshortcuts="Control+ArrowUp Control+ArrowDown Shift+Delete">
    <span class="td-check" :class="{on:todo.complete}" :style="todo.complete?{background:checkboxColor,borderColor:checkboxColor}:{}"
          role="checkbox" :aria-checked="todo.complete ? 'true' : 'false'" :aria-label="$t('statsE.TodoItem.markComplete')"
          tabindex="0" @click.stop="onCheckClick" @keydown.enter.prevent.stop="onCheckClick($event)">
      <svg v-if="todo.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true">
        <polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
      </svg>
    </span>
    <div class="td-body">
      <div class="td-title" :class="{'td-title--empty': !todo.taskContent}">{{ todo.taskContent || $t('statsE.TodoItem.untitled') }}</div>
      <div v-if="todo.taskDescribe" class="td-desc">{{todo.taskDescribe}}</div>
      <div v-if="subtasks.length" class="td-subs">
        <div v-for="s in subtasks" :key="s.text" class="td-sub" role="checkbox"
             :aria-checked="s.checked ? 'true' : 'false'" tabindex="0"
             @click.stop="toggleSub(s)" @keydown.enter.prevent.stop="toggleSub(s)">
          <span class="td-sub-check" :class="{on:s.checked}">✓</span>
          <span :class="{strike:s.checked}">{{s.text}}</span>
        </div>
      </div>
      <div class="td-meta">
        <span v-if="todo.reminderTime>0 && !todo.complete" class="td-remind" :title="$t('statsE.TodoItem.reminderLabel')">
          <img class="td-ico" src="app://app/assets/img/icon-clock.svg" alt="">{{dayjs(todo.reminderTime).format(FMT.time)}}
        </span>
        <span v-if="subtasks.length" class="td-subprog" :class="{'td-subprog--done': subDone===subtasks.length}" :title="$t('statsE.TodoItem.subtaskProgress')">
          <app-icon name="list" :size="12"/>{{subDone}}/{{subtasks.length}}
        </span>
        <button v-for="tg in tags.slice(0,4)" :key="tg" class="td-tag" @click.stop="goTag(tg)">#{{tg}}</button>
        <img v-if="isRepeat" class="td-ico" src="app://app/assets/img/icon-repeat.svg" :title="$t('statsE.TodoItem.repeatLabel')" alt="">
        <img v-if="fileCount" class="td-ico" src="app://app/assets/img/icon-file.svg" :title="fileCount+$t('statsE.TodoItem.attachmentsUnit')" alt="">
        <span v-if="(todo.estimate||0)>0" class="td-snow" :title="$t('statsE.TodoItem.pomodoroInvested')"><app-icon name="snow" :size="12"/>{{todo.estimate}}</span>
        <span v-if="(todo.priority||0)>0" class="td-prio" :class="'p'+todo.priority" :title="$t('statsE.TodoItem.priorityPrefix')+['',$t('statsJ.TodoItem.prioLow'),$t('statsJ.TodoItem.prioMedium'),$t('statsJ.TodoItem.prioHigh')][todo.priority||0]">
          <i class="prio-flag"></i>{{['',$t('statsE.TodoItem.priorityLow'),$t('statsJ.TodoItem.prioMedium'),$t('statsJ.TodoItem.prioHigh')][todo.priority||0]}}
        </span>
        <span v-if="todo.deadlineTs>0 && !todo.complete" class="td-deadline" :class="{overdue: todo.deadlineTs < Date.now()}" :title="$t('statsJ.TodoItem.deadlineColon', { d: dayjs(todo.deadlineTs).format(FMT.dateTime) })">
          {{ $t('statsJ.TodoItem.deadlineSpace', { d: dayjs(todo.deadlineTs).format(FMT.cnDate) }) }}
        </span>
        <span v-if="cat && showDateBadge===false" class="td-cat" :style="{color:cat.categoryColor}">{{cat.categoryName}}</span>
      </div>
    </div>
    <div v-if="showDateBadge && dateLabel" class="td-right">
      <!-- Integrated pomodoro control (user-finalized 2026-09-03): start segment + ledger segment in one capsule; clicking the capsule = select this task and arm start
           (setTomatoTimer's attach semantics, clicking again on the same task cancels); ledger detail lives in the edit panel/context menu, one single action per capsule -->
      <span class="td-tom" role="button" tabindex="0"
            :class="{ghost: todo.complete, active: $store.state.tomato.attachTodo && $store.state.tomato.attachTodo.taskId === todo.taskId}"
            :title="$t('statsE.TodoItem.togglePomodoroFocus')"
            @click.stop="setTomatoTimer" @keydown.enter.prevent.stop="setTomatoTimer">
        <span class="td-tom__start">
          <i class="ico" style="--ico:url('app://app/assets/img/icon-tomato-timer2.svg');width:13px;height:13px"></i>
        </span>
        <span v-if="tomatoEstimateN>0" class="td-tom__count"><span class="td-tom-pips" aria-hidden="true"><i v-for="n in Math.min(tomatoEstimateN,6)" :key="n" :class="{done: n<=tomatoActualN}"></i></span><span class="td-tom-n">{{ Math.min(tomatoActualN,tomatoEstimateN) }}/{{ tomatoEstimateN }}</span></span>
      </span>
      <button class="td-quick-del" :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
              tabindex="-1" @click.stop.prevent="quickDelete">
        <app-icon name="trash" :size="14"/>
      </button>
      <div class="td-datetime" :style="{color:badgeColor}">{{dateLabel}}</div>
      <!-- Quick delete: appears on hover/keyboard focus (Microsoft To Do pattern), soft delete + undoable, no confirmation dialog -->
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Todo item -- aligned with the todo-list-item reference: square checkbox / relaxed line spacing / thin separators / light gray on hover
 */
import {dayjs, DEFAULT_CAT_COLOR, formatDayLabel, parseSubtasks, firstImageOfList, subsCompleteTarget, FMT } from '../utils/core.js'
import { dateBadgeColor } from '../utils/core.js'
import { extractTags } from '../utils/search.js'
import { deleteWithUndo, moveWithUndo } from '../utils/confirm.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { chkColor } from '../utils/taskRow.js'
import { getEstimate } from '../utils/tomatoEstimate.js'

export default {
  name: 'TodoItem',
  props: {
    todo: { type: Object, required: true },
    groupKey: { type: String, default: '' },
    query: { type: String, default: '' },
    showDateBadge: { type: Boolean, default: true } // most list views in the project baseline show the date in the right column
  },
  data () { return { dragging: false, dropAfter: false, entering: false } },
  watch: {
    // New task entrance animation: "drops into" the today group from the quick-add bar
    '$store.state.todo.recentlyAddedTaskId': {
      immediate: true,
      handler (id) {
        if (id && id === this.todo.taskId) {
          this.entering = true
          clearTimeout(this._enterTimer)
          this._enterTimer = setTimeout(() => { this.entering = false }, 1500)
        }
      }
    }
  },
  beforeUnmount () { clearTimeout(this._enterTimer) },
  computed: {
    cat () { return this.$store.getters['category/byId'](this.todo.categoryId) },
    tomatoEstimateN () { return getEstimate(this.todo.taskId) },
    /* Pomodoro ledger: pomodoros already invested in this task (attributed by record, abandoned excluded) — list item = unit of outcome, tomato = currency of workload (design-final) */
    tomatoActualN () {
      const id = this.todo.taskId
      if (!id) return 0
      return this.$store.getters['tomato/actualCountByTask'].get(id) || 0
    },
    checkboxColor () { return chkColor(this.$store, this.todo) },
    dateLabel () { return formatDayLabel(this.todo.dayStart || this.todo.todoTime, Date.now(), this.$t.bind(this)) },

    badgeColor () { return dateBadgeColor(this.todo, this.$store) },
    subtasks () { return parseSubtasks(this.todo.subtasks) },
    subDone () { return this.subtasks.filter(s => s.checked).length },
    img () { return firstImageOfList(this.todo.image) },
    fileCount () { try { return JSON.parse(this.todo.files || '[]').length } catch { return 0 } },
    tags () { return extractTags(this.todo.taskContent, this.todo.taskDescribe) },
    selected () { const ed = this.$store.state.ui.rightSidebarTodoEdit; return ed.visible && ed.taskId === this.todo.taskId },
    isRepeat () { return !!(this.todo.repeatId && this.todo.repeatId !== 'null') },
    hasExtras () {
      return (this.todo.reminderTime > 0 && !this.todo.complete) || this.isRepeat ||
             this.fileCount > 0 || (this.todo.estimate || 0) > 0
    }
  },
  methods: {
    /* ===== Drag sorting (midpoint insertion into taskSort, aligned with the task_sort reference semantics) ===== */
    onDragStart (e) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', this.todo.taskId)
      this.dragging = true
    },
    onDragOver (e) {
      if (!this._draggingGlobal()) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = this.$el.getBoundingClientRect()
      this.dropAfter = (e.clientY - rect.top) > rect.height / 2
      this.$el.style.borderBottomColor = this.dropAfter ? DEFAULT_CAT_COLOR : 'transparent'
      this.$el.style.borderTopColor = !this.dropAfter ? DEFAULT_CAT_COLOR : 'transparent'
    },
    onDragLeave () { this.$el.style.borderBottomColor = ''; this.$el.style.borderTopColor = '' },
    onDragEnd () { this.$el.classList.remove('dragging'); this.dragging = false },
    async onDrop (e) {
      e.preventDefault()
      this.$el.style.borderBottomColor = ''; this.$el.style.borderTopColor = ''
      const draggedId = e.dataTransfer.getData('text/plain')
      if (!draggedId || draggedId === this.todo.taskId) return
      const st = this.$store.state.todo
      const dragged = st.todoList.find(t => t.taskId === draggedId)
      const target = this.rawOf()
      if (!dragged || !target) return
      // Cross-day drag = reschedule the task to the target day (e.g. yesterday's unfinished task -> drag into the today group)
      if ((dragged.dayStart || 0) !== (target.dayStart || 0)) {
        const newDay = target.dayStart || +dayjs().startOf('day')
        const origDay = dragged.dayStart
        // Unified exit moveWithUndo (hover pauses / ✕ closes); the hand-rolled $message version was removed (interaction contract ①)
        moveWithUndo(this, {
          label: this.$t('statsJ.TodoItem.movedTo', { d: dayjs(newDay).format(FMT.cnDate) }),
          apply: () => this.$store.dispatch('todo/updateTodoFields', { taskId: dragged.taskId, patch: { dayStart: newDay, todoTime: newDay } }),
          revert: () => this.$store.dispatch('todo/updateTodoFields', { taskId: dragged.taskId, patch: { dayStart: origDay, todoTime: origDay } })
        })
        return
      }
      // Take the same-day ordered list; after reordering, refresh taskSort for the affected segment via the midpoint algorithm (one batched DB write)
      const list = st.todoList
        .filter(t => !t.delete && !t.complete && t.dayStart === target.dayStart)
        .sort((a, b) => b.taskSort - a.taskSort)
      const from = list.findIndex(t => t.taskId === draggedId)
      const to = list.findIndex(t => t.taskId === target.taskId)
      if (from < 0 || to < 0) return
      list.splice(to, 0, list.splice(from, 1)[0])
      this._writeSort(list)
    },
    /** Batch midpoint write of taskSort in the new order */
    _writeSort (list) {
      const top = 9999; const step = (top * 2) / Math.max(1, list.length)
      const updates = []
      list.forEach((t, idx) => {
        const sort = Math.fround(top - idx * step)
        if (Math.abs(sort - t.taskSort) > 0.01) updates.push({ taskId: t.taskId, taskSort: sort })
      })
      if (updates.length) this.$store.dispatch('todo/reorderTodos', updates)
    },
    /** Keyboard sorting alternative (WCAG 2.1.1): Ctrl+Up/Down is equivalent to drag sorting, moving only within the same day */
    keyboardMove (dir) {
      const st = this.$store.state.todo
      const raw = this.rawOf()
      if (!raw || raw.delete || raw.complete || !raw.dayStart) return
      const list = st.todoList
        .filter(t => !t.delete && !t.complete && t.dayStart === raw.dayStart)
        .sort((a, b) => b.taskSort - a.taskSort)
      const i = list.findIndex(t => t.taskId === raw.taskId)
      const j = i + dir
      if (i < 0 || j < 0 || j >= list.length) return
      list.splice(j, 0, list.splice(i, 1)[0])
      this._writeSort(list)
      if (this.$announce) this.$announce(this.$t('statsE.TodoItem.donePrefix') + (dir > 0 ? this.$t('statsJ.TodoItem.moveDownAnnounce', { t: raw.taskContent || '' }) : this.$t('statsJ.TodoItem.moveUpAnnounce', { t: raw.taskContent || '' })))
    },
    _draggingGlobal () { return !!document.querySelector('.td-item.dragging') },
    onCheckClick (e) {
      e.stopPropagation()
      this.$el.classList.add('pop')
      // Capture the el reference: if the row is re-rendered or the route unmounts within 260ms, this.$el is already null and a dangling callback would throw uncaught
      const el = this.$el
      setTimeout(() => { if (el) el.classList.remove('pop') }, 260)
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: this.rawOf(), fromEl: this.$el, announce: this.$announce })
    },
    rawOf () {
      return this.$store.state.todo.todoList.find(t => t.taskId === this.todo.taskId) ||
             this.$store.state.todo.recycleList.find(t => t.taskId === this.todo.taskId) || this.todo
    },
    /** Reference setTomatoTimer: clicking the same task cancels, otherwise selects */
    setTomatoTimer () {
      const st = this.$store.state.tomato
      // Must go through tomato/attach (which includes patch persistence + cross-window broadcast): mutating state directly does not write localStorage,
      // so the float window would miss the attach, it would be lost after restart, and float window completion bookkeeping would lack focus context
      const attach = st.attachTodo && st.attachTodo.taskId === this.todo.taskId
        ? null
        : this.todo.taskId
      this.$store.dispatch('tomato/attach', attach)
    },
    // Right-click quick day move: change the date to yesterday/today (dayStart is derived by updateTodoFields)
    moveDay (offset) {
      const base = this.todo.todoTime
        ? dayjs(this.todo.todoTime)
        : dayjs().startOf('day')
      const target = offset === 0
        ? +dayjs().startOf('day')
        // Postpone: at least to tomorrow; unexpired tasks are pushed forward from their original date
        : Math.max(+dayjs().add(offset, 'day').startOf('day'), +base.add(offset, 'day').startOf('day'))
      const orig = this.todo.todoTime
      moveWithUndo(this, {
        label: offset === 1 ? this.$t('statsJ.TodoItem.movedToTomorrow') : this.$t('statsJ.TodoItem.movedToToday'),
        apply: () => this.$store.dispatch('todo/updateTodoFields', {
          taskId: this.todo.taskId,
          patch: { todoTime: target, status: 'update' }
        }),
        revert: () => this.$store.dispatch('todo/updateTodoFields', {
          taskId: this.todo.taskId,
          patch: { todoTime: orig, status: 'update' }
        })
      })
    },
    openEdit () {
      const raw = this.rawOf()
      // Clicking an already-selected item = toggle collapse/expand (clicking the same item while collapsed must expand it again)
      if (this.selected) {
        const st = this.$store.state.ui.rightSidebarTodoEdit
        this.$store.commit(st.collapsed ? 'ui/expandEdit' : 'ui/collapseEdit')
        return
      }
      this.$store.commit('ui/openEdit', raw)
    },
    ctxMenu (e) {
      e.preventDefault()
      this.$store.commit('ui/openMenu', {
        x: e.clientX + 2, y: e.clientY + 2,
        items: [
          { icon: 'edit', label: this.$t('statsE.TodoItem.openEditor'), fn: () => this.openEdit() },
          { icon: 'check', label: this.todo.complete ? this.$t('statsE.TodoItem.markIncomplete') : this.$t('statsJ.TodoItem.markDone'), fn: () => toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: this.rawOf(), announce: m => this.$announce && this.$announce(m) }) },
          { icon: 'calendar', label: this.$t('statsE.TodoItem.moveToToday'), fn: () => this.moveDay(0) },
          { icon: 'clock', label: this.$t('statsE.TodoItem.postponeToTomorrow'), fn: () => this.moveDay(1) },
          (!this.todo.complete && this.todo.dayStart) ? { icon: 'chevron-up', label: this.$t('statsE.TodoItem.moveUp'), fn: () => this.keyboardMove(-1) } : null,
          (!this.todo.complete && this.todo.dayStart) ? { icon: 'chevron-down', label: this.$t('statsE.TodoItem.moveDown'), fn: () => this.keyboardMove(1) } : null,
          {
            icon: 'copy', label: this.$t('statsE.TodoItem.copyTitleDesc'),
            fn: async () => { await navigator.clipboard.writeText((this.todo.taskContent || '') + '\n' + (this.todo.taskDescribe || '')); this.$message.success(this.$t('statsE.TodoItem.copiedMsg')) }
          },
          this.isRepeat ? { icon: 'repeat', label: this.$t('statsE.TodoItem.repeatDeleteMenu'), fn: () => this.$store.commit('ui/askRepeatDelete', this.todo.taskId), danger: true } : null,
          { sep: true },
          { icon: 'trash', label: this.$t('statsE.TodoItem.moveToRecycleBin'), danger: true, fn: () => deleteWithUndo(this, this.$store, this.rawOf()) }
        ].filter(Boolean)
      })
    },
    /** End-of-row trash quick delete (shared by hover icon / Delete key): same semantics as the context menu.
     *  Recurring task deletion has a dedicated confirm dialog (askRepeatDelete) that must not be bypassed */
    quickDelete () {
      if (this.isRepeat) { this.$store.commit('ui/askRepeatDelete', this.todo.taskId); return }
      deleteWithUndo(this, this.$store, this.rawOf())
    },
    goTag (t) { this.$router.push({ name: 'todo-list-tag', params: { id: t } }).catch(() => {}) },
    toggleSub (s) {
      s.checked = !s.checked
      this.$store.dispatch('todo/updateTodoFields', { taskId: this.todo.taskId, patch: { subtasks: JSON.stringify(this.subtasks) } })
      // Subtask <-> parent linkage: all completed -> parent auto-completes; unchecking any subtask under a completed parent -> parent returns to incomplete
      const target = subsCompleteTarget(this.subtasks, this.todo.complete)
      if (target !== null) {
        // 两分支同体合并(2026-09-04 三轮扫荡:if/else if 逐字相同=复制粘贴僵尸);联动走统一完成出口带撤销 toast
        toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: this.rawOf(), announce: m => this.$announce && this.$announce(m) })
      }
    }
  },

}
</script>
