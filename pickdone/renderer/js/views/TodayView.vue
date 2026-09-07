<template>

  <div class="pd-view-page today-v1">
    <div class="today-body">
      <day-rail/>
      <div class="today-main">
        <!-- Option A (user-finalized): view switch folded into the right end of the date strip, saving a separate toolbar row -->
        <day-date-strip>
          <template #append>
            <div class="pd-view-seg" role="group" :aria-label="$t('statsE.TodayView.segLabel')">
              <button :class="{on: viewMode==='list'}" :title="$t('statsE.TodayView.listView')" :aria-label="$t('statsE.TodayView.listView')" :aria-pressed="viewMode==='list' ? 'true' : 'false'" @click="viewMode='list'"><pd-app-icon name="list" :size="14"/></button>
              <button :class="{on: viewMode==='matrix'}" :title="$t('statsE.TodayView.matrixView')" :aria-label="$t('statsE.TodayView.matrixView')" :aria-pressed="viewMode==='matrix' ? 'true' : 'false'" @click="viewMode='matrix'"><pd-app-icon name="matrix" :size="14"/></button>
              <button :class="{on: viewMode==='deck'}" :title="$t('statsE.TodayView.deckView')" :aria-label="$t('statsE.TodayView.deckView')" :aria-pressed="viewMode==='deck' ? 'true' : 'false'" @click="viewMode='deck'"><pd-app-icon name="copy" :size="14"/></button>
              <button v-if="settings.developerMode && settings.showDepsModule" :class="{on: viewMode==='deps'}" :title="$t('statsE.TodayView.depsView')" :aria-label="$t('statsE.TodayView.depsView')" :aria-pressed="viewMode==='deps' ? 'true' : 'false'" @click="viewMode='deps'"><pd-app-icon name="link" :size="14"/></button>
            </div>
          </template>
        </day-date-strip>
        <!-- The timeline is shared by all three today-page views: planning context stays coherent across list/matrix/deck (finalized by user 2026-08-31) -->
        <div v-if="viewMode==='deps' && settings.developerMode && settings.showDepsModule" class="today-list"><pd-dep-view/></div>
        <div v-else-if="viewMode==='matrix'" class="today-list"><pd-matrix-grid :tasks="matrixTasks"/></div>
        <div v-else-if="viewMode==='deck'" class="today-list"><pd-day-deck/></div>
        <div v-else class="today-list"><todo-groups :groups="groups" :empty-text="$t('statsE.TodayView.emptyDay')"/></div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { FMT } from '../utils/core.js'
import { maybeRunTour } from '../utils/onboardingTours.js'
/** Today's todos —— expired uncompleted (collapsed groups by date) + today + completed today.
 *  The former "recent todos" page was removed (finalized by user on 2026-08-29): expired tasks roll into this page as a hierarchy,
 *  the "roll to today?" prompt logic stays unchanged — choosing "no" keeps the original date, still visible in this page's expired group. */
import TodoGroups from '../components/TodoGroups.vue'
import DayDateStrip from '../components/DayDateStrip.vue'
import MatrixGrid from '../components/MatrixGrid.vue'
import DayDeck from '../components/DayDeck.vue'
import DepView from '../components/DepView.vue'
import DayRail from '../components/DayRail.vue'

export default {
  name: 'TodayView',
  components: { TodoGroups, DayDateStrip, PdMatrixGrid: MatrixGrid, PdDayDeck: DayDeck, PdDepView: DepView, DayRail },
  data () {
    // View selection persistence: keep the last used view across refresh/restart (fall back to list on missing/invalid value)
    let saved = null
    try { saved = localStorage.getItem('todayViewMode') } catch {}
    const mode = ['list', 'matrix', 'deck', 'deps'].includes(saved) ? saved : (this.$route.query.matrix ? 'matrix' : 'list')
    // 实验开关关闭时,残留的 deps 视图偏好回落到列表视图
    return { viewMode: mode }
  },
  mounted () {
    // Selected date goes into route query: preserve state across refresh/back-forward
    const q = this.$route.query.date
    if (q) {
      const ts = +window.dayjs(String(q)).startOf('day')
      if (!isNaN(ts)) this.$store.commit('ui/setDaySelected', ts)
    }
    // First entry to the today page: spotlight mini tour (shown once; can be replayed from the settings page)
    maybeRunTour('today', 1500)
  },
  methods: {
  },
  watch: {
    viewMode (m) { try { localStorage.setItem('todayViewMode', m) } catch {} },
    // The date param changing under the same route (browser back/forward, external navigation) must also sync the selected day — previously read only once in mounted
    '$route.query.date' (q) {
      if (!q) { this.$store.commit('ui/setDaySelected', 0); return }
      const ts = +window.dayjs(String(q)).startOf('day')
      if (!isNaN(ts)) this.$store.commit('ui/setDaySelected', ts)
    },
    '$store.state.ui.daySelectedTs' (ts) {
      const want = ts && ts !== +window.dayjs().startOf('day') ? window.dayjs(ts).format(FMT.date) : undefined
      const cur = this.$route.query.date
      if (want !== cur) this.$router.replace({ query: { ...this.$route.query, ...(want ? { date: want } : { date: undefined }) } }).catch(() => {})
    }
  },
  computed: {
    matrixTasks () {
      return this.groups.flatMap(g => g.todos)
    },
    v () { return this.$store.state.todo.views },
    settings () { return this.$store.state.settings },
    groups () {
      const g = []
      const dayjs = window.dayjs
      const sel = this.$store.state.ui.daySelectedTs || dayjs().startOf('day').valueOf()
      const isToday = sel === dayjs().startOf('day').valueOf()
      if (!isToday) {
        // Project baseline behavior: selecting another date in today view -> show that day's tasks
        const all = this.$store.state.todo.todoList.filter(t => !t.delete && t.dayStart === sel)
        const undone = all.filter(t => !t.complete)
        const done = all.filter(t => t.complete)
        const lbl = sel === +dayjs().add(1, 'day').startOf('day') ? this.$t('statsA.core.tomorrow')
          : (sel === +dayjs().subtract(1, 'day').startOf('day') ? this.$t('statsA.core.yesterday')
             : dayjs(sel).format(FMT.cnDate))
        // Empty days don't render a 0-count empty header (users found it odd): with nothing uncompleted, fall straight to the empty-state copy "nothing scheduled for this day"
        if (undone.length) g.push({ key: 'day-sel', label: lbl, weekOf: sel, brand: true, todos: undone, count: undone.length })
        // Completed group always present (collapsed by default, finalized by user on 2026-08-30: a hide toggle adds mental burden)
        if (done.length) g.push({ key: 'day-done', label: this.$t('statsE.SearchView.statusCompleted'), todos: done, count: done.length })
        return g
      }
      // Expired uncompleted: output collapsed groups in descending date order (yesterday/2 days ago/earlier...), replacing the standalone "recent todos" page
      const expired = (this.v.recent && this.v.recent.expiredUncompleted) || []
      const byDate = new Map()
      for (const t of expired) {
        const k = t.dayStart
        if (!byDate.has(k)) byDate.set(k, [])
        byDate.get(k).push(t)
      }
      // Weekday names via statsA.core.wd0~6 (dayjs.day(): Sunday=0)
      const expiredDays = [...byDate.keys()].sort((a, b) => b - a)
      for (const k of expiredDays) {
        const d = dayjs(Number(k))
        const lbl = +d === +dayjs().subtract(1, 'day').startOf('day')
          ? this.$t('statsE.TodayView.overdueFromYesterday')
          : this.$t('statsA.core.calMd', { m: d.month() + 1, d: d.date(), w: this.$t('statsA.core.weekOf', { w: this.$t('statsA.core.wd' + d.day()) }) })
        const todos = byDate.get(k)
        g.push({ key: 'expired-' + k, label: lbl, todos, count: todos.length })
      }

      const done = this.v.todayDoneList || []
      const undone = this.v.todayTodoList.filter(t => !t.complete)
      g.push({ key: 'today-today', label: this.$t('statsA.core.today'), weekOf: dayjs().valueOf(), brand: true, todos: undone, count: undone.length })
      // Completed group always present (collapsed by default, finalized by user on 2026-08-30: a hide toggle adds mental burden)
      if (done.length) {
        g.push({ key: 'today-done', label: this.$t('statsE.TodayView.completedToday'), todos: done, count: done.length })
      }
      return g
    }
  },

}
</script>
