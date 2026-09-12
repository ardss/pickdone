<template>

  <div class="page tag-page">
    <div class="page__main page__main--flow-top">
      <empty-state v-if="!groups.length"><template #text>{{ $t('statsC.Tag.empty') }}</template></empty-state>
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
 * Tag view (project baseline route todo-list-tag /tag/:id)
 * Project baseline structure = grouping identical to recent todos (no standalone page header):
 *   todo-page-layout > .page__main > .todo-list-item-group-list >
 *     past completed (within X) / expired uncompleted (within X, color2, reschedule) /
 *     today/tomorrow/day after tomorrow (color3, M/D weekX) / later schedules / no date
 * Tag filtering is exact match (fuzzy matching would wrongly fold #worksummary into #work and also affect batch re-sorting); rows reuse <todo-item>.
 */
import { calTitle } from '../utils/buckets.js'
import { DAY_MS, rescheduleExpired, rangeLabel } from '../utils/core.js'
import { batchMoveWithUndo } from '../utils/confirm.js'
import { extractTags } from '../utils/search.js'
import TodoGroupBlock from '../components/TodoGroupBlock.vue'
import EmptyState from '../components/EmptyState.vue'

export default {
  name: 'TagView',
  components: { GroupBlock: TodoGroupBlock, EmptyState },
  data () {
    return {
      collapsedMap: { tagExpDone: true, tagExpUndo: false, tagToday: false, tagTomorrow: false, tagDat: false, tagUpcoming: false, tagNoDate: false }
    }
  },
  computed: {
    tag () { return this.$route.params.id },
    /** All events under this tag (#tag matched in title and description), sorted by update time descending */
    tagged () {
      return this.$store.state.todo.todoList
        .filter(t => extractTags(t.taskContent, t.taskDescribe).some(x => x.toLowerCase() === String(this.tag).toLowerCase()))
        .sort((a, b) => b.updateTime - a.updateTime)
    },
    todayTs () { return this.$store.state.todo.todayTimestamp },
    groups () {
      const s = this.$store.state.settings
      const num = v => parseInt(String(v).replace(/[^0-9]/g, ''), 10) || 7
      const R1 = num(s.expiredCompletedTodoRange)
      const R2 = num(s.expiredUncompletedTodoRange || '30d')
      const list = this.tagged
      const today = this.todayTs
      const doneIn = arr => arr.filter(t => t.complete && t.dayStart && t.dayStart < today && t.dayStart >= today - R1 * DAY_MS)
      const undoIn = arr => arr.filter(t => !t.complete && t.dayStart && t.dayStart < today && t.dayStart >= today - R2 * DAY_MS)
      const g = []
      const expDone = doneIn(list)
      if (expDone.length) g.push({ key: 'tagExpDone', title: this.$t('statsC.Tag.expDoneTitle', { n: rangeLabel(s.expiredCompletedTodoRange, this.$t) }), todos: expDone, showDate: true, hasSettings: true })
      const expUndo = undoIn(list).sort((a, b) => a.dayStart - b.dayStart)
      if (expUndo.length) g.push({ key: 'tagExpUndo', title: this.$t('statsC.Tag.expUndoTitle', { n: rangeLabel(s.expiredUncompletedTodoRange, this.$t) }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
      const bucket = f => list.filter(f).sort((a, b) => b.taskSort - a.taskSort || b.createTime - a.createTime)
      const td = bucket(t => !t.complete && t.dayStart === today)
      if (td.length) g.push({ key: 'tagToday', title: this.calTitle(today), todos: td, color: 'color3' })
      const tm = bucket(t => t.dayStart === today + DAY_MS)
      if (tm.length) g.push({ key: 'tagTomorrow', title: this.calTitle(today + DAY_MS), todos: tm, color: 'color3' })
      const dat = bucket(t => t.dayStart === today + 2 * DAY_MS)
      if (dat.length) g.push({ key: 'tagDat', title: this.calTitle(today + 2 * DAY_MS), todos: dat, color: 'color3' })
      const up = bucket(t => !t.complete && t.dayStart > today + 2 * DAY_MS)
      if (up.length) g.push({ key: 'tagUpcoming', title: this.$t('statsC.Tag.upcomingTitle'), todos: up, showDate: true, color: 'color3', hasSettings: true })
      const nd = bucket(t => !t.complete && !t.dayStart)
      if (nd.length) g.push({ key: 'tagNoDate', title: this.$t('statsC.Tag.noDateTitle'), todos: nd, hasSettings: true })
      // Completed items outside the past window are also left out of the later segment: omitted to follow the project baseline
      return g
    }
  },
  methods: {
    calTitle (ts) { return calTitle(ts) },
    setCol (key, val) { this.collapsedMap[key] = val },
    async recomplete () {
      const ts = this.todayTs
      const { n, snap }: any = await rescheduleExpired(this.$store.dispatch, this.$store.state.todo.todoList.filter(t => { const tags = extractTags(t.taskContent, t.taskDescribe); return tags.some(x => x.toLowerCase() === String(this.tag).toLowerCase()) }), ts)
      if (n) batchMoveWithUndo(this, {
        label: this.$t('statsC.Tag.rescheduled'),
        snap,
        revertOf: r => this.$store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { dayStart: r.dayStart, todoTime: r.todoTime } })
      })
    }
  },

}
</script>
