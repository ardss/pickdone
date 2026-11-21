<template>
  <!-- pd20 P1 multi-view (2026-11-06): the project page's SIMPLE board, per the PRD's
       "user-selectable list, board and saved filters, lightweight timeline". Two columns by
       the task's real completion state (the only workflow signal in the data — no invented
       statuses, no drag-write semantics). Cards share the list's data source (the store via
       the parent) and the same open path as every other project-page row. -->
  <div class="proj-board" role="group" :aria-label="$t('statsB.ProjectView.viewBoard')">
    <div v-for="col in columns" :key="col.key" class="proj-board__col" :data-col="col.key">
      <div class="proj-board__head">
        <span>{{ col.title }}</span>
        <em class="proj-board__count">{{ col.items.length }}</em>
      </div>
      <empty-state v-if="!col.items.length"><template #text>{{ col.emptyKey }}</template></empty-state>
      <div v-else class="proj-board__cards">
        <div v-for="t in col.items" :key="t.taskId" class="proj-board__card" role="button" tabindex="0"
             :data-task-id="t.taskId"
             :aria-label="t.taskContent"
             @click="open(t.taskId)" @keydown.enter.prevent="open(t.taskId)">
          <div class="proj-board__card-title" :class="{ done: t.complete }">{{ t.taskContent }}</div>
          <div v-if="t.deadlineTs" class="proj-board__card-dl">{{ fmtDate(t.deadlineTs) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import EmptyState from './EmptyState.vue'
import { dayjs, FMT } from '../utils/core.js'
import { openProjectTask } from '../utils/projectOpenTask.js'

export default {
  name: 'ProjectBoard',
  components: { EmptyState },
  props: {
    catId: { type: [Number, String], default: 0 },
    tasks: { type: Array, default: () => [] }
  },
  computed: {
    columns () {
      const live = (this.tasks || []).filter(t => !t.delete)
      return [
        { key: 'active', title: this.$t('statsB.ProjectView.boardActive'), emptyKey: 'statsB.ProjectView.boardActiveEmpty', items: live.filter(t => !t.complete) },
        { key: 'done', title: this.$t('statsB.ProjectView.boardDone'), emptyKey: 'statsB.ProjectView.boardDoneEmpty', items: live.filter(t => !!t.complete) }
      ]
    }
  },
  methods: {
    fmtDate (ts) { return ts ? dayjs(ts).format(FMT.date) : '' },
    open (taskId) { openProjectTask(this.$store, this.catId, taskId) }
  }
}
</script>

<style>
.proj-board { display: flex; gap: var(--space-3); align-items: flex-start; }
.proj-board__col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.proj-board__head { display: flex; align-items: center; gap: var(--space-2); font-size: var(--fs-md); color: var(--text-2); font-weight: 600; }
.proj-board__count { font-style: normal; font-size: var(--fs-xs); color: var(--text-3); }
.proj-board__cards { display: flex; flex-direction: column; gap: var(--space-2); }
.proj-board__card { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); cursor: pointer; min-width: 0; }
.proj-board__card:hover { border-color: var(--brand); }
.proj-board__card-title { font-size: var(--fs-sm); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-board__card-title.done { color: var(--text-3); text-decoration: line-through; }
.proj-board__card-dl { margin-top: 2px; font-size: var(--fs-xs); color: var(--text-3); }
</style>
