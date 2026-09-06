<template>

  <div class="view-page cal-page" :class="['cal-font-'+settings.calendarFontSize, {'cal-show-done': settings.isShowCalendarCompleted}]">
    <div class="toolbar cal-toolbar">
      <!-- Left group: navigation and movement -->
      <span class="cal-nav-group">
        <button class="mini" @click="nav(-1)" :title="$t('statsE.CalendarView.prevPageBtn')" :aria-label="$t('statsE.CalendarView.prevPageBtn')">‹</button>
        <button class="cal-title-btn" @click.stop="toggleMonthPop" :aria-expanded="monthPop ? 'true' : 'false'"
                :title="$t('statsE.CalendarView.pickMonthBtn')" aria-haspopup="dialog">
          <h3 class="cal-title" style="display:inline">{{ rangeText() }}</h3>
          <app-icon name="chevron-down" :size="11"/>
        </button>
        <button class="mini" @click="nav(1)" :title="$t('statsE.CalendarView.nextPageBtn')" :aria-label="$t('statsE.CalendarView.nextPageBtn')">›</button>
        <!-- Year-month direct-jump panel anchored to the nav group itself (was a hardcoded left:251px from
             the page edge, which drifted right whenever sidebar width/page padding differed) -->
        <transition name="fade">
          <div v-if="monthPop" v-click-outside="() => monthPop = false" class="cal-month-pop" role="dialog" :aria-label="$t('statsE.CalendarView.pickMonthBtn')" @click.stop>
            <div class="ds-cal-head">
              <button @click="popNav(-1)" :aria-label="$t('statsE.CalendarView.prevYearBtn')">‹</button>
              <b>{{ $t('statsJ.CalendarView.yearN', { y: popYear }) }}</b>
              <button @click="popNav(1)" :aria-label="$t('statsE.CalendarView.nextYearBtn')">›</button>
            </div>
            <div class="cal-month-grid">
              <button v-for="m in 12" :key="m" class="cal-month-cell"
                      :class="{sel: popYear === selYear && m === selMonth, today: popYear === thisYear && m === thisMonth}"
                      @click="pickMonth(m)">{{ $t('statsJ.CalendarView.monthN', { m }) }}</button>
            </div>
          </div>
        </transition>
      </span>
      <!-- Right group: perspective and display -->
      <span class="ml-auto"></span>
      <span class="cal-seg" role="group" :aria-label="$t('statsE.CalendarView.switchViewBtn')">
        <button :class="{on:view==='dayGridMonth'}" @click="setView('dayGridMonth')">{{ $t('statsE.CalendarView.monthViewLabel') }}</button>
        <button :class="{on:view==='dayGridWeek'}" @click="setView('dayGridWeek')">{{ $t('statsE.CalendarView.weekViewLabel') }}</button>
        <button :class="{on:view==='timeblock'}" @click="setView('timeblock')">{{ $t('statsE.CalendarView.timeBlocksViewLabel') }}</button>
      </span>
      <label class="chk"><input type="checkbox" :checked="settings.isShowCalendarCompleted" @change="$store.commit('settings/updateSettings',{isShowCalendarCompleted:$event.target.checked})">{{ $t('statsE.CalendarView.showCompletedToggle') }}</label>
      <!-- Blur schedule moved behind developer-mode gating (decided 2026-09-01: the toggle causes layout jumps; treat as experimental and hide by default) -->
      <label v-if="settings.developerMode" class="chk"><input type="checkbox" :checked="settings.isShowCalendarPrivacyMode" @change="$store.commit('settings/updateSettings',{isShowCalendarPrivacyMode:$event.target.checked})">{{ $t('statsE.CalendarView.blurScheduleToggle') }}</label>
      <!-- Back to today: icon button at the right edge, always fully visible.
           Two earlier treatments both failed user acceptance: v-if removal caused toolbar width jumps,
           ghost dimming (opacity .35) made the icon effectively invisible — users read it as "no button".
           Now always rendered active; clicking when already on today is a harmless no-op. -->
      <button class="cal-today-btn" @click="today()" :title="$t('statsE.CalendarView.backToTodayBtn')" :aria-label="$t('statsE.CalendarView.backToTodayBtn')"><app-icon name="locate" :size="14"/></button>
    </div>
    <div v-if="view!=='timeblock'" ref="fcEl" class="cal-fc" :class="{blur:settings.isShowCalendarPrivacyMode, dim:settings.isShowCalendarCompleted && settings.isCalendarDimUncompleted, 'show-done':settings.isShowCalendarCompleted}"></div>
    <div v-else-if="view==='timeblock'" class="cal-tb" :class="{blur:settings.isShowCalendarPrivacyMode}">
      <div class="cal-tb__pool">
        <span class="cal-tb__pool-label">{{ $t('statsE.CalendarView.unscheduledLabel') }}</span>
        <span v-for="t in tbPool" :key="t.taskId" class="cal-tb__chip" draggable="true"
              :title="t.taskContent + $t('statsE.CalendarView.dragToTimeGridTip')" @dragstart="tbDragStart(t, $event)">{{ t.taskContent || $t('statsJ.CalendarView.untitled') }}</span>
        <span v-if="!tbPool.length" class="cal-tb__pool-empty">{{ $t('statsE.CalendarView.allScheduledMsg') }}</span>
      </div>
      <div class="cal-tb__scroll">
        <div class="cal-tb__grid">
          <div class="cal-tb__corner"></div>
          <div v-for="d in tbDays" :key="d.ts" class="cal-tb__dayhead" :class="{today:d.isToday}">
            {{ d.label }}<i>{{ $t('statsJ.CalendarView.dayN', { n: d.dom }) }}</i>
          </div>
          <template v-for="h in tbHours" :key="h">
            <div class="cal-tb__hour" :style="{height: tbRowH+'px'}">{{ String(h).padStart(2,'0') }}:00</div>
            <div v-for="d in tbDays" :key="d.ts+'-'+h" class="cal-tb__cell"
                 :class="{today:d.isToday}" :data-day="d.ts" :data-hour="h"
                 @dragover.prevent @drop.prevent="tbDrop(d.ts, h, $event)"
                 @click="tbCreate(d.ts, h)">
              <div v-for="t in tbTasksOf(d.ts, h)" :key="t.taskId" class="cal-tb__task"
                   draggable="true" :title="t.taskContent + $t('statsE.CalendarView.dragToAdjustTimeTip')"
                   @dragstart="tbDragStart(t, $event)" @click.stop="openTaskEditById(t.taskId)"
                         @contextmenu="taskContextMenu(t, $event)">
                {{ (t.taskContent || $t('statsE.TodoItem.untitled')) }}
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
    <div v-if="morePop" v-click-outside="() => morePop = null" class="cal-more-pop" :style="{left: morePop.left+'px', top: morePop.top+'px'}" role="dialog" :aria-label="fmtDate(morePop.date)+$t('statsE.CalendarView.allEventsSuffix')">
      <div class="cal-more-pop__head"><b>{{ fmtDate(morePop.date) }}</b>
        <button type="button" class="cal-more-pop__x close-x close-x--sm" :title="$t('statsE.SettingsModal.closeBtn')" :aria-label="$t('statsE.SettingsModal.closeBtn')"
              @click="morePop=null" @keydown.enter.prevent="morePop=null"></button></div>
      <div class="cal-more-pop__body">
        <div v-for="e in morePop.events" :key="e.id" class="cal-more-pop__item"
             :style="{background: e.backgroundColor}" role="button" tabindex="0"
             @click="openEvent(e.id)" @keydown.enter.prevent="openEvent(e.id)">{{ e.title || $t('statsE.TodoItem.untitled') }}</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Calendar overview —— built on the FullCalendar library (@fullcalendar/core+daygrid+interaction, v6 IIFE global)
 * Month/week view switching, events = category-colored task chips, today highlight, privacy blur, completion strikethrough, lunar/festival badges
 */
import {dayjs, safeSet, FMT } from '../utils/core.js'
import { getLocale } from '../i18n/index.js'
import { moveWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import { ensureFullCalendar } from '../utils/lazy-script.js'
// Date formats follow the locale: FMT.cn* are Chinese format constants; English locale uses English formats, otherwise the toolbar mixes scripts
const EN = () => getLocale() === 'en-US'
const fmtMonth = d => EN() ? d.format('MMMM YYYY') : d.format(FMT.cnMonth)
const fmtDate = d => EN() ? d.format('MMM D') : d.format(FMT.cnDate)
const fmtFull = d => EN() ? d.format('dddd, MMM D, YYYY') : d.format(FMT.cnFull)

// Weekday labels: shared at module level (wd0 = Sunday-first, aligned with dayjs.day())
function wdLabel (t, d) { return t('statsJ.CalendarView.wd' + ((d + 6) % 7)) }
// Weekday labels (statsJ.CalendarView.wd0~wd6, Monday-first; dayjs.day() Sunday=0 -> shifted so Monday=0)
// Called via this in data/computed context — module top level has no this, so this._i18n is passed into the function;
// actual calls all go through the this.wd(d) method (below), keeping Vue template compilation friendly.

import { loadSolarLunar } from '../utils/lunar.js'
const LUNAR = () => loadSolarLunar().then(m => {
  const sl = m.default || m
  // ISC-licensed solarlunar (the former js-calendar-converter was GPL, so the library had to be swapped); adapts IDayCn/IMonthCn fields so callers need zero changes
  return { calendar: { solar2lunar (y, mo, da) {
    const r = sl.solar2lunar(new Date(y, mo - 1, da))
    return r ? Object.assign({}, r, { IDayCn: r.dayCn, IMonthCn: r.monthCn }) : r
  } } }
})


export default {
  name: 'CalendarView',
  data () {
    return { cal: null, cursorTs: 0, lunarMap: {}, view: 'dayGridMonth', tbWeekStart: 0, tbDragTask: null, morePop: null, busyDays: null, monthPop: false, popYear: dayjs().year(), selMonthTs: 0, todayInView: true }
  },
  computed: {
    /* ===== Time block view ===== */
    tbDays () {
      const start = this.tbWeekStart || +dayjs().startOf('week')
      const today = +dayjs().startOf('day')
      return Array.from({ length: 7 }, (_, i) => {
        const ts = start + i * 86400000
        return { ts, label: wdLabel(this.$t.bind(this), dayjs(ts).day()), dom: dayjs(ts).date(), isToday: ts === today }
      })
    },
    tbHours () { return Array.from({ length: 18 }, (_, i) => i + 6) },
    tbRowH () { return 56 },
    tbPool () {
      const start = this.tbWeekStart || +dayjs().startOf('week')
      const end = start + 7 * 86400000
      return this.$store.state.todo.todoList.filter(t => {
        if (t.complete || t.delete || !t.dayStart || t.dayStart < start || t.dayStart >= end) return false
        return !t.todoTime || t.todoTime === t.dayStart
      })
    },
    settings () { return this.$store.state.settings },
    editVisible () { return this.$store.state.ui.rightSidebarTodoEdit.visible },
    editCollapsed () { return this.$store.state.ui.rightSidebarTodoEdit.collapsed },
    selYear () { return this.selMonthTs ? dayjs(this.selMonthTs).year() : -1 },
    selMonth () { return this.selMonthTs ? dayjs(this.selMonthTs).month() + 1 : -1 },
    thisYear () { return dayjs().year() },
    thisMonth () { return dayjs().month() + 1 },
    fcEvents () {
      // Caution: this array must never read settings — any settings change goes through the watcher and triggers a full FullCalendar re-layout,
      // and the relayout causes layout drift (event widths flickering large/small). Hiding for "show completed" is now done via container CSS
      // (when .cal-fc lacks show-done, display:none the completed events); busyDays is filtered separately per settings in the watcher.
      return this.$store.state.todo.todoList
        .filter(t => !t.delete && t.dayStart)
        .map(t => ({
          id: t.taskId,
          title: t.taskContent,
          start: t.dayStart,
          allDay: true,
          done: !!t.complete,
          // Project baseline does not gray out: keep the category color; completed items are distinguished by translucency + strikethrough (CSS .todo-done-strike)
          backgroundColor: this.catColor(t),
          borderColor: 'transparent',
          classNames: [
            'todo-cal-event',
            // Completed items are always struck through (consistent with the list page standard); strikethrough no longer has its own toggle
            t.complete ? 'todo-done-strike' : ''
            // Blurred schedule / dim-incomplete no longer attach event-level classes: all toggle-driven styles moved to container-level pure CSS (.cal-fc.blur / .cal-fc.dim).
            // Previously fcEvents read settings, so any settings change rebuilt events and triggered a full FullCalendar re-layout,
            // whose layout drift made event widths flicker (measured width/cell ratio 0.96↔3.78)
          ].filter(Boolean)
        }))
    }
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    wd (d) { return this.$t('statsJ.CalendarView.wd' + ((d + 6) % 7)) },
    /** 直接在该日创建「未命名」事件并打开编辑(格子角标 + / 键盘 Enter 共用) */
    createAt (ts) {
      return this.$store.dispatch('todo/addTodo', { todoContent: '', todoDate: ts })
        .then(t => this.$store.commit('ui/openEdit', t))
    },
    catColor (t) {
      const c = this.$store.getters['category/byId'](t.categoryId)
      // Fallback must not use DEFAULT_CAT_COLOR (brand cyan; white contrast 3.36 fails): use the same-family deep teal as --brand-text, white contrast 5.9
      return c ? c.categoryColor : '#0a6f62'
    },
    async loadLunarMap () {
      try {
        const mod: any = await LUNAR()
        const cal = mod.calendar || mod.default || mod
        const m = {}
        const first = dayjs().startOf('month').subtract(2, 'month')
        for (let i = 0; i < 150; i++) {
          const d = first.add(i, 'day')
          const r = cal.solar2lunar(d.year(), d.month() + 1, d.date())
          if (r) {
            m[d.format(FMT.date)] = r.festival || r.lunarFestival || r.Term ||
              (r.IDayCn === '初一' ? r.IMonthCn : r.IDayCn)
          }
        }
        this.lunarMap = m
        if (this.cal) this.cal.render()
      } catch (e) { /* lunar calendar is optional */ }
    },
    /** Container-level size observation: FC only listens to window resize and cannot sense container changes (sidebar/edit rail/time track).
     *  Triple protection against re-entrancy crashes (history: RO directly calling updateSize once crashed the more-popover with null offsetParent):
     *  2px width threshold to filter jitter + rAF frame coalescing + skip while the more-popover is open */
    attachSizeObserver () {
      const el = this.$refs.fcEl
      if (!el) return
      if (!this._ro) {
        this._lastW = 0
        this._ro = new ResizeObserver(entries => {
          const w = entries[0].contentRect.width
          if (Math.abs(w - this._lastW) < 2) return
          this._lastW = w
          if (document.querySelector('.fc-more-popover')) return
          requestAnimationFrame(() => this.cal && this.cal.updateSize())
        })
      }
      if (this._roTarget !== el) { this._ro.disconnect(); this._ro.observe(el); this._roTarget = el }
    },
    renderCalendar (initialDateTs) {
      const el = this.$refs.fcEl
      if (!el) return
      // FullCalendar lazy load (2026-09-02 startup optimization): inject the whole bundle only on first render of the calendar page
      if (!window.FullCalendar) {
        ensureFullCalendar().then(() => { if (!this._destroyed) this.renderCalendar(initialDateTs) }).catch(() => {})
        return
      }
      if (this.cal) { this.cal.destroy(); this.cal = null }
      // View switching swaps in a new fcEl via v-if, so the observer must be re-attached to the new element
      if (typeof ResizeObserver !== 'undefined') this.attachSizeObserver()
      const self = this
      // initialDate: keep the user's current month on fallback rebuilds during navigation, don't jump back to today
      // markRaw: FullCalendar instances must not enter Vue's reactive proxy — proxy wrapping breaks its internal render scheduling
      // (symptom: prev/next advance the internal date but the DOM grid and title don't update, appearing as "clicks do nothing")
      const calOptions = {
        // Grid language follows the app locale (FullCalendar defaults to English, so locale must be passed explicitly; locale packs are fully loaded via locales-all)
        locale: getLocale() === 'en-US' ? 'en' : 'zh-cn',
        // The page ships its own cal-toolbar (title/today/paging/view switch); FullCalendar's native header is not rendered to avoid double toolbars
        headerToolbar: false,
        // 不折叠(dayMaxEvents 默认 false):格子内滚动看全部(2026-09-04 用户定稿,弃 "+N"弹窗形式);
        // 高度封顶由 CSS .fc-daygrid-day-events 的 max-height+overflow-y 承担。moreLinkClick 留作防御。
        initialView: this.view,
        initialDate: initialDateTs || undefined,
        // On view/date change, refresh the "today" anchor visibility and the year-month panel selection (drives template re-render)
        datesSet (info) {
          const t = dayjs().startOf('day')
          self.todayInView = !t.isBefore(dayjs(info.view.currentStart).startOf('day')) &&
                             !t.isAfter(dayjs(info.view.currentEnd).startOf('day'))
          // Reactive cursor: rangeText is a computed, but cal.getDate() is non-reactive — once computed, it's cached forever,
          // freezing the title after paging (a real regression, caught by the corrupted ui-smoke). Title/month panel are both driven from here.
          const d = dayjs(info.view.currentDate || info.view.currentStart)
          self.cursorTs = +d.startOf('day')
          self.selMonthTs = +d.startOf('month')
        },
        // "+N" -> 自绘日浮层(与格子右上角展开钮共用 openDayPeek)
        moreLinkClick (info) {
          self.openDayPeek(+dayjs(info.date).startOf('day'), info.dayEl)
          return false
        },
        // Drag to reschedule (interaction plugin); only changing the start date is allowed, not stretching the span
        editable: true,
        eventDurationEditable: false,
        eventDrop (info) {
          self._droppedAt = Date.now()
          const ts = +dayjs(info.event.start).startOf('day')
          if (self._dragInfo && ts !== self._dragInfo.origTs) {
            const origTs = self._dragInfo.origTs
            // Same semantics as list/card drag: moveWithUndo provides the unified "moved to X + undo"
            moveWithUndo(self, {
              label: self.$t('statsJ.TodoItem.movedTo', { d: dayjs(ts).format(FMT.cnDate) }),
              apply: () => self.$store.dispatch('todo/updateTodoFields', { taskId: info.event.id, patch: { todoTime: ts } }),
              revert: () => {
                const raw = self.$store.state.todo.todoList.find(x => x.taskId === info.event.id)
                if (raw) self.$store.dispatch('todo/updateTodoFields', { taskId: info.event.id, patch: { todoTime: origTs } })
              }
            })
          }
        },
        eventDragStart (info) {
          self._dragInfo = { taskId: info.event.id, origTs: +dayjs(info.event.start).startOf('day') }
          self._autoNav = 0
          self._edgeDir = 0
          self._edgeTimer = null
          // Hovering on the calendar's left/right edge for 1s during a drag auto-flips to the previous/next month (cross-month dragging)
          self._onDragMove = (e) => {
            const cell = self.$refs.fcEl
            if (!cell) return
            const r = cell.getBoundingClientRect()
            const dir = e.clientX - r.left < 40 ? -1 : (r.right - e.clientX < 40 ? 1 : 0)
            if (dir !== self._edgeDir) {
              self._edgeDir = dir
              clearTimeout(self._edgeTimer)
              if (dir) {
                self._edgeTimer = setTimeout(() => {
                  self._autoNav = dir
                  dir > 0 ? self.cal.next() : self.cal.prev()
                }, 1000)
              }
            }
          }
          document.addEventListener('mousemove', self._onDragMove)
        },
        eventDragStop () {
          document.removeEventListener('mousemove', self._onDragMove)
          clearTimeout(self._edgeTimer)
          const auto = self._autoNav
          self._autoNav = 0
          // Page-flip re-render interrupts the native drag (eventDrop not fired): shift the event by one month along the edge direction,
          // the user can then keep dragging it to the desired date in the new month view
          if (auto && self._dragInfo && Date.now() - (self._droppedAt || 0) > 200) {
            const t = self.$store.state.todo.todoList.find(x => x.taskId === self._dragInfo.taskId)
            if (t && t.dayStart) {
              const ts = +dayjs(t.dayStart).add(auto > 0 ? 1 : -1, 'month').startOf('day')
              const origTs = t.todoTime
              // Part of the drag gesture, but a whole-month silent shift is too easy to miss: same moveWithUndo as eventDrop
              moveWithUndo(self, {
                label: self.$t('statsJ.TodoItem.movedTo', { d: dayjs(ts).format(FMT.cnDate) }),
                apply: () => self.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { todoTime: ts } }),
                revert: () => self.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { todoTime: origTs } })
              })
            }
          }
          self._dragInfo = null
        },
        // Keyboard accessibility (WCAG 2.1.1): date cells and event chips are focusable, Enter equals click
        dayCellDidMount (arg) {
          const key = dayjs(arg.date).format(FMT.date)
          if (self.busyDays && !self.busyDays.has(key) && self.view === 'dayGridWeek') {
            arg.el.classList.add('xs-day-empty')
          }
          arg.el.setAttribute('tabindex', '0')
          arg.el.setAttribute('role', 'gridcell') // valid child role of row (a button would make axe report aria-required-children/nested-interactive)
          arg.el.setAttribute('aria-label', self.$t('statsJ.CalendarView.pressEnterCreate', { d: fmtDate(dayjs(arg.date)) }))
        },
        eventDidMount (info) {
          info.el.setAttribute('tabindex', '0')
          info.el.setAttribute('role', 'button')
          info.el.title = info.event.title
          info.el.setAttribute('aria-label', info.event.title + self.$t('statsE.CalendarView.pressEnterSuffix'))
          info.el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              const raw = self.$store.state.todo.todoList.find(x => x.taskId === info.event.id)
              if (raw) self.$store.commit('ui/openEdit', raw)
            }
          })
        },
        eventClick (info) {
          info.jsEvent.preventDefault()
          const raw = self.$store.state.todo.todoList.find(x => x.taskId === info.event.id)
          if (raw) self.$store.commit('ui/openEdit', raw)
        },
        // Weekday display (finalized after user request, known-UX 2026-08-28: its own row under the number, mirroring the date strip's two-line style)
        dayCellContent (arg) {
          const d = dayjs(arg.date)
          const key = d.format(FMT.date)
          // 农历/节气徽标只服务中文面：solarlunar 产出是中文词（初一/白露/中秋节），
          // 英文界面下无法翻译，直接不渲染（2026-09-06 混语言审查）。
          // getLocale() 读 localStorage（locale 唯一来源），$i18n 在本组件不可达
          const zhSurface = getLocale() !== 'en-US'
          const lunar = zhSurface ? self.lunarMap[key] : ''
          const num = arg.dayNumberText
          const week = wdLabel(self.$t.bind(self), d.day())
          return {
            html: `<div class="todo-daycell"><b>${num}</b><span class="todo-week">${week}</span>` +
              (lunar ? `<span class="todo-lunar${/节|元|春|国/.test(lunar) ? ' todo-festival' : ''}">${lunar}</span>` : '') +
              `<span class="day-cell-actions"><button type="button" class="day-create-btn" data-create-date="${key}" title="${self.$t('statsE.CalendarView.dayCreateTip')}" aria-label="${self.$t('statsE.CalendarView.dayCreateTip')}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button><button type="button" class="day-expand-btn" data-expand-date="${key}" title="${self.$t('statsE.CalendarView.dayExpandTip')}" aria-label="${self.$t('statsE.CalendarView.dayExpandTip')}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3h7v7M13 3L8.5 7.5M10 13H3V6M3 13l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span>` +
              '</div>'
          }
        },
        events (info, success) {
          success(self.fcEvents)
          // Record dates that have events, used for the week view's empty-day guidance
          self.busyDays = new Set(self.fcEvents.map(ev => dayjs(ev.start).format(FMT.date)))
          self.$nextTick(() => self.markEmptyDays())
        }
      }
      this.cal = window.Vue.markRaw(new window.FullCalendar.Calendar(el, calOptions))
      this.cal.render()
    },
    markEmptyDays () {
      if (this.view !== 'dayGridWeek' || !this.busyDays) return
      this.$nextTick(() => {
        document.querySelectorAll('.cal-fc .fc-dayGridWeek-view .fc-daygrid-day').forEach(el => {
          const key = (el.getAttribute('data-date') || '').trim()
          el.classList.toggle('xs-day-empty', !!key && !this.busyDays.has(key))
        })
      })
    },
    setView (v) {
      const wasTb = this.view === 'timeblock'
      this.view = v
      // Collapse the month picker bubble when switching views (otherwise it still overlays the time block and can only be closed by clicking outside)
      this.monthPop = false
      // Time block is not a FullCalendar view: entering it must destroy the instance (v-if removes fcEl from the DOM,
      // the old instance is bound to a destroyed element, and after switching back to month view prev/next advance the internal date but the UI never updates);
      // leaving time block requires a full rebuild instead of changeView — the new fcEl is a brand-new element the old instance can't touch
      if (v === 'timeblock') {
        if (this.cal) { this.cal.destroy(); this.cal = null }
      } else if (wasTb || !this.cal) {
        const d = this.cal ? +dayjs(this.cal.getDate()).startOf('day') : 0
        this.$nextTick(() => this.renderCalendar(d))
      } else {
        this.cal.changeView(v)
      }
      safeSet('mainCalendarView', v)
      // View goes into route query: preserve state across refresh
      const want = v === 'dayGridWeek' ? 'week' : undefined
      if (this.$route.query.view !== want) this.$router.replace({ query: want ? { view: want } : {} }).catch(() => {})
    },
    today () {
      if (this.view === 'timeblock') this.tbWeekStart = 0
      if (this.cal) this.cal.today()
      this.monthPop = false
    },
    /* ===== Time block view methods ===== */
    tbTasksOf (dayTs, hour) {
      const slotStart = dayTs + hour * 3600000
      const slotEnd = slotStart + 3600000
      return this.$store.state.todo.todoList.filter(t => {
        if (t.complete || t.delete || !t.todoTime || t.todoTime === t.dayStart) return false
        return t.todoTime >= slotStart && t.todoTime < slotEnd
      })
    },
    tbDragStart (t, e) {
      this.tbDragTask = t
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(t.taskId))
    },
    async tbDrop (dayTs, hour, e) {
      // Cross-view delivery: prefer dataTransfer (drag-ins from list/matrix/card deck); fall back to component state for drags within this view
      let t = this.tbDragTask
      this.tbDragTask = null
      if (!t && e) {
        const id = e.dataTransfer.getData('text/plain')
        if (id) t = this.$store.state.todo.todoList.find(x => x.taskId === id)
      }
      if (!t) return
      const ts = dayTs + hour * 3600000
      const origDay = t.dayStart
      const origTime = t.todoTime
      moveWithUndo(this, {
        label: this.$t('statsJ.CalendarView.movedTo', { d: fmtDate(dayjs(ts)) + ' ' + dayjs(ts).format('HH:mm') }),
        apply: () => this.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { dayStart: dayTs, todoTime: ts } }),
        revert: () => this.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { dayStart: origDay, todoTime: origTime } })
      })
    },
    tbCreate (dayTs, hour) {
      const ts = dayTs + hour * 3600000
      this.$store.dispatch('todo/addTodo', { todoContent: '', todoDate: dayTs, todoTime: ts })
        .then(t => this.$store.commit('ui/openEdit', t))
    },
    nav (dir) {
      if (this.view === 'timeblock') {
        this.tbWeekStart = (this.tbWeekStart || +dayjs().startOf('week')) + dir * 7 * 86400000
        return
      }
      if (!this.cal) return
      const firstBefore = (document.querySelector('.fc-daygrid-day') || { getAttribute: () => null }).getAttribute('data-date')
      dir === 1 ? this.cal.next() : this.cal.prev()
      // Fallback: in some environments FullCalendar's incremental render doesn't land in the DOM (internal date advances, grid unchanged),
      // after 600ms verify the first visible grid cell; if unchanged, fully rebuild at the current date (initialDate keeps the user's position)
      this.$nextTick(() => {
        setTimeout(() => {
          if (!this.cal) return
          const firstAfter = (document.querySelector('.fc-daygrid-day') || { getAttribute: () => null }).getAttribute('data-date')
          if (firstAfter && firstBefore && firstAfter === firstBefore) {
            this.renderCalendar(+dayjs(this.cal.getDate()).startOf('day'))
          }
        }, 600)
      })
    },
    /* Year-month direct-jump panel */
    toggleMonthPop () {
      if (this.monthPop) { this.monthPop = false; return }
      const d = dayjs(this.cal ? this.cal.getDate() : Date.now())
      this.popYear = d.year()
      this.monthPop = true
    },
    popNav (dir) { this.popYear += dir },
    pickMonth (m) {
      this.monthPop = false
      if (this.cal) this.cal.gotoDate(`${this.popYear}-${String(m).padStart(2, '0')}-01`)
    },
    rangeText () {
      if (!this.cursorTs) return ''
      const d = dayjs(this.cursorTs)
      if (this.view === 'dayGridWeek') return fmtFull(d) + ' · ' + wdLabel(this.$t.bind(this), d.day())
      // Month view: show only year-month — the button's job is "pick year-month"; today info is carried by the highlighted grid cell and the "today" button,
      // concatenating it into the title would crowd the width and mismatch the button semantics (removed, finalized by user on 2026-08-30)
      return fmtMonth(d)
    },
    fmtDate (ts) {
      const d = dayjs(ts)
      return this.$t('statsJ.CalendarView.dateWithWeek', { d: fmtDate(d), w: wdLabel(this.$t.bind(this), d.day()) })
    },
    openTaskEditById (taskId) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === taskId)
      this.morePop = null
      if (raw) this.$store.commit('ui/openEdit', raw)
    },
    openEvent (id) {
      const raw = this.$store.state.todo.todoList.find(x => x.taskId === id)
      this.morePop = null
      if (raw) this.$store.commit('ui/openEdit', raw)
    },
    /** 日浮层:列出某天全部事件(含已完成/被折叠的),anchor=锚定日格;事件源实时取,防补录/勾选后过期 */
    openDayPeek (ts, dayEl) {
      const host = this.$refs.fcEl
      if (!host) return
      const hr = host.getBoundingClientRect()
      const dr = (dayEl && dayEl.getBoundingClientRect) ? dayEl.getBoundingClientRect() : null
      const anchorX = dr ? dr.left + dr.width / 2 : hr.left + hr.width / 2
      const anchorY = dr ? dr.top + 20 : hr.top + 40
      this.morePop = {
        date: ts,
        events: this.fcEvents.filter(ev => ev.start === ts),
        left: Math.min(Math.max(8, anchorX - hr.left - 110), Math.max(8, hr.width - 228)),
        top: Math.min(Math.max(8, anchorY - hr.top), Math.max(8, hr.height - 120))
      }
    }
  },
  mounted () {
    // Date-cell keyboard proxy: cells are redrawn dynamically by FullCalendar, so Enter/Space is delegated on the container
    this._onKey = (e) => {
      if (e.key === 'Escape') { this.morePop = null; return }
      if (e.key !== 'Enter' && e.key !== ' ') return
      const cell = e.target.closest && e.target.closest('.fc-daygrid-day')
      if (!cell || !cell.dataset.date) return
      e.preventDefault()
      this.$store.dispatch('todo/addTodo', { todoContent: '', todoDate: +dayjs(cell.dataset.date) })
        .then(t => this.$store.commit('ui/openEdit', t))
    }
    if (this.$refs.fcEl) this.$refs.fcEl.addEventListener('keydown', this._onKey)
    // 格子右上角展开钮:FC 动态重绘格子,事件委托到容器;挡住冒泡防触发 dateClick 建任务
    this._onExpandClick = (e) => {
      const create = e.target.closest && e.target.closest('.day-create-btn')
      if (create && create.dataset.createDate) {
        e.stopPropagation()
        e.preventDefault()
        this.createAt(+dayjs(create.dataset.createDate).startOf('day'))
        return
      }
      const btn = e.target.closest && e.target.closest('.day-expand-btn')
      if (!btn || !btn.dataset.expandDate) return
      e.stopPropagation()
      e.preventDefault()
      this.openDayPeek(+dayjs(btn.dataset.expandDate).startOf('day'), btn.closest('.fc-daygrid-day'))
    }
    if (this.$refs.fcEl) this.$refs.fcEl.addEventListener('click', this._onExpandClick, true)
    // Initial view: route query takes priority (deep link/refresh), then the localStorage memory (time block view is restored too; it used to be ignored and fall back to month view)
    const qView = this.$route.query.view
    if (qView === 'week') this.view = 'dayGridWeek'
    else {
      const saved = localStorage.getItem('mainCalendarView')
      if (saved === 'dayGridWeek' || saved === 'timeblock' || saved === 'dayGridMonth') this.view = saved
    }
    this.loadLunarMap()
    // External changes also go through the fcEvents watcher via setOption; no duplicated full replacement here (the same change used to trigger a double re-render)
    this._onChanged = () => {}
    this._offChanged = window.todoAPI.onTodosChanged(this._onChanged)
    this.renderCalendar()
    this.$watch('editVisible', () => { this.$nextTick(() => { this.cal && this.cal.updateSize() }) })
    this.$watch('editCollapsed', () => { this.$nextTick(() => { this.cal && this.cal.updateSize() }) })
    // 显示已完成切换必须整表重建:FC 原地重算(hidden 芯片参与旧高度快照)会把行高撑到 1200px+(2026-09-04 实测);
    // 全新渲染两种状态都正常,故走 renderCalendar 并保持当前月份不跳
    this.$watch(() => this.settings.isShowCalendarCompleted, () => {
      this.$nextTick(() => this.renderCalendar(+this.cursorTs))
    })
  },
  watch: {
    fcEvents: {
      deep: false,
      handler (v) {
        // busyDays cannot rely only on the events source callback: after the watcher replaces statically via setOption, the source callback no longer fires
        const showDone = this.settings.isShowCalendarCompleted
        this.busyDays = new Set(v.filter(ev => showDone || !ev.done).map(ev => dayjs(ev.start).format(FMT.date)))
        if (this.cal) this.cal.setOption('events', v)
        this.$nextTick(() => this.markEmptyDays())
      }
    }
  },
  beforeUnmount () {
    this._destroyed = true
    if (this._offChanged) this._offChanged()
    if (this._ro) { this._ro.disconnect(); this._ro = null }
    if (this.$refs.fcEl && this._onKey) this.$refs.fcEl.removeEventListener('keydown', this._onKey)
    if (this.$refs.fcEl && this._onExpandClick) this.$refs.fcEl.removeEventListener('click', this._onExpandClick, true)
    if (this._onDragMove) document.removeEventListener('mousemove', this._onDragMove)
    clearTimeout(this._edgeTimer)
    if (this.cal) { this.cal.destroy(); this.cal = null }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* —— FullCalendar 关键皮肤参数（提取自 chunk-vendors 的 .fc 基础规则），套自绘网格 —— */
.cal-fc{--fc-page-bg-color:#fff;--fc-border-color:#ddd;--fc-today-bg-color:rgba(255,220,40,.15);--fc-event-bg-color:#3788d8;--fc-event-text-color:#fff;display:flex;flex-direction:column;height:100%;font-size:1em;background:var(--fc-page-bg-color)}
.cal-fc *,
.cal-fc :after,
.cal-fc :before{box-sizing:border-box}
/* ============ FullCalendar 轮子皮肤（对齐设计稿 .fc 参数） ============ */
.cal-fc.fc { font-family: inherit; }
.cal-fc.fc .fc-toolbar.fc-header-toolbar { display: none; }
.cal-fc.fc .fc-col-header-cell-cushion { color: var(--brand-dark); font-size: var(--fs-md); font-weight: 600; padding: 6px 0; text-decoration: none; }
.cal-fc.fc .fc-daygrid-day { background: var(--panel, #fff); }
.cal-fc.fc .fc-day-today { background: rgba(255, 220, 40, .15); }
.cal-fc.fc .fc-daygrid-day-number { color: #333; font-size: var(--fs-sm); padding: 4px 6px; text-decoration: none; }
.cal-fc.fc .fc-day-today .fc-daygrid-day-number { color: var(--brand); font-weight: 700; }
.cal-fc.fc .fc-daygrid-day-frame { min-height: 88px; }
.cal-fc.fc .fc-h-event { background: var(--brand); border: none; border-radius: var(--radius-sm); }
.cal-fc.fc .fc-h-event .fc-event-main { color: #fff; font-size: var(--fs-xs); padding: 1px 4px; }
.cal-fc.fc .fc-event.todo-cal-event { cursor: pointer; }
.cal-fc.fc .fc-daygrid-event { margin: 1px 2px; }
/* 芯片单行截断:长标题不撑宽;溢出事件在格子内滚动直读(用户定稿,弃折叠+弹窗) */
.cal-fc.fc .fc-daygrid-event .fc-event-title,
.cal-fc.fc .fc-daygrid-event .fc-event-title-container { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-fc.fc .fc-daygrid-day-events { overflow-y: auto; overflow-x: hidden; max-height: 140px; scrollbar-width: thin; scrollbar-color: var(--line, #d8dde2) transparent; overscroll-behavior: contain; }
.cal-fc.fc .fc-daygrid-day-events::-webkit-scrollbar { width: 6px; }
.cal-fc.fc .fc-daygrid-day-events::-webkit-scrollbar-thumb { background: var(--line, #d8dde2); border-radius: 3px; }
.cal-fc.fc .fc-daygrid-day-events::-webkit-scrollbar-track { background: transparent; }
/* FC 原生 more-popover 禁用(moreLinkClick 返回 false 拦不住):一律走自绘 cal-more-pop */
.cal-fc.fc .fc-more-popover { display: none !important; }
/* "+N 更多"折叠入口:弱化成文字链,悬浮可读 */
.cal-fc.fc .fc-daygrid-more-link,
.cal-fc.fc .fc-more-link { color: var(--text-2); font-size: var(--fs-xs); font-weight: 500; padding: 0 4px; }
.cal-fc.fc .fc-daygrid-more-link:hover { color: var(--brand-text, #0a6f62); background: var(--gray-bg, #f5f7f7); border-radius: var(--radius-sm); }
/* 浮层内已完成项弱化(浮层始终全量,含被折叠的) */
.cal-more-pop__item.todo-pop-done { opacity: .55; }
.cal-fc.fc .fc-daygrid-day-number .todo-daycell b { font-weight: 500; }
/* 显示已完成=容器开关:不挂 show-done 时已完成事件直接 display:none(数据常驻,防 FC 重排抖动) */
.cal-fc.fc:not(.show-done) .fc-event.todo-done-strike { display: none; }
/* 未完成淡化改容器级:settings 开关不再重建 events(防 FC 重排抖动,同 blur) */
.cal-fc.fc.dim .fc-event:not(.todo-done-strike) { filter: grayscale(1); opacity: .45; }
/* 模糊日程:容器级滤镜(开关不再触发 FC 重排,见 CalendarView events classNames 注释) */
.cal-fc.blur .fc-event, .cal-tb.blur .fc-event, .cal-tb.blur .tl-seg, .todo-privacy { filter: blur(3px); }
/* 事件标题超长时省略号截断，不溢出格子；单格放不下由 dayMaxEvents 折叠进 +N more */
.cal-fc.fc .fc-event-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-fc.fc .fc-daygrid-event { max-width: 100%; }
.cal-fc.fc .fc-daygrid-event-harness { pointer-events: auto; }
/* "+N more" 弹层：贴应用风格（圆角+阴影），关闭按钮可点 */
.cal-fc.fc .fc-more-popover { border: none; border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); overflow: hidden; }
.cal-fc.fc .fc-more-popover .fc-popover-header { background: var(--gray-bg, #f5f7f7); padding: var(--space-2) 10px; font-size: var(--fs-sm); color: var(--text-2); }
.cal-fc.fc .fc-more-popover .fc-popover-close { cursor: pointer; opacity: .6; font-size: var(--fs-md); }
.cal-fc.fc .fc-more-popover .fc-popover-close:hover { opacity: 1; }
.cal-fc.fc .fc-more-popover .fc-popover-body { padding: var(--space-2) 10px; min-width: 160px; }
.cal-fc.fc .fc-more-popover .fc-daygrid-event { margin: 3px 0; }
/* 自绘 "+N more" 弹层（替代 FC 内置弹层，根除 offsetParent 崩溃） */
.cal-fc { position: relative; }
.cal-more-pop {
  position: absolute; z-index: var(--z-pop-top); width: 220px;
  background: var(--panel, #fff); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.cal-more-pop__head {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--gray-bg, #f5f7f7); padding: var(--space-2) 10px; font-size: var(--fs-sm); color: var(--text-2);
}
.cal-more-pop__x { cursor: pointer; color: var(--text-3); font-size: var(--fs-sm); }
.cal-more-pop__x:hover { color: var(--text-1); }
.cal-more-pop__body { padding: 6px 8px; max-height: 200px; overflow-y: auto; }
.cal-more-pop__item {
  border-radius: var(--radius-sm); color: #fff; font-size: var(--fs-xs); padding: 3px 7px;
  margin: 3px 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cal-more-pop__item:hover { filter: brightness(.92); }
/* 工具栏单行化：窄容器不再把开关挤到第二行(会被误读为弹层)，间距压缩保证 ~490px 下单行 */
.cal-toolbar { flex-wrap: nowrap; gap: 6px; white-space: nowrap; }
.cal-toolbar .chk { white-space: nowrap; }
/* 跨月淡显(a11y):FC 自身的 other-month 灰 #c2c2c2/#d3d5d7 对比度 1.5 不达标,压到 text-3
   须连 FC 挂色的宿主 A.fc-daygrid-day-number 一起压(axe 对比度按该宿主编造,只改内层不认账) */
.cal-fc.fc .fc-day-other .fc-daygrid-day-number,
.cal-fc.fc .fc-day-other .todo-daycell b,
.cal-fc.fc .fc-day-other .todo-week,
.cal-fc.fc .fc-day-other .todo-lunar { color: var(--text-3, #6d7278); }
/* FC 自身把 other-month 的日期头压到 opacity .3(渲染合成后≈#d3d5d7,1.47:1)——颜色调多深都会被
   这层透明度糊掉,必须摘掉透明度、淡显只交给上面的灰阶颜色承担 */
.cal-fc.fc .fc-day-other .fc-daygrid-day-top { opacity: 1; }
/* 今天格奶油底(#fffadf)上的品牌数字改用可读变体 */
.cal-fc.fc .fc-day-today .todo-daycell b { color: var(--brand-text, #0a6f62); }
/* 静态数字禁颜色过渡:否则 axe 采样会撞上 .3s 过渡中间帧(测得假低对比) */
.cal-fc.fc .todo-daycell b,
.cal-fc.fc .todo-daycell .todo-week,
.cal-fc.fc .todo-daycell .todo-lunar { transition: none; }
/* FullCalendar */
html[data-theme="dark"] .cal-fc {
  --fc-page-bg-color: var(--panel);
  --fc-border-color: var(--line);
}
</style>
