<template>
  <!-- pd20 P1-01 work-handoff overview (extracted from ProjectView for the size ratchet):
       same-source rollup of this project's work episodes (read-only via queryEpisodesByCategory;
       the latest nextAction / goal come straight from the stored note — never a fabricated
       status). Collapsible to keep the page low-scroll; styles live in the SFC's own unscoped block (global cascade contract) under the unique proj-ho prefix. -->
  <div class="proj-ho">
    <button class="proj-ho__toggle" type="button" :aria-expanded="open"
            :aria-label="$t('statsJ.ProjectView.handoffTitle')" @click="open = !open">
      <app-icon :name="open ? 'chevron-down' : 'chevron-right'" :size="12"/>
      <span>{{ $t('statsJ.ProjectView.handoffTitle') }}</span>
      <em v-if="recent.length" class="proj-ho__count">{{ $t('statsJ.ProjectView.handoffEpCount', { n: totalEpisodes }) }}</em>
    </button>
    <label class="proj-ho__filter">
      <input v-model="episodesOnly" type="checkbox"/> {{ $t('statsJ.ProjectView.handoffEpisodesOnly') }}
    </label>
    <div v-if="open" class="proj-ho__panel">
      <empty-state v-if="!rows.length"><template #text>{{ $t('statsJ.ProjectView.handoffEmpty') }}</template></empty-state>
      <template v-else>
        <div v-for="r in rows" :key="r.taskId" class="proj-ho-row" role="button" tabindex="0"
             :aria-label="$t('statsJ.ProjectView.handoffOpenTaskAria', { t: r.taskContent })"
             @click="openTask(r)" @keydown.enter.prevent="openTask(r)">
          <div class="proj-ho-row__title">
            <span class="proj-ho-row__name">{{ r.taskContent }}</span>
            <em class="proj-ho-row__epn">{{ $t('statsJ.ProjectView.handoffEpCount', { n: r.episodeCount }) }}</em>
          </div>
          <div class="proj-ho-row__next" :class="{ 'proj-ho-row__next--empty': !r.lastNextAction }">
            {{ r.lastNextAction || $t('statsJ.ProjectView.handoffNoRecord') }}
          </div>
        </div>
        <div v-if="recent.length" class="proj-ho__recent">
          <div class="proj-ho__recent-title">{{ $t('statsJ.ProjectView.handoffRecentTitle') }}</div>
          <div v-for="e in recent" :key="e.episodeId" class="proj-ho-recent">
            <span class="proj-ho-recent__time">{{ fmtDateTime(e.startedAt) }}</span>
            <span class="proj-ho-recent__goal">{{ e.goal || $t('statsJ.ProjectView.handoffNoRecord') }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * ProjectHandoff — the ProjectView overview's collapsible work-handoff section.
 * One read op (queryEpisodesByCategory): per-task episode rollup + project-level last-8
 * episodes, both parsed from the stored episode notes by the main process. The 'tasks with
 * episodes only' filter lives HERE (renderer toggle), never in the op. Clicking a task row
 * opens the existing EditPanel through the same ui/openEdit door the list views use; an
 * unknown task id stays inert. A read failure degrades to the empty state, never breaks the page.
 */
import { dayjs, FMT } from '../utils/core.js'
import EmptyState from './EmptyState.vue'

export default {
  name: 'ProjectHandoff',
  components: { EmptyState },
  props: { catId: { type: Number, required: true } },
  data () {
    return {
      open: true,
      // default ON: an idle task without episodes is noise in a handoff view until asked for
      episodesOnly: true,
      tasks: [] as any,
      recent: [] as any
    }
  },
  computed: {
    rows () {
      return this.episodesOnly ? this.tasks.filter(r => r.episodeCount > 0) : this.tasks
    },
    totalEpisodes () { return this.tasks.reduce((s, r) => s + (r.episodeCount || 0), 0) }
  },
  created () { this.reload() },
  mounted () {
    // Same refresh channel as ProjectView's header: inbound sync rounds / CLI writes broadcast
    // todos-changed; re-read throttled so a burst of broadcasts stays one fetch.
    if (window.todoAPI && window.todoAPI.onTodosChanged) {
      this._offTodosChanged = window.todoAPI.onTodosChanged(() => {
        const now = Date.now()
        if (this._refreshAt && now - this._refreshAt < 2000) return
        this._refreshAt = now
        try { this.reload() } catch { /* keep current view state */ }
      })
    }
  },
  beforeUnmount () {
    if (this._offTodosChanged) { try { this._offTodosChanged() } catch { /* already off */ } }
  },
  watch: {
    // project -> project navigation reuses ProjectView (no remount): re-key the data
    catId () { this.reload() }
  },
  methods: {
    async reload () {
      if (!this.catId) { this.tasks = []; this.recent = []; return }
      try {
        const res: any = await window.todoAPI.dbCall('queryEpisodesByCategory', this.catId)
        this.tasks = (res && res.tasks) || []
        this.recent = (res && res.recent) || []
      } catch {
        this.tasks = []
        this.recent = []
      }
    },
    async openTask (r) {
      let raw = this.$store.getters['todo/byCategory'](this.catId).find(t => t.taskId === r.taskId)
      if (!raw) {
        // pd20 (2026-11-06) UI-acceptance fix: a freshly synced row can reach the handoff query
        // before the byCategory cache catches up (external writes ride todos-changed -> async
        // refresh). The click used to be a SILENT no-op; now it refreshes the store once
        // (the canonical todo/init path) and retries, so the row is always openable.
        try { await this.$store.dispatch('todo/init') } catch { /* keep the cache verdict */ }
        raw = this.$store.getters['todo/byCategory'](this.catId).find(t => t.taskId === r.taskId)
      }
      if (raw) this.$store.commit('ui/openEdit', raw)
    },
    fmtDateTime (ts) { return ts ? dayjs(ts).format(FMT.dateTime) : '—' }
  }
}
</script>

<style>
.proj-ho { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
.proj-ho__toggle {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--fs-sm); font-weight: 600; color: var(--text-1);
  padding: 3px 8px; border-radius: var(--radius-sm); transition: all var(--t-fast);
}
.proj-ho__toggle:hover { color: var(--brand); background: var(--hover-bg); }
.proj-ho__count { font-style: normal; font-weight: 400; font-size: var(--fs-xs); color: var(--text-3); }
.proj-ho__filter { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--text-3); cursor: pointer; }
.proj-ho__panel { flex-basis: 100%; display: flex; flex-direction: column; gap: 6px; margin-top: var(--space-2); }
.proj-ho-row {
  padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-md, 10px);
  background: var(--panel, #fff); cursor: pointer;
  transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.proj-ho-row:hover { border-color: var(--brand); box-shadow: 0 2px 10px rgba(17, 121, 121, .08); }
.proj-ho-row:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.proj-ho-row__title { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.proj-ho-row__name { color: var(--text-1); font-weight: 500; font-size: var(--fs-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ho-row__epn { font-style: normal; flex-shrink: 0; margin-left: auto; font-size: var(--fs-2xs); color: var(--brand); background: var(--brand-light); padding: 1px 7px; border-radius: var(--radius-pill); }
.proj-ho-row__next { margin-top: 2px; font-size: var(--fs-xs); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ho-row__next--empty { color: var(--text-4); font-style: italic; }
.proj-ho__recent { margin-top: var(--space-2); border-top: 1px dashed var(--line); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 4px; }
.proj-ho__recent-title { font-size: var(--fs-xs); font-weight: 600; color: var(--text-2); }
.proj-ho-recent { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; font-size: var(--fs-xs); }
.proj-ho-recent__time { flex-shrink: 0; color: var(--text-3); font-variant-numeric: tabular-nums; }
.proj-ho-recent__goal { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
