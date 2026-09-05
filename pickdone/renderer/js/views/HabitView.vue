<template>

  <div class="page habit-page">
    <div class="page__header page__header--no-shadow">
      <div class="title">
        <div class="title__prepend"><div class="title__text">{{ $t('statsB.HabitView.title') }}</div></div>
        <div class="title__append"></div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">

      <!-- Create habit (with frequency selection) -->
      <div class="habit-add">
        <input v-model="newHabit" class="habit-add-input" :placeholder="$t('statsB.HabitView.habitPlaceholder')"
               :aria-label="$t('statsB.HabitView.habitAria')" @keydown.enter="addHabit"/>
        <select v-model="freqType" class="habit-add-input habit-freq-select" :aria-label="$t('statsP.HabitView.freqAria')">
          <option value="daily">{{ $t('statsB.HabitView.freqDaily') }}</option>
          <option value="weekdays">{{ $t('statsB.HabitView.freqWeekdays') }}</option>
          <option value="interval">{{ $t('statsB.HabitView.freqInterval') }}</option>
        </select>
        <span v-if="freqType==='weekdays'" class="habit-weekday-picker">
          <label v-for="(w,i) in WD" :key="i" class="habit-wd" :class="{on: freqWeekdays.includes(i)}"
                 @click="freqWeekdays.includes(i) ? freqWeekdays=freqWeekdays.filter(x=>x!==i) : freqWeekdays.push(i)">{{ w }}</label>
        </span>
        <span v-if="freqType==='interval'" class="habit-interval">{{ $t('statsB.HabitView.everyN') }}
          <input v-model.number="freqIntervalN" type="number" min="2" max="30" class="habit-interval-n"/>
        </span>
        <button class="mini primary" @click="addHabit">{{ $t('statsB.HabitView.create') }}</button>
      </div>

      <div v-if="!habits.length" class="empty">
        <div class="empty__icon"></div>
        <div class="empty__text">{{ $t('statsB.HabitView.empty') }}</div>
      </div>

      <!-- Habit cards -->
      <div v-for="h in habits" :key="h.id" class="habit-card">
        <div class="habit-card__head">
          <span v-if="isDueToday(h)" class="habit-check" role="checkbox" tabindex="0"
                :aria-checked="h.records && h.records[todayKey] ? 'true' : 'false'"
                :class="{ on: h.records && h.records[todayKey] }"
                :style="h.records && h.records[todayKey] ? { background: h.color, borderColor: h.color } : {}"
                @click="check(h)" @keydown.enter.prevent="check(h)">✓</span>
          <template v-if="editingId === h.id">
            <input v-model="editName" class="habit-rename" @keyup.enter="saveRename(h)" @blur="saveRename(h)"/>
          </template>
          <template v-else>
            <span class="habit-name">{{ h.name }}</span>
          </template>
          <span class="habit-freq-label">{{ freqLabel(h) }}</span>
          <span class="habit-streak" :title="$t('statsB.HabitView.streakTip')"><app-icon name="flame" :size="12"/> {{ $t('statsB.HabitView.streak', { n: streakOf(h.id) }) }}</span>
          <button class="mini danger habit-del" @click.stop="delHabitConfirm(h)">{{ $t('statsB.HabitView.del') }}</button>
        </div>
        <div class="habit-grid" aria-hidden="true">
          <i v-for="d in last30(h.id)" :key="d.key" class="habit-grid__cell" :class="{ on: d.on }"
             :style="d.on ? { background: h.color } : {}" :title="d.key + (d.on ? ' ✓' : '')"></i>
        </div>
      </div>

      <!-- Monthly check-in calendar -->
      <div class="habit-cal-sec">
        <div class="habit-cal-nav">
          <button class="mini" @click="calOffset--">‹</button>
          <span class="habit-cal-label">{{ calLabel }}</span>
          <button class="mini" @click="calOffset++">›</button>
        </div>
        <div class="habit-cal-grid">
          <span v-for="w in WD" :key="w" class="habit-cal-wd">{{ w }}</span>
          <span v-for="(d,i) in calDays" :key="i" class="habit-cal-day"
                :class="{ out: !d.inMonth, today: d.isToday,
                          checked: monthChecks[d.key] > 0,
                          due: habits.some(h => isDueOn(h, d.key)) && d.inMonth }">
            {{ d.dom }}
            <i v-if="monthChecks[d.key]" class="habit-cal-dot"></i>
          </span>
        </div>
        <div class="habit-cal-legend">
          <span><i class="dot" style="background:var(--brand)"></i>{{ $t('statsP.HabitView.legendChecked') }}</span>
          <span><i class="dot" style="background:var(--gray-bg);border:1px solid var(--line)"></i>{{ $t('statsP.HabitView.legendUnchecked') }}</span>
        </div>
      </div>

      <!-- Countdown/anniversary moments -->
      <div class="moment-sec">
        <div class="habit-add moment-add">
          <span class="moment-sec-title">{{ $t('statsB.HabitView.momentTitle') }}</span>
          <input v-model="newMoment" class="habit-add-input" :placeholder="$t('statsB.HabitView.momentNamePlaceholder')" :aria-label="$t('statsB.HabitView.momentNameAria')"/>
          <input v-model="newMomentDate" type="date" class="habit-add-input" :aria-label="$t('statsB.HabitView.dateAria')"/>
          <select v-model="newMomentKind" class="habit-add-input" :aria-label="$t('statsB.HabitView.kindAria')">
            <option value="countdown">{{ $t('statsB.HabitView.countdown') }}</option>
            <option value="memorial">{{ $t('statsB.HabitView.memorial') }}</option>
          </select>
          <button class="mini primary" @click="addMoment">{{ $t('statsB.HabitView.add') }}</button>
        </div>
        <div v-if="moments.length" class="moment-list">
          <div v-for="m in moments" :key="m.id" class="moment-item">
            <span class="moment-name">{{ m.name }}</span>
            <span class="moment-date">{{ m.date }}</span>
            <span class="moment-days" :class="m.kind">{{ daysText(m) }}</span>
            <button class="mini danger" @click="delMomentConfirm(m)">{{ $t('statsB.HabitView.del') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Habit tracking + countdown/anniversary page (route todo-list-habit)
 *  1. Today's habit check-ins (frequency filter: daily / specific weekdays / every N days)
 *  2. Monthly calendar check-in table (switch months, colored coverage)
 *  3. Countdown/anniversary moments */
import { dayjs, FMT } from '../utils/core.js'
import { showUndoToast } from '../utils/undoToast.js'

// Monday-first weekday keys (labels via statsP.HabitView.wd1..wd7)
const WD_KEYS = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7']

export default {
  name: 'HabitView',
  data () {
    return {
      newHabit: '', editingId: null, editName: '',
      // Frequency for new habits
      freqType: 'daily', freqWeekdays: [0, 1, 2, 3, 4], freqIntervalN: 2,
      // Month calendar
      calOffset: 0, // 0 = this month, -1 = last month...
      newMoment: '', newMomentDate: '', newMomentKind: 'countdown'
    }
  },
  computed: {
    /** Monday-first weekday labels (Monday-first) */
    WD () { return WD_KEYS.map(k => this.$t('statsP.HabitView.' + k)) },
    habits () { return this.$store.state.habits.habits },
    moments () { return this.$store.state.habits.moments },
    todayKey () { return dayjs().format(FMT.date) },
    /** Start date of the current calendar month (Monday) */
    calMonth () { return dayjs().startOf('month').add(this.calOffset, 'month') },
    calLabel () { return this.$t('statsP.HabitView.calLabel', { y: this.calMonth.year(), m: this.calMonth.month() + 1 }) },
    /** Calendar cells: 42 cells (6 rows x 7 columns), Monday-first */
    calDays () {
      const first = this.calMonth.startOf('month')
              const offset = (first.day() + 6) % 7 // Monday=0
      const gridStart = first.subtract(offset, 'day')
      return Array.from({ length: 42 }, (_, i) => {
        const d = gridStart.add(i, 'day')
        const key = d.format(FMT.date)
        return { key, dom: d.date(), inMonth: d.month() === this.calMonth.month(), isToday: key === this.todayKey }
      })
    },
    /** Which days of the current month have check-ins */
    monthChecks () {
      const map = {}
      for (const h of this.habits) {
        for (const k of Object.keys(h.records || {})) {
          if (k.startsWith(this.calMonth.format('YYYY-MM'))) map[k] = (map[k] || 0) + 1
        }
      }
      return map
    }
  },
  methods: {
    streakOf (id) { return this.$store.getters['habits/streakOf'](id) },
    last30 (id) { return this.$store.getters['habits/last30'](id) },
    isDueToday (h) { return this.$store.getters['habits/isDue'](h.id, this.todayKey) },
    isDueOn (h, dateKey) { return this.$store.getters['habits/isDue'](h.id, dateKey) },
    freqLabel (h) {
      const f = h.frequency || { type: 'daily' }
      if (f.type === 'daily') return this.$t('statsB.HabitView.freqDaily')
      if (f.type === 'weekdays') return (f.weekdays || []).map(w => this.WD[w]).join(' ')
      return this.$t('statsB.HabitView.freqEveryN', { n: f.intervalN || 1 })
    },
    addHabit () {
      const n = this.newHabit.trim()
      if (!n) return
      const freq: any = { type: this.freqType }
      if (this.freqType === 'weekdays') freq.weekdays = this.freqWeekdays
      if (this.freqType === 'interval') freq.intervalN = this.freqIntervalN
      this.$store.commit('habits/addHabit', { name: n, frequency: freq })
      this.newHabit = ''
    },
    startRename (h) { this.editingId = h.id; this.editName = h.name },
    saveRename (h) {
      const n = this.editName.trim()
      if (n) this.$store.commit('habits/renameHabit', { id: h.id, name: n })
      this.editingId = null
    },
    // Check-in is a one-click explicit toggle on data: same undo layer as task completion (silent before; consolidated 2026-09-01)
    check (h) {
      const was = !!(h.records || {})[this.todayKey]
      this.$store.commit('habits/toggleCheck', { id: h.id, day: this.todayKey })
      showUndoToast(this.$message.bind(this), [
        this.$t(was ? 'statsB.HabitView.uncheckedToast' : 'statsB.HabitView.checkedToast', { n: h.name }) + '　',
        window.Vue.h('a', {
          style: { color: 'var(--brand)', cursor: 'pointer' },
          onClick: () => { this.$store.commit('habits/toggleCheck', { id: h.id, day: this.todayKey }); this.$message.closeAll() }
        }, this.$t('statsA.core.undo'))
      ])
    },
    prevMonth () { this.calOffset-- },
    nextMonth () { this.calOffset++ },
    async delHabitConfirm (h) {
      try { await this.$confirm(this.$t('statsB.HabitView.delConfirm', { name: h.name }), this.$t('statsB.HabitView.delTitle'), { type: 'warning' }) } catch { return }
      this.$store.commit('habits/delHabit', h.id)
    },
    async delMomentConfirm (m) {
      try { await this.$confirm(this.$t('statsB.HabitView.delMomentConfirm', { name: m.name }), this.$t('statsB.HabitView.delMomentTitle'), { type: 'warning' }) } catch { return }
      this.$store.commit('habits/delMoment', m.id)
    },
    addMoment () {
      if (!this.newMoment.trim() || !this.newMomentDate) return this.$message.warning(this.$t('statsB.HabitView.nameAndDateRequired'))
      this.$store.commit('habits/addMoment', { name: this.newMoment.trim(), date: this.newMomentDate, kind: this.newMomentKind })
      this.newMoment = ''; this.newMomentDate = ''
    },
    daysDiff (m) {
      const target = +dayjs(m.date).startOf('day')
      const today = +dayjs().startOf('day')
      return Math.round((target - today) / 86400000)
    },
    daysText (m) {
      const diff = this.daysDiff(m)
      if (diff < 0) return this.$t('statsB.HabitView.daysAgo', { n: Math.abs(diff) })
      if (diff === 0) return this.$t('statsB.HabitView.isToday')
      return m.kind === 'countdown'
        ? this.$t('statsB.HabitView.countdownLeft', { n: diff })
        : this.$t('statsB.HabitView.memorialKept', { n: diff })
    }
  },

}
</script>
