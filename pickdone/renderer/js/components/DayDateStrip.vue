<template>

  <div class="day-strip">
    <button class="ds-arrow" @click="shift(-1)">‹</button>
    <template v-for="d in days" :key="d.ts">
      <i v-if="d.newMonth" class="ds-mseam" aria-hidden="true"></i>
      <button class="ds-day" :class="{sel:d.isSel, today:d.isToday, dim:d.dim}" @click="pickDay(d.ts)">
        <span class="ds-num">{{ d.n }}<i v-if="d.isToday" class="ds-today-dot"></i></span>
        <span class="ds-wd">{{ d.wd }}</span>
      </button>
    </template>
    <button class="ds-arrow" @click="shift(1)">›</button>

    <!-- Date label: click to open the calendar (replaces the standalone 📅 button); "back to today" only appears when not today -->
    <span class="ds-label" :class="{on:showCal}" role="button" tabindex="0" :title="$t('statsD.DayDateStrip.selectDate')"
          aria-haspopup="dialog" :aria-expanded="showCal ? 'true' : 'false'"
          @click.stop="showCal=!showCal" @keydown.enter.prevent="showCal=!showCal"
          @mouseenter="calEnter" @mouseleave="calLeave">
      <app-icon name="calendar" :size="13"/>{{label}}
    </span>
    <!-- Locate today: persistent icon button, highlighted when the selected day = today, otherwise click to jump back — constant width, zero layout shift -->
    <button class="ds-today-ico" :class="{on:isToday}" :title="$t('statsD.DayDateStrip.backTodayTitle')"
            :aria-pressed="isToday ? 'true' : 'false'" @click="backToday">
      <app-icon name="locate" :size="14"/>
    </button>

    <!-- Right-side extension slot: in-page tools like the view switch mount here (Option A, user-finalized) -->
    <slot name="append"></slot>

    <!-- Calendar popover -->
    <transition name="fade">
      <div v-if="showCal" v-click-outside="() => showCal = false" class="ds-cal-pop" @click.stop
           @mouseenter="calEnter" @mouseleave="calLeave">
        <div class="ds-cal-head">
          <button @click="calNav(-12)" :title="$t('statsD.DayDateStrip.prevYear')" :aria-label="$t('statsD.DayDateStrip.prevYear')">«</button>
          <button @click="calNav(-1)" :title="$t('statsD.DayDateStrip.prevMonth')" :aria-label="$t('statsD.DayDateStrip.prevMonth')">‹</button>
          <b>{{ $t('statsD.DayDateStrip.calTitle', { y: calMonth.split('-')[0], m: Number(calMonth.split('-')[1]) }) }}</b>
          <button @click="calNav(1)" :title="$t('statsD.DayDateStrip.nextMonth')" :aria-label="$t('statsD.DayDateStrip.nextMonth')">›</button>
          <button @click="calNav(12)" :title="$t('statsD.DayDateStrip.nextYear')" :aria-label="$t('statsD.DayDateStrip.nextYear')">»</button>
        </div>
        <div class="ds-cal-grid">
          <i v-for="h in calWeekHeaders" :key="'h'+h" class="ds-cal-h">{{h}}</i>
          <button v-for="c in calCells" :key="c.key"
                  class="ds-cal-cell" :class="{out:!c.inMonth, today:c.isToday, sel:c.isSel}"
                  @click="pickDay(c.key)">
            <b>{{c.n}}</b>
            <i v-if="c.hasTasks" class="ds-cal-dot"></i>
          </button>
        </div>
      </div>
    </transition>
  </div>
</template>

<script lang="ts">
/**
 * Today-todo date quick-select strip -- alignment reference + calendar popover quick selection (green dot on days with tasks)
 * ‹ 25 26 27 [Today] 29 30 31 ›  📅  Aug 28, 2026 Today  ☀
 * 📅 Click to open the calendar popover: days with tasks show a green dot
 */
import { dayjs, DAY_MS } from '../utils/core.js'
import store from '../store/index.js'

// [component-fixes] pure-start (extracted verbatim by tests/component-fixes-renderer.test.mjs)
/** Leading-blank offset for a week-based grid honoring the week-start setting (Mon default / Sun optional) */
function calGridOffset (dayOfWeek, weekFromSun) { return weekFromSun ? dayOfWeek : (dayOfWeek + 6) % 7 }
/** Column order mapped to the wd0(Sun)..wd6(Sat) i18n keys for the chosen week start */
function weekHeaderOrder (weekFromSun) { return weekFromSun ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0] }
// [component-fixes] pure-end

export default {
  name: 'DayDateStrip',
  data () {
    return {
      showCal: false,
    calHover: false,
      calMonth: dayjs().format('YYYY-MM'),
      tick: 0
    }
  },
  computed: {
    selectedTs () { return this.$store.state.ui.daySelectedTs || this.today0 },
    today0 () { return this.$store.state.todo.todayTimestamp },
    isToday () { return this.selectedTs === this.today0 },
    days () {
      // Always show one calendar week (Monday start; Sunday selectable in Settings), ‹ › switches whole weeks
      const base = this.selectedTs
      const d = dayjs(base)
      const weekFromSun = this.$store.state.settings.weekStartDay === 'sun'
      const off = calGridOffset(d.day(), weekFromSun)
      const start = +d.subtract(off, 'day').startOf('day')
      // Map week start order to the wd0(Sun)..wd6(Sat) i18n keys
      const order = weekHeaderOrder(weekFromSun)
      return Array.from({ length: 7 }, (_, i) => {
        const ts = start + i * DAY_MS
        const dd = dayjs(ts)
        // Cross-month/cross-year weeks: mark newMonth when the cell's month differs from the previous one (renders a seam), mark dim when not in the selected month (faded)
        const prev = i > 0 ? dayjs(start + (i - 1) * DAY_MS) : null
        return {
          ts, n: dd.date(), wd: this.$t('statsD.DayDateStrip.wd' + order[i]),
          isSel: ts === base, isToday: ts === this.today0,
          newMonth: prev && dd.month() !== prev.month(),
          dim: dd.month() !== d.month()
        }
      })
    },
    label () {
      const d = dayjs(this.selectedTs)
      // Cross-year case (selected year ≠ current year) automatically includes the year, no suffix otherwise; "today" semantics are carried by the highlighted locate icon on the right, no longer by an appended suffix (constant width)
      const key = d.year() === dayjs().year() ? 'labelPattern' : 'labelPatternYear'
      return this.$t('statsD.DayDateStrip.' + key, { y: d.year(), m: d.month() + 1, d: d.date(), w: this.$t('statsD.DayDateStrip.wd' + d.day()) })
    },
    /** Month grid of the calendar popover (start weekday honors settings.weekStartDay, same as the date strip above) */
    calCells () {
      const first = dayjs(this.calMonth + '-01')
      const weekFromSun = this.$store.state.settings.weekStartDay === 'sun'
      const offset = calGridOffset(first.day(), weekFromSun)
      const cells = []
      for (let i = offset; i > 0; i--) cells.push(this.calCell(first.subtract(i, 'day'), false))
      for (let d = 1; d <= first.daysInMonth(); d++) cells.push(this.calCell(first.date(d), true))
      while (cells.length % 7) cells.push(this.calCell(dayjs(cells[cells.length - 1].key).add(1, 'day'), false))
      return cells
    },
    /** Set of dates that have tasks */
    taskDays () {
      const set = new Set()
      for (const t of this.$store.state.todo.todoList) {
        if (!t.delete && t.dayStart) set.add(t.dayStart)
      }
      return set
    },
    /** Calendar popover header (rotated to the same week start as calCells) */
    calWeekHeaders () {
      return weekHeaderOrder(this.$store.state.settings.weekStartDay === 'sun').map(i => this.$t('statsD.DayDateStrip.wd' + i))
    }
  },
  methods: {
    calCell (d, inMonth) {
      const ts = d.startOf('day').valueOf()
      return {
        key: ts, n: d.date(), inMonth,
        isToday: ts === this.today0,
        isSel: ts === this.selectedTs,
        hasTasks: this.taskDays.has(ts)
      }
    },
    pickDay (ts) {
      store.commit('ui/setDaySelected', ts)
      this.showCal = false
    },
    // Auto-collapse 1 second after the mouse leaves the button/popover, saving an extra click
    calEnter () { this.calHover = true; clearTimeout(this._calCloseTimer) },
    calLeave () {
      this.calHover = false
      clearTimeout(this._calCloseTimer)
      this._calCloseTimer = setTimeout(() => { if (!this.calHover) this.showCal = false }, 1000)
    },
    shift (dir) {
      store.commit('ui/setDaySelected', this.selectedTs + dir * 7 * DAY_MS)
    },
    backToday () { store.commit('ui/setDaySelected', this.today0) },
    calNav (dir) { this.calMonth = dayjs(this.calMonth + '-01').add(dir, 'month').format('YYYY-MM') },
  },
  beforeUnmount () {
    clearTimeout(this._calCloseTimer)
  },

}
</script>
<style>.ds-arrow { border: 0; background: none; color: var(--text-3); font-size: var(--fs-lg); padding: 0 2px; }
.ds-arrow:hover { color: var(--brand); }
.ds-day {
  min-width: 40px; height: 28px; border-radius: var(--radius-md); border: 0; background: none;
  font-size: var(--fs-base); color: var(--text-1); display: inline-flex; align-items: center; justify-content: center;
}
.ds-day:hover { background: var(--gray-bg); }
.ds-day.sel { background: var(--brand); color: #fff; font-weight: 600; box-shadow: 0 2px 8px rgba(15, 157, 143, .35); }
/* 思路A(用户定稿):单行紧凑——数字+周几横排,28px 与右端视图切换齐平,日期条从56px降到44px */
.ds-day { gap: var(--space-1); }
.ds-num { line-height: 1; display: inline-flex; align-items: center; font-variant-numeric: tabular-nums; }
.ds-wd { font-size: var(--fs-2xs); line-height: 1; color: var(--text-3); }
.ds-day.sel .ds-wd { color: rgba(255, 255, 255, .9); }
.ds-today-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--brand); margin-left: 3px; }
.ds-day.today:not(.sel) { color: var(--brand); font-weight: 600; }
.ds-day.today:not(.sel) .ds-wd { color: var(--brand); }
.ds-day.sel .ds-today-dot { background: #fff; }
/* 跨月/跨年周:月份边界 1px 分缝 + 非选中月整格淡显(与日历弹窗补位日变灰同一语言) */
.ds-mseam { width: 1px; height: 16px; background: var(--line, #e7e9ee); margin: 0 2px; flex-shrink: 0; }
.ds-day.dim:not(.sel) { opacity: 1; }
/* 跨月淡显改实色中灰(opacity .5 混合后对比度不达标,a11y axe color-contrast) */
.ds-day.dim:not(.sel) .ds-num, .ds-day.dim:not(.sel) .ds-week { color: var(--text-3); }
.ds-label {
  display: inline-flex; align-items: center; gap: var(--space-1); margin-left: var(--space-2);
  font-size: var(--fs-md); font-weight: 600; color: var(--text-1);
  padding: 4px 10px; border-radius: var(--radius-md); cursor: pointer; transition: all var(--dur-fast);
}
.ds-label:hover, .ds-label.on { background: var(--gray-bg); color: var(--brand); }
.ds-label svg { stroke: currentColor; }
.ds-label { cursor: pointer; }
/* 定位今天：常驻图标钮(28px 方,与日期格同高)——今天=品牌色高亮,非今天=灰、点击跳回;宽度恒定,布局零偏移 */
.ds-today-ico {
  width: 24px; height: 24px; align-self: center; margin-left: 2px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--radius-md); background: none; color: var(--text-3); cursor: pointer;
  transition: color var(--dur-fast), background-color var(--dur-fast);
}
.ds-today-ico:hover { color: var(--brand); background: var(--brand-light); }
.ds-today-ico.on { color: #fff; background: var(--brand); }
.ds-cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-2); }
.ds-cal-head button { border: 0; background: none; color: var(--text-3); font-size: var(--fs-base); cursor: pointer; padding: 2px 6px; }
.ds-cal-head b { font-size: var(--fs-md); color: var(--text-1); }
.ds-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.ds-cal-h { text-align: center; font-size: var(--fs-2xs); color: var(--text-3); padding: 2px 0; font-style: normal; }
.ds-cal-cell {
  position: relative; border: 0; background: none; border-radius: var(--radius-md); padding: 4px 0;
  font-size: var(--fs-sm); color: var(--text-1); cursor: pointer; text-align: center; min-height: 28px; font-variant-numeric: tabular-nums;
}
.ds-cal-cell:hover { background: var(--gray-bg); }
.ds-cal-cell.out { color: var(--text-4); }
.ds-cal-cell.today { border: 1px solid var(--brand); }
.ds-cal-cell.sel { background: var(--brand); color: #fff; }
.ds-cal-dot {
  position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%);
  width: 5px; height: 5px; border-radius: 50%; background: var(--brand);
}
</style>
