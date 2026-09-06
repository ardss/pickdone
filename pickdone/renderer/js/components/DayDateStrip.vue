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
          <button @click="calNav(-12)" :title="$t('statsD.DayDateStrip.prevYear')">«</button>
          <button @click="calNav(-1)">‹</button>
          <b>{{ $t('statsD.DayDateStrip.calTitle', { y: calMonth.split('-')[0], m: Number(calMonth.split('-')[1]) }) }}</b>
          <button @click="calNav(1)">›</button>
          <button @click="calNav(12)" :title="$t('statsD.DayDateStrip.nextYear')">»</button>
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
      const off = weekFromSun ? d.day() : (d.day() + 6) % 7
      const start = +d.subtract(off, 'day').startOf('day')
      // Map week start order to the wd0(Sun)..wd6(Sat) i18n keys
      const order = weekFromSun ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0]
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
    /** Month grid of the calendar popover */
    calCells () {
      const first = dayjs(this.calMonth + '-01')
      const offset = (first.day() + 6) % 7 // Monday start
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
    /** Calendar popover header (Mon..Sun) */
    calWeekHeaders () {
      return [1, 2, 3, 4, 5, 6, 0].map(i => this.$t('statsD.DayDateStrip.wd' + i))
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
