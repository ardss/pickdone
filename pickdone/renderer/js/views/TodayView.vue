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
            <!-- Project filter (today-page project association): compact dropdown in the same TodoBox dropdown-select language,
                 mounted at the right end of the date strip so the existing toolbar structure stays untouched.
                 Gated on the projects module switch (nav-gate authority: projects ride on their own switch alone) -->
            <div v-if="settings.showProjectsModule && projects.length" class="dropdown-select pd-proj-filter" :class="{ 'is-open': openDd === 'proj' }">
              <el-popover placement="bottom-end" width="180" trigger="click" :hide-after="0" popper-class="dd-pop" @show="openDd = 'proj'" @hide="openDd = null">
                <ul class="dd-menu">
                  <li :class="{ on: !projFilter }" tabindex="0" @click="setProjFilter(0)" @keydown.enter.prevent="setProjFilter(0)">{{ $t('todayT.filterAll') }}</li>
                  <li v-for="p in projects" :key="p.categoryId" tabindex="0"
                      :class="{ on: p.categoryId === projFilter }" @click="setProjFilter(p.categoryId)" @keydown.enter.prevent="setProjFilter(p.categoryId)">
                    <i class="pd-proj-opt-dot" :style="{ background: p.categoryColor }" aria-hidden="true"></i>{{ p.categoryName }}
                  </li>
                </ul>
                <template #reference>
                  <span class="dropdown-select__label" role="button" tabindex="0"
                        :title="$t('todayT.filterLabel')" :aria-label="$t('todayT.filterLabel')" aria-haspopup="menu"
                        @keydown.enter.prevent="projTriggerKey"><span class="pd-proj-cur">{{ projFilterLabel }}</span><i class="dd-caret">&#9662;</i></span>
                </template>
              </el-popover>
            </div>
          </template>
        </day-date-strip>
        <!-- The timeline is shared by all three today-page views: planning context stays coherent across list/matrix/deck (finalized by user 2026-08-31) -->
        <div v-if="viewMode==='deps' && settings.developerMode && settings.showDepsModule" class="today-list"><pd-dep-view/></div>
        <div v-else-if="viewMode==='matrix'" class="today-list"><pd-matrix-grid :tasks="matrixTasks"/></div>
        <div v-else-if="viewMode==='deck'" class="today-list"><pd-day-deck :tasks="deckTasks"/></div>
        <div v-else class="today-list"><todo-groups :groups="groups" :empty-text="emptyText" :project-badge="!!settings.showProjectsModule"/></div>
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

// [navgate-fix] pure-start (extracted by tests/unit-navgate-fix-ui.test.mjs)
/** Restore the persisted today view mode: unknown/missing values fall back (matrix deep link
 *  honored), and a residual 'deps' preference must not resurrect a gated-off view — with
 *  developerMode/showDepsModule off the segment button is hidden, which would leave the
 *  switch without any active state, so 'deps' falls back to 'list' */
function pickViewMode (saved, wantsMatrix, depsAllowed) {
  const mode = ['list', 'matrix', 'deck', 'deps'].includes(saved) ? saved : (wantsMatrix ? 'matrix' : 'list')
  return mode === 'deps' && !depsAllowed ? 'list' : mode
}
// [navgate-fix] pure-end

export default {
  name: 'TodayView',
  components: { TodoGroups, DayDateStrip, PdMatrixGrid: MatrixGrid, PdDayDeck: DayDeck, PdDepView: DepView, DayRail },
  data () {
    // View selection persistence: keep the last used view across refresh/restart (fall back to list on missing/invalid value)
    let saved = null
    try { saved = localStorage.getItem('todayViewMode') } catch {}
    const s = this.$store.state.settings
    const mode = pickViewMode(saved, !!this.$route.query.matrix, !!(s.developerMode && s.showDepsModule))
    // projFilter: project categoryId the today list is filtered by (0 = All); openDd: which toolbar dropdown is open
    return { viewMode: mode, projFilter: 0, openDd: null }
  },
  mounted () {
    // Selected date goes into route query: preserve state across refresh/back-forward
    const q = this.$route.query.date
    if (q) {
      const ts = +window.dayjs(String(q)).startOf('day')
      if (!isNaN(ts)) this.$store.commit('ui/setDaySelected', ts)
    }
    // Project deep link: #/todo-list/today?project=<categoryId> opens today pre-filtered (project view -> today linking)
    this.syncProjFromRoute(this.$route.query.project)
    // First entry to the today page: spotlight mini tour (shown once; can be replayed from the settings page)
    maybeRunTour('today', 1500)
  },
  methods: {
    /** Route query -> filter state. Accepts a project categoryId; unknown ids fall back to All and the
     *  stale param is stripped from the URL. The byId fallback covers cold-start deep links, where category
     *  rows are already in memory (synchronous state init) while the project flags still load asynchronously.
     *  With the projects module off the filter is inert too (no dropdown to clear it otherwise). */
    syncProjFromRoute (v) {
      const id = Number(v) || 0
      const valid = !!(id && this.settings.showProjectsModule && (this.projects.some(p => p.categoryId === id) || this.$store.getters['category/byId'](id)))
      const next = valid ? id : 0
      if (next !== this.projFilter) this.projFilter = next
      if (v != null && !valid) {
        this.$router.replace({ query: { ...this.$route.query, project: undefined } }).catch(() => {})
      }
    },
    /** Filter dropdown -> state (0 = All); the projFilter watcher mirrors the choice back into the route query */
    setProjFilter (id) { this.projFilter = id || 0 },
    /** Client-side project filter applied to every today group (expired / selected day / today / completed) */
    fitProj (list) {
      return this.projFilter ? list.filter(t => t.categoryId === this.projFilter) : list
    },
    projTriggerKey (e) { (e.currentTarget as HTMLElement).click() },
  },
  watch: {
    viewMode (m) { try { localStorage.setItem('todayViewMode', m) } catch {} },
    // The date param changing under the same route (browser back/forward, external navigation) must also sync the selected day — previously read only once in mounted
    '$route.query.date' (q) {
      if (!q) { this.$store.commit('ui/setDaySelected', 0); return }
      const ts = +window.dayjs(String(q)).startOf('day')
      if (!isNaN(ts)) this.$store.commit('ui/setDaySelected', ts)
    },
    // Bidirectional linking (project view -> today): ?project=<categoryId> applies the filter, arriving without it resets to All
    '$route.query.project' (v) { this.syncProjFromRoute(v) },
    // Filter -> route: keep the URL shareable (date param preserved), matching the date query pattern above
    projFilter (v) {
      const want = v ? String(v) : undefined
      if (want !== this.$route.query.project) {
        this.$router.replace({ query: { ...this.$route.query, ...(want ? { project: want } : { project: undefined }) } }).catch(() => {})
      }
    },
    // Re-validate once the async project flags finish loading (cold-start deep link) or when a project is unflagged/deleted
    projects () {
      if (this.projFilter && !this.projects.some(p => p.categoryId === this.projFilter)) this.projFilter = 0
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
    deckTasks () {
      // The card view buckets across the ±7d window, so it needs the full non-deleted list with the
      // project filter applied; DayDeck still applies its own delete/dayStart filters internally
      return this.fitProj(this.$store.state.todo.todoList)
    },
    v () { return this.$store.state.todo.views },
    settings () { return this.$store.state.settings },
    // Project-type categories (flagged via category/projectIds) — drives both the toolbar filter and the row badges
    projects () { return this.$store.getters['category/projects'] || [] },
    projFilterLabel () {
      if (!this.projFilter) return this.$t('todayT.filterAll')
      const p = this.projects.find(x => x.categoryId === this.projFilter)
      return p ? p.categoryName : this.$t('todayT.filterAll')
    },
    emptyText () {
      // With a project filter active the generic "nothing scheduled" copy would mislead — use a filter-specific message
      return this.projFilter ? this.$t('todayT.emptyFiltered') : this.$t('statsE.TodayView.emptyDay')
    },
    groups () {
      const g = []
      const dayjs = window.dayjs
      const sel = this.$store.state.ui.daySelectedTs || dayjs().startOf('day').valueOf()
      const isToday = sel === dayjs().startOf('day').valueOf()
      if (!isToday) {
        // Project baseline behavior: selecting another date in today view -> show that day's tasks
        const all = this.fitProj(this.$store.state.todo.todoList.filter(t => !t.delete && t.dayStart === sel))
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
      const expired = this.fitProj((this.v.recent && this.v.recent.expiredUncompleted) || [])
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

      const done = this.fitProj(this.v.todayDoneList || [])
      const undone = this.fitProj(this.v.todayTodoList.filter(t => !t.complete))
      // Same avoidance as the selected-day branch above: an all-empty today must not render a
      // 0-count "Today" header next to the empty-state illustration
      if (undone.length) {
        g.push({ key: 'today-today', label: this.$t('statsA.core.today'), weekOf: dayjs().valueOf(), brand: true, todos: undone, count: undone.length })
      }
      // Completed group always present (collapsed by default, finalized by user on 2026-08-30: a hide toggle adds mental burden)
      if (done.length) {
        g.push({ key: 'today-done', label: this.$t('statsE.TodayView.completedToday'), todos: done, count: done.length })
      }
      return g
    }
  },

}
</script>
<style>
/* ===== Project filter in the day-strip append slot (today-page project association) =====
   The .dropdown-select / .dd-menu / .dd-pop / .dd-caret pill language is bundled app-wide
   from TodoBoxView (statically imported by the router); only today-specific tweaks live here. */
.pd-proj-filter { flex-shrink: 0; }
/* Long project names must not stretch the date strip: truncate the current-selection text */
.pd-proj-filter .dropdown-select__label { max-width: 200px; }
.pd-proj-cur { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Project color dot inside the dropdown options (same dot language as the row badges) */
.pd-proj-opt-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
</style>
