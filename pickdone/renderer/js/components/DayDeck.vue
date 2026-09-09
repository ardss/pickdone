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
<style>/* ============================================================
   CSS 前缀归属（组件级命名空间，新组件先认领前缀再写样式）：
   sn- SideNav | ep- EditPanel | td- TodoItem/条目行 | ds- DayDateStrip
   tl- 统计时间轴 | qa- QuickAdd | cal- 日历格 | vm- ViewMoreMenu
   tg- TodoGroupBlock | rc- RecycleBin | rm- RepeatModal | w- 浮窗(WinControls/悬浮窗)
   form- SettingsModal | dropdown- 通用下拉 | main-nav- 侧栏主导航区
   无前缀 = 设计稿沿用区（原版全局类，勿与新组件混用）
   ============================================================ */
/* ===== 自 base.css 迁入（QuickAdd qa-，内容逐字未改；置于头部以保持原级联顺序 base < 本文件）===== */




.qa-wrap { flex: 1; }
/* ============================================================
   原 style-1.css（已退役 2026-09）—— 列表类页面（最近待办/待办箱/已达成/回收站/标签/清单）基础样式
   来源: 构建产物 A / 构建产物 B
   处理: 选择器已去 [data-v-*] 作用域；url(../img/*) 改写为 app://app/assets/img/*；
         设计稿「TodoBoxListItem」与「RecycleBinItem」编译后共用 .todo-box-list-item 类名
         但两套规则不同，本文件分别以 .todo-box-list / .todo-list 祖先限定以互不覆盖；
         K 节为本实现的最小适配补充，其余均为沿用既有规则。
   ============================================================ */

/* ---- A. 页面骨架（旧 TodoPageLayout）---- */
.page{display:flex;flex-direction:column;box-sizing:border-box;height:100%;overflow:hidden}
/* ---- G. 设计稿圆形勾选（原 TodoBoxListItem 多选态 .checkbox）---- */
.checkbox{position:relative;display:flex;align-items:center;justify-content:center;width:18px;height:20px;color:var(--text-4);font-size:18px;cursor:pointer}
.checkbox>svg{display:block}
.checkbox--active{color:var(--brand, #0f9d8f)}
.checkbox svg{width:16px;height:16px;display:block}
/* 回收站条目完成勾选框：复用 .td-check 形态，勾选后标题删除线弱化 */
.todo-list .todo-box-list-item__container{display:flex;flex-wrap:wrap;align-items:flex-start;column-gap:10px}
/* ============================================================
   原 style-2.css（已退役 2026-09）—— 日程概览 / 数据复盘 / 搜索 三页设计稿样式还原
   规则来源：第三方来源: 构建产物 A、构建产物 B
   （[data-v-xxx] 已剥离；url(../img/..) → app://app/assets/img/）
   FullCalendar 基础皮肤参数提取自 vendors 产物 的 .fc 规则，
   套用到自绘网格（本应用未挂载 @fullcalendar）。
   仅服务于 CalendarView / StatisticsView / SearchView。
   ============================================================ */

/* ========================= 通用：设计稿 title 行（搜索页筛选行用） ========================= */
.title{display:flex;justify-content:space-between;line-height:28px}
/* 实现微调：覆盖 base.css 旧 .lunar 字号，农历与日期同尺寸 */
.fc .fc-daygrid-day-number .holiday,
.fc .fc-daygrid-day-number .work{position:absolute;top:5px;right:5px;padding:4px;font-size:16px;border-radius:50%;zoom:.6}
/* 工具栏下拉 label 样式源自已退役的 style-1.css 第 I 节 */
.search-filter-el.el-select .el-input__inner{height:28px;line-height:28px}
/* ============================================================
   原 style-3.css（已退役 2026-09）—— 主界面微交互与细节（对齐设计稿编译 CSS）
   参考: 第三方来源: 构建产物 A / index.pretty.js
   选择器均已剥掉 [data-v-xxx]；url(../img/..) 已改为 app://app/assets/img/
   ============================================================ */

/* ===== 自 base.css 迁入（SideNav sn-，内容逐字未改；置于头部以保持原级联顺序 base < 本文件）===== */

.sn-fixed { flex-shrink: 0; }
/* ===== 自 base.css 迁入（EditPanel ep-，内容逐字未改；置于头部以保持原级联顺序 base < 本文件）===== */

/* ============ 三栏骨架 ============ */
/* position:relative：窄窗下绝对定位的 .edit-panel / .ep-rail 以此锚定（位于 25px 标题栏之下） */
.app-shell { position: relative; display: flex; height: calc(100vh - 25px); margin-top: 25px; background: var(--bg, #fff); overflow-x: auto; overflow-y: hidden; }
/* --- 卡片堆叠日程视图（DayDeck）：中心对齐轮播,侧卡露 1/3 --- */
.pd-day-deck { position: relative; padding: 4px 0 0; overflow: clip; flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* 后排卡扇形偏移禁止越出主列,否则侧边栏折叠时压到把手区 */
.pd-day-deck__stage { position: relative; flex: 1; min-height: 340px; }
.pd-day-deck__card { position: absolute; left: 50%; top: 10px; bottom: 0; width: 300px; min-height: 350px; display: flex; flex-direction: column; background: var(--panel, #fff); border: 1px solid var(--line-strong, #e4e7ed); border-radius: var(--radius-lg, 10px); padding: 14px 16px; box-sizing: border-box; }
.pd-day-deck__card.front { box-shadow: 0 12px 32px rgba(0, 0, 0, .16); }
.pd-day-deck__head { display: flex; align-items: center; justify-content: space-between; }
.pd-day-deck__label { font-size: var(--fs-lg); font-weight: 600; color: var(--text-1); }
.pd-day-deck__count { font-size: var(--fs-sm, 12px); color: var(--text-3); }
.pd-day-deck__wd { font-size: var(--fs-xs); color: var(--text-3); margin-top: 2px; }
.pd-day-deck__bar { height: 4px; border-radius: var(--radius-pill); background: var(--line); margin: 8px 0 10px; overflow: hidden; }
.pd-day-deck__bar i { display: block; height: 100%; background: var(--brand); border-radius: var(--radius-pill); }
.pd-day-deck__empty { flex: 1; display: flex; align-items: center; justify-content: center; font-size: var(--fs-sm, 12px); color: var(--text-4); }
.pd-day-deck__list { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; align-content: start; }
.pd-day-deck__list li { display: flex; align-items: center; gap: var(--space-2); font-size: var(--fs-md, 13px); color: var(--text-1); }
.pd-day-deck__list li:not(.done) { cursor: grab; }
/* 拖拽改期：任务行拖到目标日卡片上，卡片高亮提示可投放 */
.pd-day-deck__card.drop-ok { outline: 2px dashed var(--brand); outline-offset: -2px; }
.pd-day-deck__chk { width: 16px; height: 16px; flex-shrink: 0; border: 1.5px solid var(--text-4); border-radius: 50%; cursor: pointer; background: transparent; padding: 0; position: relative; }
.pd-day-deck__chk:hover { border-color: var(--brand); }
.pd-day-deck__list li.done .pd-day-deck__chk { background: var(--brand); border-color: var(--brand); }
.pd-day-deck__list li.done .pd-day-deck__chk::after { content: '✓'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: var(--fs-2xs); line-height: 1; }
.pd-day-deck__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.pd-day-deck__list li.done .pd-day-deck__title { color: var(--text-4); text-decoration: line-through; }
.pd-day-deck__tomato { border: 0; background: none; color: var(--text-3); cursor: pointer; display: inline-flex; padding: 2px; border-radius: var(--radius-sm, 4px); }
/* 卡片行删除：与列表页同语义（软删+撤销 toast），行 hover 显现、hover 变红 */
.pd-day-deck__del {
  border: 0; background: none; color: var(--text-4); cursor: pointer;
  display: inline-flex; padding: 2px; border-radius: var(--radius-sm, 4px); flex-shrink: 0;
  width: 19px; height: 19px; align-items: center; justify-content: center;
  opacity: 0; transition: opacity var(--dur-fast), color var(--dur-fast), background-color var(--dur-fast);
}
.pd-day-deck__list li:hover .pd-day-deck__del, .pd-day-deck__del:focus-visible { opacity: 1; }
.pd-day-deck__del:hover { color: var(--danger); background-color: rgba(245, 108, 108, .1); }
.pd-day-deck__tomato:hover, .pd-day-deck__tomato.pd-is-active { color: var(--brand); background: var(--brand-light); }
/* ===== 卡片视图：逾期未完成任务置顶区（deckOverdue） ===== */
.pd-day-deck__overdue-label { font-size: var(--fs-2xs); color: var(--danger, #f56c6c); padding: 0 2px 4px; font-weight: 600; }
.pd-day-deck__list--overdue { margin-bottom: 6px; padding-bottom: var(--space-1); border-bottom: 1px dashed var(--line, #e7e9ee); }
.pd-day-deck__list--overdue .pd-day-deck__title { color: var(--danger, #f56c6c); }
/* 逾期行内的原定日期徽标：回答「这是哪天拖下来的」 */
.pd-day-deck__overdue-date { flex-shrink: 0; font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; color: var(--danger, #f56c6c); background: var(--danger-soft, #fdf1f1); border-radius: 4px; padding: 1px 5px; opacity: .85; }
/* 番茄目标 input-number 纳入 110px 档位（压过 base.css 的 .modal 100px 孤值） */
.modal--settings .el-input-number--small { width: 110px; }
</style>
