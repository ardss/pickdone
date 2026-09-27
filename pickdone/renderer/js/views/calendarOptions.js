/**
 * FullCalendar options builder for CalendarView (extracted verbatim from CalendarView.vue —
 * structure-size ratchet). `buildCalendarOptions(self)` receives the component instance (`self`
 * inside the old renderCalendar) and returns the exact same calOptions object.
 * Also hosts the locale-aware format helpers previously at CalendarView module level.
 */
import { dayjs, FMT } from '../utils/core.js'
import { getLocale } from '../i18n/index.js'
import { moveWithUndo } from '../utils/confirm.js'
import { today0, dayStart } from '../utils/todayBounds.js'

// Date formats follow the locale: FMT.cn* are Chinese format constants; English locale uses English formats, otherwise the toolbar mixes scripts
const EN = () => getLocale() === 'en-US'
export const fmtMonth = d => EN() ? d.format('MMMM YYYY') : d.format(FMT.cnMonth)
export const fmtDate = d => EN() ? d.format('MMM D') : d.format(FMT.cnDate)
export const fmtFull = d => EN() ? d.format('dddd, MMM D, YYYY') : d.format(FMT.cnFull)

// Weekday labels: shared at module level (wd0 = Sunday-first, aligned with dayjs.day())
export function wdLabel (t, d) { return t('statsJ.CalendarView.wd' + ((d + 6) % 7)) }
// Weekday labels (statsJ.CalendarView.wd0~wd6, Monday-first; dayjs.day() Sunday=0 -> shifted so Monday=0)
// Called via this in data/computed context — module top level has no this, so this._i18n is passed into the function;
// actual calls all go through the this.wd(d) method (in CalendarView), keeping Vue template compilation friendly.

export function buildCalendarOptions (self, initialDateTs) {
  return {
    // Grid language follows the app locale (FullCalendar defaults to English, so locale must be passed explicitly; locale packs are fully loaded via locales-all)
    locale: getLocale() === 'en-US' ? 'en' : 'zh-cn',
    // The page ships its own cal-toolbar (title/today/paging/view switch); FullCalendar's native header is not rendered to avoid double toolbars
    headerToolbar: false,
    // 不折叠(dayMaxEvents 默认 false):格子内滚动看全部(2026-09-04 用户定稿,弃 "+N"弹窗形式);
    // 高度封顶由 CSS .fc-daygrid-day-events 的 max-height+overflow-y 承担。moreLinkClick 留作防御。
    initialView: self.view,
    initialDate: initialDateTs || undefined,
    // On view/date change, refresh the "today" anchor visibility and the year-month panel selection (drives template re-render)
    datesSet (info) {
      const t = dayjs(today0())
      self.todayInView = !t.isBefore(dayjs(info.view.currentStart).startOf('day')) &&
                         !t.isAfter(dayjs(info.view.currentEnd).startOf('day'))
      // Reactive cursor: rangeText is a computed, but cal.getDate() is non-reactive — once computed, it's cached forever,
      // freezing the title after paging (a real regression, caught by the corrupted ui-smoke). Title/month panel are both driven from here.
      const d = dayjs(info.view.currentDate || info.view.currentStart)
      self.cursorTs = dayStart(d)
      self.selMonthTs = +d.startOf('month')
    },
    // "+N" -> 自绘日浮层(与格子右上角展开钮共用 openDayPeek)
    moreLinkClick (info) {
      self.openDayPeek(dayStart(info.date), info.dayEl)
      return false
    },
    // Drag to reschedule (interaction plugin); only changing the start date is allowed, not stretching the span
    editable: true,
    eventDurationEditable: false,
    eventDrop (info) {
      self._droppedAt = Date.now()
      const ts = dayStart(info.event.start)
      if (self._dragInfo && ts !== self._dragInfo.origTs) {
        const origTs = self._dragInfo.origTs
        // Same semantics as list/card drag: moveWithUndo provides the unified "moved to X + undo"
        moveWithUndo(self, {
          label: self.$t('statsJ.TodoItem.movedTo', { d: dayjs(ts).format(FMT.cnDate) }),
          apply: () => self.$store.dispatch('todo/updateTodoFields', { taskId: info.event.id, patch: { todoTime: ts } }),
          revert: () => {
            const raw = self.taskById.get(info.event.id)
            if (raw) self.$store.dispatch('todo/updateTodoFields', { taskId: info.event.id, patch: { todoTime: origTs } })
          }
        })
      }
    },
    eventDragStart (info) {
      self._dragInfo = { taskId: info.event.id, origTs: dayStart(info.event.start) }
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
        const t = self.taskById.get(self._dragInfo.taskId)
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
          const raw = self.taskById.get(info.event.id)
          if (raw) self.$store.commit('ui/openEdit', raw)
        }
      })
    },
    eventClick (info) {
      info.jsEvent.preventDefault()
      const raw = self.taskById.get(info.event.id)
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
}
