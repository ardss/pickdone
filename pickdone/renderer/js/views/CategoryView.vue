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
import { batchMoveWithUndo } from '../utils/confirm.js'
import { rescheduleExpired } from '../utils/core.js'
import { buildExpiryGroups } from '../utils/expiryGroups.js'
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
      // Wave-5 dedup: the 7-bucket expiry grouping was verbatim-identical with ProjectView's
      // groups(); only the i18n keys differ here (statsI/statsE shards). Single source in
      // utils/expiryGroups.js; group keys are an unchanged UI contract.
      return buildExpiryGroups({
        list: this.inCat,
        settings: this.settings,
        today: this.todayTs,
        t: this.$t,
        keys: {
          expDone: 'statsI.CategoryView.expDoneTitle',
          expUndo: 'statsI.CategoryView.expUndoTitle',
          upcoming: 'statsE.CategoryView.upcomingLabel',
          noDate: 'statsE.CategoryView.noDateLabel'
        }
      })
    }
  },
  methods: {
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
