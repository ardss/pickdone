<template>

  <div class="page projects-page">
    <div class="proj-toolbar">
      <span class="proj-toolbar__tip">{{ $t('statsB.ProjectsView.toolbarTip') }}</span>
      <button class="proj-new-btn" @click="createProject"><app-icon name="plus" :size="12"/> {{ $t('statsB.ProjectsView.newProject') }}</button>
    </div>
    <div class="page__main page__main--flow-top">
      <div v-if="projects.length" class="proj-grid">
        <div v-for="p in projects" :key="p.cat.categoryId" class="proj-card" role="link" tabindex="0"
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
            <span>{{ $t('statsB.ProjectsView.tasks', { done: p.stats.doneCount, total: p.stats.total }) }}</span>
            <span :title="$t('statsB.ProjectsView.focusTip')">{{ $t('statsB.ProjectsView.focusMin', { n: p.stats.focusMinutes }) }}</span>
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
      <div v-if="!projects.length" class="empty">
        <div class="empty__icon"></div>
        <div class="empty__text">{{ $t('statsB.ProjectsView.empty') }}</div>
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
  computed: {
    projects () {
      return this.$store.getters['category/projects'].map(c => {
        const meta = (this.$store.getters['category/projectMeta'])[c.categoryId] || {}
        return {
          cat: c,
          stats: projectStats(this.$store.state.todo.todoList.filter(t => t.categoryId === c.categoryId), this.$store.state.todo.todayTimestamp),
          deadline: meta.deadline || 0,
          nextMs: meta.nextMilestone || null
        }
      })
    }
  },
  methods: {
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
        this.$store.commit('category/addCategory', { categoryName: name })
        const list = this.$store.state.category.list
        const created = list[list.length - 1]
        this.$store.commit('category/setProject', { id: created.categoryId, flag: true })
        this.$message.success(this.$t('statsB.ProjectsView.created', { name }))
      } catch { /* cancelled */ }
    }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
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
</style>
