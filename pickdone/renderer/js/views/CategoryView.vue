<template>

  <div class="page category-page" :key="catId">
    <div class="page__main page__main--flow-top">
      <empty-state v-if="!groups.length"><template #text>{{ $t('statsI.CategoryView.empty') }}</template></empty-state>
      <div v-else class="todo-list-item-group-list">
        <group-block v-for="g in groups" :key="g.key"
           :title="$t(g.titleKey || g.title)" :count="g.todos.length" :todos="g.todos"
          :color="g.color || ''" :show-date="!!g.showDate"
          :has-settings="!!g.hasSettings" :has-recomplete="!!g.hasRecomplete"
          :collapsed="collapsedMap[g.key]" @update:collapsed="v => setCol(g.key, v)" @recomplete="recomplete"/>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Category list view (project baseline route todo-list-category /category/:id)
 * Project baseline structure matches recent todos (no standalone page header, list name shown in sidebar):
 *   todo-page-layout(key=id) > .page__main > .todo-list-item-group-list >
 *     past completed (within X) / expired uncompleted (within X, color2, reschedule) /
 *     today/tomorrow/day after tomorrow (color3, M/D weekX) / later schedules / no date
 * Events filtered by categoryId === route id; rows reuse <todo-item>.
 */
import { rangeDays } from '../utils/core.js'
import { batchMoveWithUndo } from '../utils/confirm.js'
import { calTitle } from '../utils/buckets.js'
import { DAY_MS, rescheduleExpired, rangeLabel } from '../utils/core.js'
import TodoGroupBlock from '../components/TodoGroupBlock.vue'
import EmptyState from '../components/EmptyState.vue'

export default {
  name: 'CategoryView',
  components: { GroupBlock: TodoGroupBlock, EmptyState },
  data () {
    return {
      collapsedMap: { catExpDone: true, catExpUndo: false, catToday: false, catTomorrow: false, catDat: false, catUpcoming: false, catNoDate: false }
    }
  },
  computed: {
    catId () { return Number(this.$route.params.id) || 0 },
    settings () { return this.$store.state.settings },
    todayTs () { return this.$store.state.todo.todayTimestamp },
    inCat () {
      const id = this.catId
      if (id === -1 || isNaN(this.catId)) {
        // No category list: categoryId is 0 or does not belong to any existing category
        const known = new Set(this.$store.state.category.list.map(c => c.categoryId))
        return this.$store.state.todo.todoList.filter(t => !t.categoryId || !known.has(t.categoryId))
      }
      return this.$store.state.todo.todoList.filter(t => t.categoryId === id)
    },
    groups () {
      const s = this.settings
      
      const R1 = rangeDays(s.expiredCompletedTodoRange, 7)
      const R2 = rangeDays(s.expiredUncompletedTodoRange, 30)
      const list = this.inCat
      const today = this.todayTs
      const bucket = f => list.filter(f).sort((a, b) => b.taskSort - a.taskSort || b.createTime - a.createTime)
      const g = []
      const expDone = bucket(t => t.complete && t.dayStart && t.dayStart < today && t.dayStart >= today - R1 * DAY_MS)
      if (expDone.length) g.push({ key: 'catExpDone', title: this.$t('statsI.CategoryView.expDoneTitle', { r: rangeLabel(s.expiredCompletedTodoRange, this.$t) }), todos: expDone, showDate: true, hasSettings: true })
      const expUndo = bucket(t => !t.complete && t.dayStart && t.dayStart < today && t.dayStart >= today - R2 * DAY_MS).sort((a, b) => a.dayStart - b.dayStart)
      if (expUndo.length) g.push({ key: 'catExpUndo', title: this.$t('statsI.CategoryView.expUndoTitle', { r: rangeLabel(s.expiredUncompletedTodoRange, this.$t) }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
      const td = bucket(t => !t.complete && t.dayStart === today)
      if (td.length) g.push({ key: 'catToday', title: this.calTitle(today), todos: td, color: 'color3' })
      const tm = bucket(t => t.dayStart === today + DAY_MS)
      if (tm.length) g.push({ key: 'catTomorrow', title: this.calTitle(today + DAY_MS), todos: tm, color: 'color3' })
      const dat = bucket(t => t.dayStart === today + 2 * DAY_MS)
      if (dat.length) g.push({ key: 'catDat', title: this.calTitle(today + 2 * DAY_MS), todos: dat, color: 'color3' })
      const up = bucket(t => !t.complete && t.dayStart > today + 2 * DAY_MS)
      if (up.length) g.push({ key: 'catUpcoming', title: this.$t('statsE.CategoryView.upcomingLabel'), todos: up, showDate: true, color: 'color3', hasSettings: true })
      const nd = bucket(t => !t.complete && !t.dayStart)
      if (nd.length) g.push({ key: 'catNoDate', title: this.$t('statsE.CategoryView.noDateLabel'), todos: nd, hasSettings: true })
      return g
    }
  },
  methods: {
    calTitle (ts) { return calTitle(ts) },
    setCol (key, val) { this.collapsedMap[key] = val },
    /** "Reschedule": expired uncompleted in this list -> today */
    async recomplete () {
      const ts = this.todayTs
      const { n, snap }: any = await rescheduleExpired(this.$store.dispatch, this.inCat, ts)
      if (n) batchMoveWithUndo(this, {
        label: this.$t('statsE.CategoryView.overdueRescheduledMsg'),
        snap,
        revertOf: r => this.$store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { dayStart: r.dayStart, todoTime: r.todoTime } })
      })
    }
  },

}
</script>
