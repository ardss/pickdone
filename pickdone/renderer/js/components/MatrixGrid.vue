<template>

  <div class="matrix-wrap">
    <div class="matrix-grid">
    <div v-for="q in quadrants" :key="q.key" class="matrix-quadrant" :class="q.cls"
         @dragover.prevent="overKey=q.key" @dragleave="overKey===q.key&&(overKey=null)" @drop.prevent="dropOn(q)">
      <div class="matrix-quadrant__head" :class="{'over': overKey===q.key}">
        <span class="matrix-quadrant__title">{{ q.title }}</span>
        <em class="matrix-quadrant__count">{{ q.tasks.length }}</em>
      </div>
      <div class="matrix-quadrant__list">
        <div v-for="t in q.tasks" :key="t.taskId" class="matrix-task" draggable="true"
             :class="{ dragging: dragId===t.taskId }"
             @dragstart="dragStart(t,$event)" @dragend="dragId=null"
             @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)"
             @contextmenu="taskContextMenu(t, $event)"
             tabindex="0" role="button" :title="taskTip(t)" :aria-label="$t('statsA.MatrixGrid.taskPrefix')+(t.taskContent||$t('statsA.MatrixGrid.noTitle'))">
          <span class="td-check" :class="{on: isComplete(t)}" :style="isComplete(t) ? { background: chkColor(t), borderColor: chkColor(t) } : {}" role="checkbox"
                :aria-checked="isComplete(t) ? 'true' : 'false'" :aria-label="$t('statsJ.TodoItem.markDone')"
                tabindex="0" @click.stop="completeTask(t)" @keydown.enter.prevent.stop="completeTask(t)">
            <svg v-if="isComplete(t)" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true">
              <polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8"
                        stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
            </svg>
          </span>
          <span class="matrix-task__text" :class="{ 'matrix-task__text--done': isComplete(t) }">{{ t.taskContent || $t('statsA.MatrixGrid.noTitle') }}</span>
          <button v-if="!isComplete(t)" class="mt-act mt-act--tomato" :class="{on: isAttached(t)}"
                  :title="$t('statsE.TodoItem.togglePomodoroFocus')" :aria-label="$t('statsE.TodoItem.togglePomodoroFocus')"
                  @mousedown.stop @click.stop="toggleTomato(t)">
            <app-icon name="timer" :size="13"/>
          </button>
          <span v-if="t.dayStart" class="matrix-task__due">{{ dueLabel(t) }}</span>
          <button class="mt-act mt-act--del"
                  :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
                  @mousedown.stop @click.stop="quickDelete(t)">
            <app-icon name="trash" :size="13"/>
          </button>
        </div>
        <div v-if="!q.tasks.length" class="matrix-quadrant__empty">{{ $t('statsA.MatrixGrid.emptyDrop') }}</div>
      </div>
    </div>
  </div>
  </div>
</template>

<script lang="ts">
/** Quadrant matrix grid (reused by the today-todo matrix view toggle)
 *  Dimensions: important / urgent (0|1, stored on task fields); dragging a task into a quadrant rewrites them. Clicking a task opens the edit panel.
 *  Hover quick actions (user-finalized 2026-08-30): complete ✓ / start pomodoro -- aligns action power with the list view to avoid a fragmented experience across views. */
import { dayjs, FMT } from '../utils/core.js'
import { chkColor, toggleTomatoAttach } from '../utils/taskRow.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo, moveWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'

/* Quadrant titles store i18n keys (statsA.MatrixGrid.*), resolved with $t at render time (no component instance at module level) */
const QUADRANTS = [
  { key: 'q1', important: 1, urgent: 1, titleKey: 'statsA.MatrixGrid.q1', cls: 'q-urgent' },
  { key: 'q2', important: 1, urgent: 0, titleKey: 'statsA.MatrixGrid.q2', cls: 'q-plan' },
  { key: 'q3', important: 0, urgent: 1, titleKey: 'statsA.MatrixGrid.q3', cls: 'q-delegate' },
  { key: 'q4', important: 0, urgent: 0, titleKey: 'statsA.MatrixGrid.q4', cls: 'q-later' }
]

export default {
  name: 'MatrixGrid',
  props: {
    /** Task set to display (scope decided by the parent view, keeping "another expression of the same data") */
    tasks: { type: Array, required: true }
  },
  data () {
    return { dragId: null, overKey: null }
  },
  computed: {
    quadrants () {
      return QUADRANTS.map(q => ({
        ...q,
        title: this.$t(q.titleKey),
        tasks: this.tasks.filter(t => (t.important || 0) === q.important && (t.urgent || 0) === q.urgent)
      }))
    }
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    openEdit (t) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
      this.$store.commit('ui/openEdit', raw)
    },
    rawOf (t) {
      return this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t
    },
    completeTask (t) {
      toggleCompleteWithUndo({
        store: this.$store,
        message: this.$message,
        todo: this.rawOf(t),
        announce: m => this.$announce && this.$announce(m)
      })
    },
    isComplete (t) { return !!t.complete },
    /* Complete check / pomodoro go through the shared kernel (taskRow.js), same rules as list/card/timeline */
    chkColor (t) { return chkColor(this.$store, t) },
    /* End-of-row trash quick delete: same semantics as the list view's td-quick-del (soft delete + undoable, no confirmation dialog) */
    quickDelete (t) {
      deleteWithUndo(this, this.$store, this.rawOf(t))
    },
    toggleTomato (t) { toggleTomatoAttach(this.$store, t) },
    isAttached (t) {
      const st = this.$store.state.tomato
      return !!(st.attachTodo && st.attachTodo.taskId === t.taskId)
    },
    dragStart (t, e) {
      this.dragId = t.taskId
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(t.taskId))
      // Trello-style drag ghost: clone a styled card as the drag follow image (replaces the system's translucent screenshot)
      const src = e.currentTarget
      const ghost = src.cloneNode(true)
      const w = src.getBoundingClientRect().width
      ghost.style.cssText = `position:fixed;top:-1000px;left:-1000px;width:${w}px;` +
        'box-shadow:0 8px 24px rgba(0,0,0,.25);border-radius:6px;background:var(--panel,#fff);' +
        'transform:rotate(2deg);opacity:.95;pointer-events:none;'
      document.body.appendChild(ghost)
      try { e.dataTransfer.setDragImage(ghost, Math.min(60, w / 2), 18) } catch {}
      setTimeout(() => ghost.remove())
    },
    dropOn (q) {
      const id = this.dragId
      this.dragId = null
      this.overKey = null
      const t = this.tasks.find(x => x.taskId === id)
      if (!t || ((t.important || 0) === q.important && (t.urgent || 0) === q.urgent)) return
      // Drag-to-move contract: any field rewrite goes through moveWithUndo (undoable toast), never silent.
      // Snapshot the three affected fields (important/urgent/priority) so the revert restores the exact prior quadrant mapping.
      const snap = { important: t.important || 0, urgent: t.urgent || 0, priority: t.priority }
      // Connect the ledgers: dragging to change quadrant syncs priority (important⇒high, non-important⇒low), consistent with EditPanel's reverse priority⇒important mapping
      moveWithUndo(this, {
        label: this.$t('statsJ.TodoItem.movedToQuadrant', { q: this.$t(q.titleKey) }),
        apply: () => this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: { important: q.important, urgent: q.urgent, priority: q.important ? 3 : 1 } }),
        revert: () => this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: { important: snap.important, urgent: snap.urgent, priority: snap.priority } })
      })
    },
    taskTip (t) {
      const parts = [t.taskContent || this.$t('statsA.MatrixGrid.noTitle')]
      if (t.deadlineTs > 0) parts.push(this.$t('statsA.MatrixGrid.deadline', { date: dayjs(t.deadlineTs).format(FMT.cnDate) }))
      if (t.dayStart) parts.push(this.$t('statsA.MatrixGrid.dateOn', { date: dayjs(t.dayStart).format(FMT.cnDate) }))
      const prio = ['', this.$t('statsA.MatrixGrid.prioLow'), this.$t('statsA.MatrixGrid.prioMid'), this.$t('statsA.MatrixGrid.prioHigh')][(t.priority || 0)]
      if ((t.priority || 0) > 0) parts.push(this.$t('statsA.MatrixGrid.prioLabel', { p: prio }))
      parts.push(this.$t('statsA.MatrixGrid.dragHint'))
      return parts.join(' · ')
    },
    dueLabel (t) {
      return t.dayStart ? dayjs(t.dayStart).format(FMT.cnDate) : ''
    }
  },

}
</script>

<style>
/* 四象限：拖拽态与悬停（坐标轴已弃用避免重叠） */
.matrix-wrap { position: relative; }




.matrix-task.dragging { opacity: .35; transform: scale(.98); background: var(--brand-light); }




.matrix-task:hover { box-shadow: 0 1px 4px rgba(0, 0, 0, .08); }

/* 四象限视图 */
.matrix-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }




.matrix-quadrant {
  background: var(--panel, #fff); border: 1px solid var(--line); border-radius: var(--radius-lg);
  min-height: 260px; display: flex; flex-direction: column; overflow: hidden;
}




.matrix-quadrant__head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: var(--fs-md); font-weight: 600;
}




.q-urgent .matrix-quadrant__title { color: var(--danger); }




.q-plan .matrix-quadrant__title { color: var(--brand); }




.q-delegate .matrix-quadrant__title { color: #f2a63b; }




.q-later .matrix-quadrant__title { color: var(--text-3); }




.matrix-quadrant__count { font-style: normal; font-size: var(--fs-sm); color: var(--text-3); }




.matrix-quadrant__list { flex: 1; padding: 8px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 120px; }




.matrix-task {
  position: relative; padding: 8px 10px; background: var(--gray-bg); border-radius: var(--radius-md); font-size: var(--fs-md);
  display: flex; align-items: center; gap: 8px; cursor: pointer; transition: background .15s, transform .1s;
}




.matrix-task:hover { background: var(--hover-bg); }




.matrix-task:active { transform: scale(.99); }




.matrix-task.dragging { opacity: .45; }




.matrix-task__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }




.matrix-task__due { font-size: var(--fs-xs); color: var(--text-3); flex-shrink: 0; transition: opacity .15s; }
</style>
