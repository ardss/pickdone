<template>

  <div class="pd-day-deck" tabindex="0" role="group" :aria-label="$t('statsE.TodayView.deckAria')"
       @keydown="onKey">
    <div class="pd-day-deck__stage">
      <div v-for="(c, idx) in cards" :key="c.ts" class="pd-day-deck__card"
           :class="{ front: idx === front, 'drop-ok': dropHover === idx }"
           :style="styleOf(idx)"
           @pointerdown="onPointerDown($event)"
           @pointermove="onPointerMove($event)"
           @pointerup="onPointerUp($event)"
           @pointercancel="onPointerUp($event)"
           @dragover.prevent="onDragOver(idx, $event)"
           @dragleave="dropHover === idx && (dropHover = null)"
           @drop.prevent="onDrop(idx, $event)"
           @click.stop="onCardClick(idx)">
        <div class="pd-day-deck__head">
          <span class="pd-day-deck__label">{{ labelOf(c.ts) }}</span>
          <span class="pd-day-deck__count">{{ doneOf(c) }}/{{ c.all.length }}</span>
        </div>
        <div class="pd-day-deck__wd">{{ dayjs(c.ts).format('MM/DD') + ' ' + $t('statsA.core.weekOf', { w: $t('statsA.core.wd' + dayjs(c.ts).day()) }) }}</div>
        <div class="pd-day-deck__bar" aria-hidden="true">
          <i :style="{ width: (c.all.length ? doneOf(c) / c.all.length * 100 : 0) + '%' }"></i>
        </div>
        <div v-if="!c.all.length && !c.overdue.length" class="pd-day-deck__empty">{{ $t('statsE.TodayView.deckEmpty') }}</div>
        <template v-else>
          <div v-if="c.overdue.length" class="pd-day-deck__overdue-label">{{ $t('statsE.TodayView.deckOverdue', { n: c.overdue.length }) }}</div>
          <ul v-if="c.overdue.length" class="pd-day-deck__list pd-day-deck__list--overdue">
            <li v-for="t in c.overdue" :key="t.taskId" class="overdue"
                draggable="true" @dragstart="onDragStart(t, $event)"
                @contextmenu="taskContextMenu(t, $event)"
                tabindex="0" @keydown.shift.delete.prevent.stop="del(t)">
              <span class="pd-day-deck__chk td-check" :class="{on: t.complete}" :style="chkStyleOf(t)" role="checkbox" :aria-checked="t.complete ? 'true' : 'false'"
                 :aria-label="$t('statsE.TodoItem.markComplete')"
                 tabindex="0" @click.stop="toggle(t, $event)" @keydown.enter.prevent.stop="toggle(t, $event)"><svg v-if="t.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true"><polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg></span>
              <span class="pd-day-deck__overdue-date">{{ dayjs(t.dayStart).format('M/D') }}</span>
              <span class="pd-day-deck__title" role="button" tabindex="0"
                    :title="$t('statsE.TodayView.overdueSince', { d: dayjs(t.dayStart).format(FMT.cnDate) })"
                    :aria-label="$t('statsE.TodoItem.openEditor')"
                    @click.stop="openEdit(t)" @keydown.enter.prevent.stop="openEdit(t)">{{ t.taskContent || $t('statsE.TodayView.untitled') }}</span>
              <button class="pd-day-deck__tomato" :class="{ghost: t.complete}"
                      :tabindex="t.complete?-1:0"
                      :title="$t('statsE.TodoItem.togglePomodoroFocus')" :aria-label="$t('statsE.TodoItem.togglePomodoroFocus')"
                      @click.stop="setTomato(t)">
                <pd-app-icon name="timer" :size="14"/>
              </button>
              <button class="pd-day-deck__del" :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
                      @click.stop="del(t)" @keydown.enter.prevent.stop="del(t)">
                <pd-app-icon name="trash" :size="13"/>
              </button>
            </li>
          </ul>
          <ul v-if="c.all.length" class="pd-day-deck__list">
          <li v-for="t in c.all" :key="t.taskId"
              :class="{ done: t.complete }"
              draggable="true" @dragstart="onDragStart(t, $event)"
              @contextmenu="taskContextMenu(t, $event)"
              tabindex="0" @keydown.shift.delete.prevent.stop="del(t)">
            <span class="pd-day-deck__chk td-check" :class="{on: t.complete}" :style="chkStyleOf(t)" role="checkbox" :aria-checked="t.complete ? 'true' : 'false'"
               :aria-label="$t('statsE.TodoItem.markComplete')"
               tabindex="0" @click.stop="toggle(t, $event)" @keydown.enter.prevent.stop="toggle(t, $event)"><svg v-if="t.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true"><polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg></span>
            <span class="pd-day-deck__title" role="button" tabindex="0"
                  :aria-label="$t('statsE.TodoItem.openEditor')"
                  @click.stop="openEdit(t)" @keydown.enter.prevent.stop="openEdit(t)">{{ t.taskContent || $t('statsE.TodayView.untitled') }}</span>
            <button class="pd-day-deck__tomato"
                    :class="{ ghost: t.complete, 'pd-is-active': $store.state.tomato.attachTodo && $store.state.tomato.attachTodo.taskId === t.taskId }"
                    :tabindex="t.complete?-1:0"
                    :title="$t('statsE.TodoItem.togglePomodoroFocus')" :aria-label="$t('statsE.TodoItem.togglePomodoroFocus')"
                    @click.stop="setTomato(t)">
              <pd-app-icon name="timer" :size="14"/>
            </button>
            <button class="pd-day-deck__del" :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
                    @click.stop="del(t)" @keydown.enter.prevent.stop="del(t)">
              <pd-app-icon name="trash" :size="13"/>
            </button>
          </li>
        </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Card stack view v2 (user iteration: carousel + schedule combined) --
 * The center is a (slimmer) vertical card for the day being viewed; the left side reveals yesterday/the day before at roughly 1/3 width, and the right side symmetrically reveals tomorrow/the day after;
 * Drag left/right (or the ←/→ arrow keys) to slide across schedule days: left = toward tomorrow, right = toward yesterday.
 * Each day's schedule tasks (belonging by dayStart) attach to the corresponding card; checking complete reuses the toggleCompleteWithUndo undo chain.
 */
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo, moveWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import { toggleTomatoAttach, chkStyle } from '../utils/taskRow.js'
import { FMT } from '../utils/core.js'

// Bare dayjs is the window.dayjs global (injected by the browser host); taking an explicit reference satisfies lint and avoids global lookups
const dayjs = window.dayjs

const DAY = 86400000
const SPAN = 7 // 7 days on each side of today
const VISIBLE = 3 // Number of layers revealed on each side of the center

/* Card width adapts to the stage: after the timeline shares the main column the stage got narrower, and fixed 300px cards would clump together;
 * percentage width + a cap; the fan spacing (pos*33%) is percentage-of-card-width so it scales naturally. Style injected for now, can move back to a css file later (same precedent as DayRail V1_CSS) */
/* isolation keeps the cards' z-index scoped inside the component: bare z values once leaked to the page level, covering normal flow content / the settings entry */
/* The checkbox now uses the list's td-check: neutralizes the old circular check style and the done ghost ✕ (style-3 has parallel in-flight changes; inject now to converge, clean up together when migrating back to css) */
const DECK_CSS = '.pd-day-deck__card{width:min(40%,460px)}.pd-day-deck{isolation:isolate;overflow:clip}' +
  '.pd-day-deck__chk{width:18px;height:18px;border-radius:var(--radius-sm,6px);background:var(--panel,#fff)}' +
  '.pd-day-deck__list li.done .pd-day-deck__chk::after{content:none}'
try {
  const el = document.createElement('style')
  el.setAttribute('data-deck-css', '1')
  el.textContent = DECK_CSS
  document.head.appendChild(el)
} catch (e) { /* non-browser env */ }

export default {
  name: 'DayDeck',
  data () {
    return { front: SPAN, dragX: 0, dragging: false, dropHover: null, nowTs: Date.now() }
  },
  computed: {
    dayjs () { return window.dayjs },
    FMT () { return FMT },
    days () {
      // Depends on nowTs (30s tick): the window is recomputed after crossing midnight, otherwise the computed cache freezes at mount time
      void this.nowTs
      const t0 = +this.dayjs().startOf('day')
      return Array.from({ length: SPAN * 2 + 1 }, (_, i) => t0 + (i - SPAN) * DAY)
    },
    today0 () { void this.nowTs; return +this.dayjs().startOf('day') },
    cards () {
      const list = this.$store.state.todo.todoList
      return this.days.map(ts => {
        const card = { ts, all: list.filter(t => !t.delete && t.dayStart === ts), overdue: [] }
        // Overdue incomplete tasks are grouped at the top of the "today" card (otherwise the card view would show a sudden drop in count, making users think tasks were lost)
        if (ts === this.today0) {
          card.overdue = list.filter(t => !t.delete && !t.complete && t.dayStart && t.dayStart < this.today0)
        }
        return card
      })
    },
    labelOf () {
      return ts => {
        const d = this.dayjs(ts)
        const today = +this.dayjs().startOf('day')
        if (ts === today) return this.$t('statsA.core.today')
        if (ts === today - DAY) return this.$t('statsA.core.yesterday')
        if (ts === today + DAY) return this.$t('statsA.core.tomorrow')
        return this.$t('statsA.core.calMd', { m: d.month() + 1, d: d.date(), w: this.$t('statsA.core.weekOf', { w: this.$t('statsA.core.wd' + d.day()) }) })
      }
    }
  },
  watch: {
    // Write the globally selected date back synchronously when the day changes (A1 option 2): the date strip highlight follows, keeping list/card navigation in sync
    front (idx) {
      const ts = this.days[idx]
      if (ts && ts !== (this.$store.state.ui.daySelectedTs || 0)) this.$store.commit('ui/setDaySelected', ts)
    },
    // Reverse sync (fixed 2026-09-02): the date strip's "back to today" / calendar popover day-pick only wrote the store, and the deck had no
    // listener, so the card stack never moved. Store change → if the target day is within the ±7-day window, rotate that card to the center;
    // when the front watcher writes back the values are already equal so it won't re-trigger — no loop
    '$store.state.ui.daySelectedTs' (ts) {
      if (!ts) return
      const idx = this.days.findIndex(d => d === +ts)
      if (idx >= 0 && idx !== this.front) this.front = idx
    }
  },
  mounted () {
    // Align to the currently selected day when entering the view (position if within the ±7 day window, otherwise stay on today)
    const sel = this.$store.state.ui.daySelectedTs
    if (sel) {
      const idx = this.days.findIndex(ts => ts === +sel)
      if (idx >= 0) this.front = idx
    }
    // 30s tick: days/today0 are recomputed after crossing midnight (dayjs is non-reactive; without the tick the computed freezes at mount time)
    this._tick = setInterval(() => { this.nowTs = Date.now() }, 30000)
  },
  beforeUnmount () {
    clearInterval(this._tick)
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    doneOf (card) { return card.all.filter(t => t.complete).length },
    /** Continuous position of the center-aligned carousel: 0 = center, negative = past side, positive = future side; during drag a fractional value gives finger-following sliding.
     *  Drag direction: dragging left (dragX<0) slides the whole content left and tomorrow slides in from the right edge -> pos is added in the same direction as dragX */
    posOf (idx) {
      return idx - this.front + this.dragX / 300
    },
    styleOf (idx) {
      const pos = this.posOf(idx)
      const abs = Math.abs(pos)
      if (abs > VISIBLE + 0.5) return { display: 'none' }
      // Offset each side by about 33% of the card width: neighbor cards are covered 2/3 by the center card, showing only the outer 1/3
      return {
        // Z-order stays inside the deck's isolate context (same magnitude as --z-row): center card highest, decreasing toward both sides
        zIndex: 6 - Math.round(abs * 2),
        transform: `translateX(calc(-50% + ${pos * 33}%)) translateY(${Math.abs(pos) * 12}px) scale(${1 - Math.min(abs, 3) * 0.05})`,
        opacity: abs === 0 ? 1 : Math.max(0.4, 1 - abs * 0.25),
        transition: this.dragging ? 'none' : 'transform .32s cubic-bezier(.2,.8,.2,1), opacity .32s',
        cursor: abs < 0.5 ? 'grab' : 'pointer'
      }
    },
    toggle (t, ev) {
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: t, announce: this.$announce })
      ev.stopPropagation()
    },
    /** Same semantics as the list page: clicking the title opens the detail edit panel on the right */
    openEdit (t) {
      this.$store.commit('ui/openEdit', t)
    },
    /** Same semantics as the list page: tomato button selects/deselects the association (shared kernel taskRow.js) */
    setTomato (t) { toggleTomatoAttach(this.$store, t) },
    /* Complete-check coloring shares the same source as list/matrix (follows the category-color toggle) */
    chkStyleOf (t) { return chkStyle(this.$store, t) },
    /** Same semantics as the list page: soft-delete to recycle bin + 5-second undo toast (the card view previously had no delete entry) */
    del (t) {
      deleteWithUndo(this, this.$store, t)
    },
    /** Dragging a task row onto another day's card = rescheduling (same semantics as calendar drag: updateTodoFields + moved-to undo toast) */
    onDragStart (t, e) {
      e.dataTransfer.setData('text/plain', t.taskId)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver (idx, e) {
      if (this.dropHover !== idx) this.dropHover = idx
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop (idx, e) {
      this.dropHover = null
      const id = e.dataTransfer.getData('text/plain')
      const t = this.$store.state.todo.todoList.find(x => x.taskId === id)
      if (!t) return
      const ts = this.days[idx]
      if (+dayjs(t.dayStart).startOf('day') === ts) return
      // dayStart is the card bucketing key; todoTime is updated in sync when it aligns with the old schedule, keeping the calendar view consistent
      const patch: any = { dayStart: ts }
      const tt: any = t as any
      if (tt.todoTime && +dayjs(tt.todoTime).startOf('day') === +dayjs(tt.dayStart).startOf('day')) patch.todoTime = ts
      const orig = { dayStart: t.dayStart, todoTime: t.todoTime }
      moveWithUndo(this, {
        label: this.$t('statsJ.TodoItem.movedTo', { d: dayjs(ts).format(FMT.cnDate) }),
        apply: () => this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch }),
        revert: () => this.$store.dispatch('todo/updateTodoFields', { taskId: id, patch: orig })
      })
    },
    onPointerDown (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      // Do not start drag capture when hitting inline controls (checkbox/title/tomato/delete) or the task row itself (native drag rescheduling):
      // setPointerCapture would redirect subsequent clicks to the card container, silently swallowing real mouse clicks on the checkbox/title (only triggering onCardClick)
      if (e.target.closest('.pd-day-deck__chk, .pd-day-deck__title, .pd-day-deck__tomato, button, li')) return
      this.dragging = true
      this._moved = 0
      this._x0 = e.clientX
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    /** Clicking a side card jumps directly to that day (drag beyond 8px counts as a swipe and does not trigger the jump) */
    onCardClick (idx) {
      if (this._moved > 8) return
      if (idx !== this.front) this.front = idx
    },
    onPointerMove (e) {
      if (!this.dragging) return
      this.dragX = e.clientX - this._x0
      this._moved = Math.abs(this.dragX)
    },
    onPointerUp (_e?: Event) {
      if (!this.dragging) return
      this.dragging = false
      const TH = 70
      if (this.dragX <= -TH && this.front < this.days.length - 1) this.front++
      else if (this.dragX >= TH && this.front > 0) this.front--
      this.dragX = 0
    },
    onKey (e) {
      // Only flip days when the deck container itself has focus: pressing ←/→ while focus is on an inline control (checkbox/title)
      // must not be hijacked into day flipping (this once made the focused card get display:none for keyboard users, losing focus entirely)
      if (e.target !== e.currentTarget) return
      if (e.key === 'ArrowLeft' && this.front > 0) { this.front--; e.preventDefault() }
      if (e.key === 'ArrowRight' && this.front < this.days.length - 1) { this.front++; e.preventDefault() }
    }
  },

}
</script>
