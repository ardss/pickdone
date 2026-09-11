<template>

  <div class="page projects-page">
    <div class="proj-toolbar">
      <span class="proj-toolbar__tip">{{ $t('statsB.ProjectsView.toolbarTip') }}</span>
      <button class="proj-new-btn" @click="createProject"><app-icon name="plus" :size="12"/> {{ $t('statsB.ProjectsView.newProject') }}</button>
    </div>
    <div class="page__main page__main--flow-top">
      <!-- Status filter chips (client-side filter; default All) -->
      <div v-if="projects.length" class="proj-filter" role="group" :aria-label="$t('projQ.filterAria')">
        <button v-for="f in statusFilters" :key="f" type="button" class="proj-filter__chip"
                :class="{ on: filter === f }" :aria-pressed="filter === f" @click="filter = f">
          {{ $t(filterKey(f)) }}
        </button>
      </div>
      <div v-if="filteredProjects.length" class="proj-grid">
        <!-- No role=link wrapper: a link role with an interactive role=button nested inside breaks the
             a11y tree; the card stays keyboard-openable via tabindex+enter while the status pill is an
             independently reachable button -->
        <div v-for="p in filteredProjects" :key="p.cat.categoryId" class="proj-card" tabindex="0"
             :title="$t('statsB.ProjectsView.enterProject', { name: p.cat.categoryName })"
             @click="open(p.cat.categoryId)" @keydown.enter.prevent="open(p.cat.categoryId)">
          <div class="proj-card__head">
            <span class="sn-dot" :style="{borderColor:p.cat.categoryColor, background:p.cat.categoryColor}"></span>
            <span class="proj-card__name">{{p.cat.categoryName}}</span>
            <svg class="proj-ring" viewBox="0 0 32 32" width="32" height="32" role="img" :aria-label="$t('statsB.ProjectsView.progressAria', { n: p.stats.progress })">
              <circle class="proj-ring__track" cx="16" cy="16" r="13"/>
              <circle class="proj-ring__fill" cx="16" cy="16" r="13"
                      :stroke="p.cat.categoryColor || 'var(--brand)'"
                      :stroke-dasharray="ring(p.stats.progress).dasharray"
                      :stroke-dashoffset="ring(p.stats.progress).dashoffset"/>
              <text class="proj-ring__text" x="16" y="20" text-anchor="middle">{{p.stats.progress}}</text>
            </svg>
          </div>
          <div class="proj-card__meta">
            <span class="proj-status" :class="'proj-status--' + p.status" role="button" tabindex="0"
                  :title="$t('projQ.statusChangeTip', { s: $t(statusKey(p.status)) })"
                  :aria-label="$t('projQ.statusAria', { s: $t(statusKey(p.status)) })"
                  @click.stop="cycleStatus(p.cat.categoryId, p.status)"
                  @keydown.enter.prevent.stop="cycleStatus(p.cat.categoryId, p.status)">{{ $t(statusKey(p.status)) }}</span>
            <span>{{ $t('statsB.ProjectsView.tasks', { done: p.stats.doneCount, total: p.stats.total }) }}</span>
            <span :title="$t('statsB.ProjectsView.focusTip')">{{ $t('statsB.ProjectsView.focusMin', { n: p.stats.focusMinutes }) }}</span>
            <span v-if="loadThreshold > 0" class="proj-load" :class="{'proj-load--warn': p.loadWarn}"
                  :title="$t('projQ.loadTip', { n: p.load, t: loadThreshold })">{{ $t('projQ.loadChip', { n: p.load }) }}</span>
            <span v-if="p.stats.overdue" class="proj-card__overdue">{{ $t('statsB.ProjectsView.overdueCount', { n: p.stats.overdue }) }}</span>
            <span v-if="p.deadline" class="proj-card__dl" :class="deadlineClass(p.deadline)"
                  :title="$t('statsB.ProjectsView.deadlineTip', { d: fmtDate(p.deadline) })">{{deadlineText(p.deadline)}}</span>
            <span v-else-if="p.stats.startedAt" class="proj-card__start">{{ $t('statsB.ProjectsView.startedOn', { d: fmtDate(p.stats.startedAt) }) }}</span>
          </div>
          <div v-if="p.nextMs" class="proj-card__next" :title="$t('statsB.ProjectsView.nextMsTip')">
            ◆ {{p.nextMs.title}} · {{fmtDate(p.nextMs.date)}}
          </div>
        </div>
      </div>
      <div v-if="!filteredProjects.length" class="empty">
        <div class="empty__icon"></div>
        <!-- 过滤无结果 ≠ 真没项目:区分文案 + 一键清除筛选出口;filter=all 仍走原有"暂无项目"空态 -->
        <template v-if="filter !== 'all' && projects.length">
          <div class="empty__text">{{ $t('projQ.filteredEmpty') }}</div>
          <button type="button" class="proj-filter__clear" @click="filter = 'all'">{{ $t('projQ.clearFilter') }}</button>
        </template>
        <div v-else class="empty__text">{{ $t('statsB.ProjectsView.empty') }}</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Projects overview view (route todo-list-projects /todo-list/projects)
 * A navigation page at the same level as today's todos/insights; progressive disclosure: with no projects the sidebar entry doesn't appear and this page is unreachable.
 * One progress card per project: name/progress bar/task completion ratio/focus minutes/overdue count; click to open the project detail (ProjectView).
 */
import { dayjs, FMT } from '../utils/core.js'
import { dueStateOf } from '../utils/milestones.js'
import { dayPlannedLoad, loadLevel } from '../utils/loadWarn.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import { PROJECT_STATUSES, normalizeStatus, statusI18nKey, STATUS_FILTER_I18N_KEYS } from '../utils/projectStatus.js'

/** Project stats sharing the same semantics as ProjectView/stats and the CLI's projectStatus */
function projectStats (list, today0) {
  const done = list.filter(t => t.complete)
  const today0n = today0 || +dayjs().startOf('day')
  const started = list.reduce((m, t) => Math.min(m, t.createTime || m), Infinity)
  return {
    total: list.length,
    doneCount: done.length,
    progress: list.length ? Math.round(done.length / list.length * 100) : 0,
    focusMinutes: list.reduce((s, t) => s + (t.estimate || 0), 0),
    startedAt: isFinite(started) ? started : 0,
    lastActivity: done.reduce((m, t) => Math.max(m, t.completedAt || 0), 0),
    overdue: list.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < (today0n || today0)).length
  }
}

export default {
  name: 'ProjectOverviewView',
  data () {
    return {
      filter: 'all' // status filter chip: 'all' | one of PROJECT_STATUSES
    }
  },
  computed: {
    statusFilters () { return ['all', ...PROJECT_STATUSES] },
    loadThreshold () { return Number(this.$store.state.settings.dailyLoadWarnThreshold) || 0 },
    projects () {
      const today0 = this.$store.state.todo.todayTimestamp || +dayjs().startOf('day')
      const threshold = this.loadThreshold
      return this.$store.getters['category/projects'].map(c => {
        const meta = (this.$store.getters['category/projectMeta'])[c.categoryId] || {}
        const todos = this.$store.state.todo.todoList.filter(t => t.categoryId === c.categoryId)
        // Today-load badge: only tasks scheduled for today; estimates come from the shared tomatoEstimate map
        const load = dayPlannedLoad(todos.filter(t => t.dayStart === today0), t => getEstimate(t.taskId))
        return {
          cat: c,
          stats: projectStats(todos, this.$store.state.todo.todayTimestamp),
          deadline: meta.deadline || 0,
          nextMs: meta.nextMilestone || null,
          status: this.$store.getters['category/projectStatus'](c.categoryId),
          load,
          loadWarn: loadLevel(load, threshold) === 'warn'
        }
      })
    },
    filteredProjects () {
      return this.filter === 'all' ? this.projects : this.projects.filter(p => p.status === this.filter)
    }
  },
  methods: {
    statusKey (s) { return statusI18nKey(s) },
    filterKey (f) { return STATUS_FILTER_I18N_KEYS[f] || STATUS_FILTER_I18N_KEYS.all },
    /** Status pill on the card cycles through the lifecycle (compact card layout beats a dropdown here).
     *  Every switch toasts the new status; landing on 'cancelled' asks for confirmation first — a single
     *  accidental click must not silently kill a project's status. */
    cycleStatus (id, cur) {
      const i = PROJECT_STATUSES.indexOf(normalizeStatus(cur))
      const next = PROJECT_STATUSES[(i + 1) % PROJECT_STATUSES.length]
      const apply = () => {
        this.$store.commit('category/setProjectStatus', { id, status: next })
        if (this.$message) this.$message.success(this.$t('projQ.statusChanged', { s: this.$t(statusI18nKey(next)) }))
      }
      if (next === 'cancelled') {
        this.$confirm(this.$t('projQ.cancelConfirmText'), this.$t('projQ.cancelConfirmTitle'), { type: 'warning' })
          .then(apply).catch(() => {})
      } else apply()
    },
    fmtDate (ts) { return ts ? dayjs(ts).format(FMT.date) : '—' },
    deadlineText (ts) {
      const d = Math.ceil((ts - Date.now()) / 864e5)
      if (d < 0) return this.$t('statsB.ProjectsView.overdue')
      return d <= 3 ? this.$t('statsB.ProjectsView.dueInDays3', { n: d }) : this.$t('statsB.ProjectsView.dueInDays', { n: d })
    },
    deadlineClass (ts) {
      const s = dueStateOf(ts)
      return s === 'overdue' ? 'proj-card__dl--over' : (s === 'soon' ? 'proj-card__dl--soon' : '')
    },
    open (id) { this.$router.push({ name: 'todo-list-project', params: { id: String(id) } }).catch(() => {}) },
    /** Progress ring SVG parameters (r=13, viewBox 32) */
    ring (p) {
      const C = 2 * Math.PI * 13
      return { dasharray: C.toFixed(1), dashoffset: (C * (1 - p / 100)).toFixed(1) }
    },
    /** One-click project creation: name -> create category -> flag as project, done in one step */
    async createProject () {
      try {
        const { value } = await this.$prompt(this.$t('statsB.ProjectsView.promptText'), this.$t('statsB.ProjectsView.promptTitle'), {
          inputValue: '', inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectsView.nameRequired')
        })
        const name = (value || '').trim()
        if (!name) return
        // Exact-match the created entity by id delta + name, not `list[list.length-1]`: sort/order changes
        // or a concurrent add could make the last row a different category.
        const before = new Set(this.$store.state.category.list.map(c => c.categoryId))
        this.$store.commit('category/addCategory', { categoryName: name })
        const created = this.$store.state.category.list
          .find(c => !before.has(c.categoryId) && c.categoryName === name)
        if (!created) return
        this.$store.commit('category/setProject', { id: created.categoryId, flag: true })
        this.$message.success(this.$t('statsB.ProjectsView.created', { name }))
      } catch { /* cancelled */ }
    }
  },

}
</script>
<style>
.proj-card {
  padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--hover-bg); cursor: pointer; transition: box-shadow var(--t-base), transform var(--t-base);
}
.proj-card:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, .08); transform: translateY(-1px); }
.proj-card__head { display: flex; align-items: center; gap: var(--space-2); }
.proj-card__name { font-size: var(--fs-base); font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-card__pct { font-style: normal; margin-left: auto; font-size: var(--fs-md); font-weight: 600; color: var(--text-2); flex-shrink: 0; }
.proj-card__meta { display: flex; gap: var(--space-3); margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text-3); flex-wrap: wrap; }
.proj-card__overdue { color: var(--danger); font-weight: 600; }
.proj-card__start { margin-left: auto; }
.proj-card__head .proj-ring { margin-left: auto; flex-shrink: 0; }
.proj-card__dl { font-weight: 600; color: var(--brand-dark); }
.proj-card__dl--over { color: var(--danger); }
/* N3 截止/临近卡片色 */
.proj-card__dl--soon { color: var(--warn); }
html[data-theme="dark"] .proj-card { background: rgba(255, 255, 255, .03); }
/* 项目总览页（导航级入口的卡片栅格；渐进披露：无项目时整页不可达） */
.proj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); padding: 16px 28px; }
/* 项目总览页工具条：说明文案 + 新建项目按钮（入口常驻后的主创建路径） */
.proj-toolbar {
  display: flex; align-items: center; gap: var(--space-3);
  padding: 12px 28px 0;
}
.proj-toolbar__tip { font-size: var(--fs-xs); color: var(--text-3); }
.proj-new-btn {
  margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
  font-size: var(--fs-sm); color: #fff; background: var(--brand);
  padding: 5px 12px; border-radius: var(--radius-sm); transition: background var(--t-fast);
}
.proj-new-btn:hover { background: var(--brand-dark); }
/* 进度环（项目卡片右上角，进度=任务完成比） */
.proj-ring__track { fill: none; stroke: var(--track-bg); stroke-width: 3.4; }
.proj-ring__fill { fill: none; stroke-width: 3.4; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 16px 16px; transition: stroke-dashoffset var(--t-slow); }
.proj-ring__text { font-size: var(--fs-2xs); font-weight: 600; fill: var(--text-2); }
/* ---- Project status: filter chips above the grid + status pill / today-load chip on each card ---- */
.proj-filter { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); padding: 12px 28px 0; }
.proj-filter__chip {
  font-size: var(--fs-xs); color: var(--text-2); background: var(--gray-bg);
  padding: 3px 12px; border: 1px solid transparent; border-radius: var(--radius-pill);
  transition: all var(--t-fast);
}
.proj-filter__chip:hover { color: var(--brand-text); background: var(--brand-light); }
.proj-filter__chip.on { color: var(--brand-text); border-color: var(--brand); background: var(--brand-light); font-weight: 600; }
.proj-filter__chip:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
/* 过滤空态的"清除筛选"出口(过滤无结果 ≠ 暂无项目,要能一键回到全部) */
.proj-filter__clear {
  margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--brand-text);
  background: var(--brand-light); border: 1px solid var(--brand); border-radius: var(--radius-pill);
  padding: 3px 12px; cursor: pointer; transition: all var(--t-fast);
}
.proj-filter__clear:hover { background: var(--brand); color: #fff; }
.proj-status {
  font-style: normal; font-size: var(--fs-2xs); font-weight: 600; line-height: 1;
  padding: 3px 8px; border-radius: var(--radius-pill); cursor: pointer; flex-shrink: 0;
  transition: transform var(--t-fast);
}
.proj-status:hover { transform: scale(1.06); }
.proj-status:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.proj-status--active { color: var(--brand-text); background: var(--brand-light); }
.proj-status--paused { color: var(--warn); background: rgba(230, 162, 60, .12); }
.proj-status--done { color: var(--ok, #2e9e44); background: rgba(46, 158, 68, .1); }
.proj-status--cancelled { color: var(--text-3); background: var(--gray-bg); }
.proj-load {
  font-variant-numeric: tabular-nums; color: var(--text-3); background: var(--gray-bg);
  padding: 1px 7px; border-radius: var(--radius-pill);
}
.proj-load--warn { color: var(--warn); background: rgba(230, 162, 60, .12); font-weight: 600; }
</style>
