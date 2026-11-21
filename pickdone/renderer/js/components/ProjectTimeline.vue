<template>
  <!-- pd20 P1 multi-view (2026-11-06): the project page's LIGHTWEIGHT timeline, per the PRD.
       The rows are the SAME data source as the handoff overview — queryEpisodesByCategory's
       timeline array (every live episode of the project, newest first; the handoff's recent-8
       is a slice of exactly these rows). Grouped by day; a row click opens its task through
       the shared project open path. No gantt, no chart library, no fabricated states. -->
  <div class="proj-tl" role="group" :aria-label="$t('statsB.ProjectView.viewTimeline')">
    <empty-state v-if="!days.length"><template #text>{{ $t('statsB.ProjectView.timelineEmpty') }}</template></empty-state>
    <div v-for="d in days" :key="d.key" class="proj-tl__day">
      <div class="proj-tl__date">{{ d.label }}</div>
      <div v-for="e in d.items" :key="e.episodeId" class="proj-tl__row" role="button" tabindex="0"
           :data-episode-id="e.episodeId"
           @click="open(e.taskId)" @keydown.enter.prevent="open(e.taskId)">
        <span class="proj-tl__time">{{ e.time }}</span>
        <span class="proj-tl__task" :title="e.taskContent">{{ e.taskContent }}</span>
        <span class="proj-tl__goal" :title="e.goal">{{ e.goal || $t('statsB.ProjectView.timelineNoGoal') }}</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import EmptyState from './EmptyState.vue'
import { dayjs, FMT } from '../utils/core.js'
import { openProjectTask } from '../utils/projectOpenTask.js'

export default {
  name: 'ProjectTimeline',
  components: { EmptyState },
  props: {
    catId: { type: [Number, String], default: 0 }
  },
  data () {
    return { episodes: [], taskTitles: {} as any }
  },
  computed: {
    days () {
      const byDay = new Map()
      for (const e of this.episodes) {
        const d = e.startedAt ? dayjs(e.startedAt) : null
        const key = d ? d.format('YYYY-MM-DD') : 'none'
        if (!byDay.has(key)) byDay.set(key, { key, label: d ? d.format(FMT.date) : this.$t('statsB.ProjectView.timelineNoDate'), items: [] })
        byDay.get(key).items.push({ ...e, taskContent: this.taskTitles[String(e.taskId)] || String(e.taskId), time: d ? d.format('HH:mm') : '' })
      }
      return [...byDay.values()]
    }
  },
  watch: {
    catId: { immediate: true, handler () { this.load() } }
  },
  methods: {
    async load () {
      if (!this.catId || !(window.todoAPI && window.todoAPI.dbCall)) { this.episodes = []; this.taskTitles = {}; return }
      try {
        const res = await window.todoAPI.dbCall('queryEpisodesByCategory', this.catId)
        const titles = {}
        for (const t of (res && res.tasks) || []) titles[t.taskId] = t.taskContent
        this.taskTitles = titles
        this.episodes = (res && res.timeline) || []
      } catch {
        this.episodes = [] // read failure renders the empty state; the handoff overview keeps its own error path
      }
    },
    open (taskId) { openProjectTask(this.$store, this.catId, taskId) }
  }
}
</script>

<style>
.proj-tl { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.proj-tl__date { font-size: var(--fs-sm); color: var(--text-3); font-weight: 600; }
.proj-tl__day { display: flex; flex-direction: column; gap: var(--space-1); }
.proj-tl__row { display: flex; align-items: baseline; gap: var(--space-3); min-width: 0; padding: var(--space-1) 0; cursor: pointer; border-bottom: 1px solid var(--line); }
.proj-tl__row:hover .proj-tl__task { color: var(--brand); }
.proj-tl__time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
.proj-tl__task { flex-shrink: 0; max-width: 40%; font-size: var(--fs-sm); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-tl__goal { flex: 1 1 auto; min-width: 0; font-size: var(--fs-sm); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
