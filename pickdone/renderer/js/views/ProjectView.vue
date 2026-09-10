<template>

  <div class="page project-page" :key="catId">
    <div v-if="cat" class="proj-head">
      <div class="proj-head__title">
        <span class="sn-dot" :style="{borderColor:cat.categoryColor, background:cat.categoryColor}"></span>
        <span class="proj-head__name">{{cat.categoryName}}</span>
        <span v-if="deadlineTs" class="proj-head__dl" :class="{'proj-head__dl--over': daysLeft < 0}"
              :title="$t('statsB.ProjectView.deadlineTip', { d: fmtDate(deadlineTs) })">{{daysLeft >= 0 ? $t('statsB.ProjectView.daysLeftText', { n: daysLeft }) : $t('statsB.ProjectView.overdueDays', { n: -daysLeft })}}</span>
        <el-select class="proj-head__status" size="small" :model-value="projStatus"
                   :aria-label="$t('projQ.statusAria', { s: $t(statusKey(projStatus)) })" @change="setStatus">
          <el-option v-for="s in statusOptions" :key="s" :value="s" :label="$t(statusKey(s))"/>
        </el-select>
        <em class="proj-head__pct">{{stats.progress}}%</em>
        <el-dropdown trigger="click" @command="cmd => cmd && cmd()">
          <button class="proj-head__menu" :title="$t('statsB.ProjectView.settingsTip')" :aria-label="$t('statsB.ProjectView.settingsTip')"><app-icon name="dots" :size="15"/></button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item :command="renameProject">{{ $t('statsB.ProjectView.rename') }}</el-dropdown-item>
              <el-dropdown-item :command="setDeadline">{{ deadlineTs ? $t('statsB.ProjectView.changeDeadline') : $t('statsB.ProjectView.setDeadline') }}</el-dropdown-item>
              <el-dropdown-item v-if="deadlineTs" :command="clearDeadline" divided>{{ $t('statsB.ProjectView.clearDeadline') }}</el-dropdown-item>
              <el-dropdown-item :command="removeFromProject" divided>{{ $t('statsB.ProjectView.unproject') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
      <div class="proj-head__bar"><i :style="{width: stats.progress + '%', background: cat.categoryColor || 'var(--brand)'}"></i></div>
      <div class="proj-head__meta">
        <span>{{ $t('statsB.ProjectView.startedOn', { d: fmtDate(stats.startedAt) }) }}</span>
        <span>{{ $t('statsB.ProjectView.tasks', { done: stats.doneCount, total: stats.total }) }}</span>
        <span :title="$t('statsB.ProjectView.focusTip')">{{ $t('statsB.ProjectView.focusMin', { n: stats.focusMinutes }) }}</span>
        <span v-if="stats.lastActivity">{{ $t('statsB.ProjectView.lastActive', { d: fmtDate(stats.lastActivity) }) }}</span>
        <span v-if="trend7.some(d => d.n > 0)" class="proj-head__trend" :title="$t('statsB.ProjectView.trendTip', { list: trend7.map(d => d.label + ' ' + d.n).join($t('statsI.ProjectView.listSep')) })">
          <i v-for="(d, i) in trend7" :key="i" class="proj-trend-bar"
             :style="{height: Math.max(2, Math.min(14, d.n * 3)) + 'px'}" :data-label="d.label"></i>
        </span>
        <span class="proj-head__colorrow">
          {{ $t('statsB.ProjectView.recolor') }}
          <i v-for="c in colorPalette" :key="c" role="button" tabindex="0" class="proj-head__swatch"
             :class="{active: cat.categoryColor === c}" :style="{background: c}"
             :aria-label="$t('statsB.ProjectView.swatchAria', { c })" @click="setColor(c)" @keydown.enter.prevent="setColor(c)"></i>
        </span>
      </div>
      <!-- Milestone timeline v2: solid past / dashed future + today line across + node bubbles (hover/focus reveals title and date); click node = edit, deletion in the card below -->
      <div class="proj-ms">
        <div class="proj-ms__track">
          <i class="proj-ms__seg proj-ms__seg--past" :style="{ left: 0, width: timeline.todayPct + '%' }" aria-hidden="true"></i>
          <i class="proj-ms__seg proj-ms__seg--future" :style="{ left: timeline.todayPct + '%', right: 0 }" aria-hidden="true"></i>
          <i class="proj-ms__today" :style="{ left: timeline.todayPct + '%' }" aria-hidden="true"></i>
          <i v-for="m in timeline.marks" :key="(m.type==='start'?'s':m.type==='today'?'t':m.type==='deadline'?'d':m.id)" class="proj-ms__mark" :class="['proj-ms__mark--' + m.type, { 'proj-ms__mark--new': m.ms && m.ms.id === msNewId }]"
             :style="{ left: m.pct + '%' }" :data-tip="m.label"
             :role="m.ms ? 'button' : null" :tabindex="m.ms ? 0 : null" :aria-label="m.label"
             @click="m.ms && editMilestone(m.ms)"
             @keydown.enter.prevent="m.ms && editMilestone(m.ms)">
            <template v-if="m.type==='done' || (m.ms && m.state==='done')">✓</template>
            <template v-else-if="m.type==='deadline'">⚑</template>
            <template v-else-if="m.type==='start' || m.type==='today'">◦</template>
            <template v-else>◆</template>
          </i>
        </div>
        <button class="proj-ms__add" :title="$t('statsB.ProjectView.addMsTip')" @click="addMilestone"><app-icon name="plus" :size="11"/> {{ $t('statsB.ProjectView.milestone') }}</button>
      </div>
      <!-- Milestone strip: slim rail at the bottom edge of the timeline, one dot per milestone ordered by date (past filled/dimmed, upcoming hollow); hover popover = date + linked-task progress; click = edit (same as timeline nodes) -->
      <div v-if="msStrip.length" class="proj-ms-strip" role="group" :aria-label="$t('projQ.stripAria')">
        <i v-for="r in msStrip" :key="r.m.id" class="proj-ms-strip__dot" :class="['proj-ms-strip__dot--' + r.state, { 'proj-ms-strip__dot--focus': r.focus }]"
           role="button" tabindex="0" :aria-label="r.m.title + ' · ' + fmtDate(r.m.date)"
           @click="editMilestone(r.m)" @keydown.enter.prevent="editMilestone(r.m)">
          <span class="proj-ms-strip__pop" role="tooltip">
            <b class="proj-ms-strip__title">{{r.m.title}}</b>
            <span class="proj-ms-strip__date">{{fmtDate(r.m.date)}}</span>
            <span v-if="r.progress" class="proj-ms-strip__prog">{{ $t('projQ.stripProgress', { done: r.progress.done, total: r.progress.total }) }}</span>
            <span v-else class="proj-ms-strip__prog proj-ms-strip__prog--none">{{ $t('projQ.stripNoTasks') }}</span>
            <span v-for="(t, ti) in r.titles" :key="ti" class="proj-ms-strip__task">{{t}}</span>
            <span v-if="r.moreN" class="proj-ms-strip__more">{{ $t('projQ.stripMore', { n: r.moreN }) }}</span>
            <span class="proj-ms-strip__hint">{{ $t('projQ.stripEditHint') }}</span>
          </span>
        </i>
      </div>
      <div v-if="!milestones.length" class="proj-ms__empty">{{ $t('statsB.ProjectView.msEmptyTip') }}</div>
      <!-- Milestone card: ring progress (linked task completion ratio) + plain-words countdown + status color; click card = edit -->
      <div v-if="milestoneRows.length" class="proj-ms-list">
        <div v-for="r in milestoneRows" :key="r.m.id" class="proj-ms-row" :class="{'proj-ms-row--soon': r.due !== 'ok' && r.state !== 'done'}"
             role="button" tabindex="0" :aria-label="r.m.title" @click="editMilestone(r.m)" @keydown.enter.prevent="editMilestone(r.m)">
          <svg class="ms-ring" viewBox="0 0 36 36" width="30" height="30" role="img"
               :aria-label="$t('statsB.ProjectView.linkProgress', { done: r.progress ? r.progress.done : 0, total: r.progress ? r.progress.total : 0 })">
            <circle class="ms-ring__track" cx="18" cy="18" r="15.5" fill="none"/>
            <circle class="ms-ring__bar" :class="{'ms-ring__bar--done': r.state === 'done'}" cx="18" cy="18" r="15.5" fill="none"
                    :stroke-dasharray="String(2 * Math.PI * 15.5)" :stroke-dashoffset="String(2 * Math.PI * 15.5 * (1 - r.ringPct / 100))"/>
            <text x="18" y="22" text-anchor="middle" class="ms-ring__num">{{ r.ringPct }}%</text>
          </svg>
          <div class="proj-ms-row__main">
            <div class="proj-ms-row__line">
              <span class="proj-ms-row__title">{{r.m.title}}</span>
              <em v-if="r.focus" class="proj-ms-row__tag">{{ $t('statsB.ProjectView.now') }}</em>
              <em v-if="r.state !== 'done' && r.due === 'overdue'" class="proj-ms-row__tag proj-ms-row__tag--danger">{{ r.countdown.text }}</em>
              <em v-else-if="r.state !== 'done' && r.countdown.text" class="proj-ms-row__tag" :class="'proj-ms-row__tag--' + r.countdown.tone">{{ r.countdown.text }}</em>
            </div>
            <div class="proj-ms-row__line proj-ms-row__line--sub">
              <span class="proj-ms-row__date">{{fmtDate(r.m.date)}}</span>
              <span v-if="r.linkedN" class="proj-ms-row__linked">{{ $t('statsB.ProjectView.linkedN', { n: r.linkedN }) }}</span>
              <span v-if="r.progress" class="proj-ms-row__frac">{{r.progress.done}}/{{r.progress.total}}</span>
            </div>
          </div>
          <div class="proj-ms-row__ops">
            <button class="proj-ms-row__link" :title="$t('statsB.ProjectView.linkTasks')" @click.stop="toggleMsExpand(r.m.id)">{{ $t('statsB.ProjectView.linkTasks') }}</button>
            <button class="proj-ms-row__del" :title="$t('statsB.ProjectView.delMsTip')" :aria-label="$t('statsB.ProjectView.delMsTip')" @click.stop="removeMilestone(r.m)"><app-icon name="x" :size="11"/></button>
          </div>
        </div>
        <div v-for="r in milestoneRows" :key="'x' + r.m.id" v-show="msExpanded[r.m.id]" class="proj-ms-tasks">
          <div class="proj-ms-tasks__tip">{{ $t('statsB.ProjectView.msTasksTip') }}</div>
          <label v-for="t in inCat.filter(t => !t.delete)" :key="t.taskId" class="proj-ms-tasks__item">
            <input type="checkbox" :checked="(r.m.taskIds || []).includes(t.taskId)" @change="toggleMsTask(r.m, t.taskId)"/>
            <span :class="{done: t.complete}">{{t.taskContent}}</span>
          </label>
        </div>
      </div>
    </div>
    <div class="proj-tabs" role="tablist">
      <button class="proj-tab" :class="{on: tab === 'overview'}" role="tab" :aria-selected="tab === 'overview'" @click="tab = 'overview'">{{ $t('statsB.ProjectView.tabOverview') }}</button>
      <!-- Deps tab rides the same two-layer gate as the today deps view (developerMode && showDepsModule) -->
      <button v-if="settings.developerMode && settings.showDepsModule" class="proj-tab" :class="{on: tab === 'deps'}" role="tab" :aria-selected="tab === 'deps'" @click="tab = 'deps'">{{ $t('statsB.ProjectView.tabDeps') }}</button>
      <button class="proj-tab" :class="{on: tab === 'docs'}" role="tab" :aria-selected="tab === 'docs'" @click="tab = 'docs'">{{ $t('statsB.ProjectView.tabDocs') }}</button>
    </div>
    <div v-if="tab === 'deps' && settings.developerMode && settings.showDepsModule" class="page__main page__main--flow-top proj-tab-body">
      <pd-dep-view :fixed-project-id="catId"/>
    </div>
    <div v-else-if="tab === 'docs'" class="page__main page__main--flow-top proj-tab-body">
      <project-docs :cat-id="catId"/>
    </div>
    <div v-else class="page__main page__main--flow-top">
      <div v-if="!groups.length" class="empty">
        <div class="empty__icon"></div>
        <div class="empty__text">{{ $t('statsB.ProjectView.empty') }}</div>
      </div>
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
 * Project view (route todo-list-project /project/:id)
 * Project = a category flagged as a project (category/projectIds, persisted via meta).
 * The header answers four questions: when it started (earliest task creation time) / how it progresses (progress bar) / how much was invested (focus minutes = sum of estimate) / when it was last advanced.
 * Task list reuses the category list view's grouping semantics (past completed/expired uncompleted/today/tomorrow/day after tomorrow/later/no date) + a fully collapsed final "completed" group.
 */
import {dayjs, DAY_MS, rescheduleExpired, FMT, rangeLabel , rangeDays } from '../utils/core.js'
import { batchMoveWithUndo } from '../utils/confirm.js'
import { calTitle } from '../utils/buckets.js'
import { loadMilestones, saveMilestones, parseMilestoneDate, milestoneState, milestoneProgress, dueStateOf, newMilestoneId } from '../utils/milestones.js'
import { COLOR_PALETTE } from '../store/category.js'
import { PROJECT_STATUSES, statusI18nKey } from '../utils/projectStatus.js'
import TodoGroupBlock from '../components/TodoGroupBlock.vue'
import DepView from '../components/DepView.vue'
import ProjectDocs from '../components/ProjectDocs.vue'

// [navgate-fix] pure-start (extracted by tests/unit-navgate-fix-ui.test.mjs)
/** Entrance-animation target for a freshly added milestone: saveMilestones returns the list sorted
 *  by date, so "last of saved" can be an older entry — resolve the new node by its own
 *  pre-generated id instead, and degrade to null if the save dropped it */
function resolveMsNewId (entryId, saved) {
  return (Array.isArray(saved) && saved.some(m => m && m.id === entryId)) ? entryId : null
}
// [navgate-fix] pure-end

export default {
  name: 'ProjectView',
  components: { GroupBlock: TodoGroupBlock, PdDepView: DepView, ProjectDocs },
  data () {
    return {
      tab: 'overview',
      collapsedMap: { catExpDone: true, catExpUndo: false, catToday: false, catTomorrow: false, catDat: false, catUpcoming: false, catNoDate: false, projDone: true },
      milestones: [] as any,
      deadlineTs: 0,
      colorPalette: COLOR_PALETTE,
      msExpanded: {} as any,
      msNewId: null as any
    }
  },
  created () { this.reloadMilestones(); this.reloadDeadline() },
  watch: {
    // Navigating project -> project reuses this component instance: the root :key re-keys a plain
    // div only (no remount), so created() never runs again and the per-project data would go stale
    '$route.params.id' (nval) {
      if (!nval) return
      this.reloadMilestones()
      this.reloadDeadline()
    }
  },
  computed: {
    catId () { return Number(this.$route.params.id) || 0 },
    cat () { return this.$store.getters['category/byId'](this.catId) },
    settings () { return this.$store.state.settings },
    todayTs () { return this.$store.state.todo.todayTimestamp },
    /* ---- Lifecycle status (meta projectStatus:<id>, contract shared with the CLI); selector sits next to the deadline pill ---- */
    statusOptions () { return PROJECT_STATUSES },
    projStatus () { return this.$store.getters['category/projectStatus'](this.catId) },
    /* ---- Deadline (meta projectDeadline:<id>, same source as the CLI); daysLeft<0 means overdue ---- */
    daysLeft () {
      if (!this.deadlineTs) return null
      return Math.ceil((this.deadlineTs - this.todayTs) / DAY_MS)
    },
    /* ---- N2 milestone management rows: once tasks are linked, progress = linked task completion ratio (Linear style); otherwise purely date-driven ---- */
    milestoneRows () {
      const live = this.inCat.filter(t => !t.delete)
      return this.milestones.map(m => {
        const state = milestoneState(m, this.todayTs)
        const progress = milestoneProgress(m, live)
        return {
          m,
          state,
          focus: this.currentMilestone && this.currentMilestone.id === m.id && state !== 'done',
          due: dueStateOf(m.date, this.todayTs),
          progress,
          linked: (m.taskIds || []).map(id => live.find(t => t.taskId === id)).filter(Boolean),
          // Countdown (in plain words): due today / due tomorrow / N days left / overdue by N days; hidden when done
          countdown: this.countdownOf(m, state),
          ringPct: progress ? progress.pct : 0,
          linkedN: (m.taskIds || []).length
        }
      })
    },
    /* ---- Milestone strip (bottom rail under the timeline): dots ordered by date; reuses milestoneRows state/progress/linked tasks, no extra fetches ---- */
    msStrip () {
      if (!this.milestoneRows.length) return []
      return [...this.milestoneRows]
        .sort((a, b) => a.m.date - b.m.date)
        .map(r => ({
          m: r.m,
          state: r.state,
          focus: r.focus,
          progress: r.progress,
          titles: r.linked.slice(0, 5).map(t => t.taskContent),
          moreN: Math.max(0, r.linked.length - 5)
        }))
    },
    /* ---- N3 proximity alert: deadline within 3 days turns warning color ---- */
    deadlineState () { return this.deadlineTs ? dueStateOf(this.deadlineTs, this.todayTs) : 'ok' },
    /* ---- N4 last-7-days completion mini trend (completedAt distribution, today at the far right) ---- */
    trend7 () {
      const days = []
      for (let i = 6; i >= 0; i--) {
        const d0 = this.todayTs - i * DAY_MS
        const d1 = d0 + DAY_MS
        days.push({
          n: this.inCat.filter(t => t.complete && t.completedAt >= d0 && t.completedAt < d1).length,
          label: i === 0 ? this.$t('statsB.ProjectView.today') : dayjs(d0).format('MM-DD')
        })
      }
      return days
    },
    /* ---- Milestone timeline: projects start/today/milestones onto the same horizontal axis (positioned proportionally by date) ---- */
    currentMilestone () {
      // Current focus = the nearest future milestone (Linear mode: one glance shows which stage you're at)
      const t = this.todayTs
      return this.milestones.filter(m => m.date >= t)[0] || null
    },
    timeline () {
      const ms = this.milestones
      const start = this.stats.startedAt || this.todayTs
      const bounds = [this.todayTs, start, this.deadlineTs].filter(Boolean).concat(ms.map(m => m.date))
      const lo = Math.min(...bounds)
      const hi = Math.max(...bounds)
      const span = Math.max(hi - lo, DAY_MS) // span of at least one day to avoid division by zero
      const pos = ts => Math.min(98, Math.max(2, (ts - lo) / span * 100))
      const cur = this.currentMilestone
      return {
        todayPct: pos(this.todayTs),
        marks: [
          { type: 'start', pct: pos(start), label: this.$t('statsB.ProjectView.startWith', { d: this.fmtDate(start) }) },
          ...ms.map(m => {
            const state = milestoneState(m, this.todayTs)
            const focus = cur && cur.id === m.id && state !== 'done'
            return {
              type: focus ? 'focus' : state,
              id: m.id,
              pct: pos(m.date),
              label: (focus ? this.$t('statsB.ProjectView.currentTag') : '') + m.title + ' · ' + this.fmtDate(m.date) + this.$t('statsB.ProjectView.msEditHint'),
              ms: m
            }
          }),
          ...(this.deadlineTs ? [{ type: 'deadline', pct: pos(this.deadlineTs), label: this.$t('statsB.ProjectView.deadlineWith', { d: this.fmtDate(this.deadlineTs) }) }] : []),
          { type: 'today', pct: pos(this.todayTs), label: this.$t('statsB.ProjectView.today'), tip: this.$t('statsB.ProjectView.today') }
        ]
      }
    },
    inCat () {
      const id = this.catId
      return this.$store.state.todo.todoList.filter(t => t.categoryId === id)
    },
    /* ---- Header's four questions ---- */
    stats () {
      const list = this.inCat
      const done = list.filter(t => t.complete)
      const live = list.filter(t => !t.delete)
      const startedAt = live.reduce((m, t) => Math.min(m, t.createTime || m), Infinity)
      const lastAct = done.reduce((m, t) => Math.max(m, t.completedAt || 0), 0)
      return {
        total: live.length,
        doneCount: done.length,
        progress: live.length ? Math.round(done.length / live.length * 100) : 0,
        focusMinutes: live.reduce((s, t) => s + (t.estimate || 0), 0),
        startedAt: isFinite(startedAt) ? startedAt : 0,
        lastActivity: lastAct
      }
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
      if (expDone.length) g.push({ key: 'catExpDone', title: this.$t('statsB.ProjectView.expDoneTitle', { r: rangeLabel(s.expiredCompletedTodoRange, this.$t) }), todos: expDone, showDate: true, hasSettings: true })
      const expUndo = bucket(t => !t.complete && t.dayStart && t.dayStart < today && t.dayStart >= today - R2 * DAY_MS).sort((a, b) => a.dayStart - b.dayStart)
      if (expUndo.length) g.push({ key: 'catExpUndo', title: this.$t('statsB.ProjectView.expUndoTitle', { r: rangeLabel(s.expiredUncompletedTodoRange, this.$t) }), todos: expUndo, showDate: true, color: 'color2', hasSettings: true, hasRecomplete: true })
      const td = bucket(t => !t.complete && t.dayStart === today)
      if (td.length) g.push({ key: 'catToday', title: this.calTitle(today), todos: td, color: 'color3' })
      const tm = bucket(t => t.dayStart === today + DAY_MS)
      if (tm.length) g.push({ key: 'catTomorrow', title: this.calTitle(today + DAY_MS), todos: tm, color: 'color3' })
      const dat = bucket(t => t.dayStart === today + 2 * DAY_MS)
      if (dat.length) g.push({ key: 'catDat', title: this.calTitle(today + 2 * DAY_MS), todos: dat, color: 'color3' })
      const up = bucket(t => !t.complete && t.dayStart > today + 2 * DAY_MS)
      if (up.length) g.push({ key: 'catUpcoming', title: this.$t('statsB.ProjectView.upcoming'), todos: up, showDate: true, color: 'color3', hasSettings: true })
      const nd = bucket(t => !t.complete && !t.dayStart)
      if (nd.length) g.push({ key: 'catNoDate', title: this.$t('statsB.ProjectView.noDate'), todos: nd, hasSettings: true })
      // Final group: all completed in the project (collapsed by default; the "past completed" group above only covers the last N days, this is the full-set fallback)
      const allDone = bucket(t => t.complete)
      if (allDone.length) g.push({ key: 'projDone', title: this.$t('statsB.ProjectView.done'), todos: allDone, showDate: true })
      return g
    }
  },
  methods: {
    calTitle (ts) { return calTitle(ts) },
    statusKey (s) { return statusI18nKey(s) },
    setStatus (status) {
      if (!status) return
      this.$store.commit('category/setProjectStatus', { id: this.catId, status })
    },
    /** Countdown in plain words: due today / due tomorrow / N days left / overdue by N days; returns empty when done (the card shows the done state) */
    countdownOf (m, state) {
      if (state === 'done') return { text: this.$t('statsB.ProjectView.done'), tone: 'done', days: 0 }
      const days = Math.ceil((m.date - this.todayTs) / DAY_MS)
      if (days === 0) return { text: this.$t('statsB.ProjectView.dueToday'), tone: 'warn', days: 0 }
      if (days === 1) return { text: this.$t('statsB.ProjectView.dueTomorrow'), tone: 'warn', days: 1 }
      if (days > 1) return { text: this.$t('statsB.ProjectView.daysLeftN', { n: days }), tone: 'ok', days }
      return { text: this.$t('statsB.ProjectView.overdueN', { n: -days }), tone: 'danger', days }
    },
    fmtDate (ts) { return ts ? dayjs(ts).format(FMT.date) : '—' },
    setCol (key, val) { this.collapsedMap[key] = val },
    async reloadMilestones () { this.milestones = await loadMilestones(this.catId) },
    async reloadDeadline () {
      try { this.deadlineTs = Number(await window.todoAPI.dbCall('getMeta', 'projectDeadline:' + this.catId)) || 0 } catch { this.deadlineTs = 0 }
    },
    /** Add milestone: two prompts, title + date (supports YYYY-MM-DD / MM-DD / today / +Nd) */
    async addMilestone () {
      try {
        const { value: title } = await this.$prompt(this.$t('statsB.ProjectView.msPrompt'), this.$t('statsB.ProjectView.msAddTitle'), { inputValue: '', inputPlaceholder: this.$t('statsB.ProjectView.msPhExample'), inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.titleRequired') })
        if (!title || !title.trim()) return
        const { value: dateInput } = await this.$prompt(this.$t('statsB.ProjectView.datePrompt'), this.$t('statsB.ProjectView.datePromptTitle'), { inputValue: '', inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.dateRequired') })
        const date = parseMilestoneDate(dateInput)
        if (!date) return this.$message.warning(this.$t('statsB.ProjectView.badDateAdd'))
        // Pre-generate the id (saveMilestones keeps caller-supplied ids): the entrance animation must
        // target the just-added entry, not whichever entry happens to carry the latest date
        const entry = { id: newMilestoneId(), title: title.trim(), date }
        const saved = saveMilestones(this.catId, [...this.milestones, entry])
        this.milestones = saved
        this.msNewId = resolveMsNewId(entry.id, saved) // entrance animation for the new node
        setTimeout(() => { this.msNewId = null }, 1200)
        this.$message.success(this.$t('statsB.ProjectView.msAdded'))
      } catch { /* cancelled */ }
    },
    /** Edit milestone (double-click the diamond): title and date in two steps, prefilled with original values */
    async editMilestone (m) {
      try {
        const { value: title } = await this.$prompt(this.$t('statsB.ProjectView.msContent'), this.$t('statsB.ProjectView.msEditTitle'), { inputValue: m.title, inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.titleRequired') })
        if (!title || !title.trim()) return
        const { value: dateInput } = await this.$prompt(this.$t('statsB.ProjectView.datePrompt'), this.$t('statsB.ProjectView.datePromptTitle'), { inputValue: dayjs(m.date).format(FMT.date), inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.dateRequired') })
        const date = parseMilestoneDate(dateInput)
        if (!date) return this.$message.warning(this.$t('statsB.ProjectView.badDateEdit'))
        this.milestones = saveMilestones(this.catId, this.milestones.map(x => x.id === m.id ? { ...x, title: title.trim(), date } : x))
        this.$message.success(this.$t('statsB.ProjectView.msUpdated'))
      } catch { /* cancelled */ }
    },
    async removeMilestone (m) {
      try { await this.$confirm(this.$t('statsB.ProjectView.msRemoveConfirm', { title: m.title }), this.$t('statsB.ProjectView.tip'), { type: 'warning' }) } catch { return }
      this.milestones = saveMilestones(this.catId, this.milestones.filter(x => x.id !== m.id))
    },
    toggleMsExpand (id) { this.msExpanded = { ...this.msExpanded, [id]: !this.msExpanded[id] } },
    /** Link/unlink tasks to a milestone (N2): progress grows automatically with the task completion ratio */
    toggleMsTask (ms, taskId) {
      const ids = new Set(ms.taskIds || [])
      ids.has(taskId) ? ids.delete(taskId) : ids.add(taskId)
      this.milestones = saveMilestones(this.catId, this.milestones.map(x => x.id === ms.id ? { ...x, taskIds: [...ids] } : x))
    },
    /* ---- Project editing (the ... menu; same data path as CLI/manage categories) ---- */
    async renameProject () {
      try {
        const { value } = await this.$prompt(this.$t('statsB.ProjectView.namePrompt'), this.$t('statsB.ProjectView.renameTitle'), { inputValue: this.cat.categoryName, inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.nameRequired') })
        const name = (value || '').trim()
        if (!name || name === this.cat.categoryName) return
        this.$store.commit('category/updateCategory', { categoryId: this.catId, categoryName: name })
        this.$message.success(this.$t('statsB.ProjectView.renamed'))
      } catch { /* cancelled */ }
    },
    setColor (color) {
      this.$store.commit('category/updateCategory', { categoryId: this.catId, categoryColor: color })
    },
    async setDeadline () {
      try {
        const { value } = await this.$prompt(this.$t('statsB.ProjectView.deadlinePrompt'), this.$t('statsB.ProjectView.deadlineTitle'), {
          inputValue: this.deadlineTs ? dayjs(this.deadlineTs).format(FMT.date) : '', inputPattern: /\S/, inputErrorMessage: this.$t('statsB.ProjectView.dateRequired')
        })
        const date = parseMilestoneDate(value)
        if (!date) return this.$message.warning(this.$t('statsB.ProjectView.badDate'))
        this.deadlineTs = date
        try { window.todoAPI.dbCall('setMeta', ['projectDeadline:' + this.catId, String(date)]).catch(() => {}) } catch { /* degraded to in-memory only */ }
        this.$store.dispatch('category/loadProjectMeta')
        this.$message.success(this.$t('statsB.ProjectView.deadlineSet'))
      } catch { /* cancelled */ }
    },
    clearDeadline () {
      this.deadlineTs = 0
      try { window.todoAPI.dbCall('setMeta', ['projectDeadline:' + this.catId, '0']).catch(() => {}) } catch { /* degraded */ }
      this.$store.dispatch('category/loadProjectMeta')
      this.$message.success(this.$t('statsB.ProjectView.deadlineCleared'))
    },
    async removeFromProject () {
      try { await this.$confirm(this.$t('statsB.ProjectView.unprojectConfirm', { name: this.cat.categoryName }), this.$t('statsB.ProjectView.tip'), { type: 'warning' }) } catch { return }
      this.$store.commit('category/setProject', { id: this.catId, flag: false })
      this.$message.success(this.$t('statsB.ProjectView.restored'))
      this.$router.push({ name: 'todo-list-projects' }).catch(() => {})
    },
    /** "Reschedule": expired uncompleted in this project -> today */
    async recomplete () {
      const ts = this.todayTs
      const { n, snap }: any = await rescheduleExpired(this.$store.dispatch, this.inCat, ts)
      if (n) batchMoveWithUndo(this, {
        label: this.$t('statsB.ProjectView.rescheduled'),
        snap,
        revertOf: r => this.$store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { dayStart: r.dayStart, todoTime: r.todoTime } })
      })
    }
  },

}
</script>
<style>
/* ==================== 项目视图（渐进披露：有项目才出现入口与页头） ==================== */
/* 项目页头：名称/进度百分比/进度条/四问元信息 */
.proj-head {
  padding: 14px 28px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--hover-bg);
}
.proj-head__title { display: flex; align-items: center; gap: var(--space-2); }
.proj-head__name { font-size: var(--fs-lg); font-weight: 600; color: var(--text-1); }
.proj-head__pct { font-style: normal; margin-left: auto; font-size: var(--fs-md); font-weight: 600; color: var(--text-2); }
.proj-head__bar {
  height: 4px; margin-top: var(--space-2); border-radius: var(--radius-xs);
  background: var(--track-bg); overflow: hidden;
}
.proj-head__bar i { display: block; height: 100%; border-radius: var(--radius-xs); transition: width var(--t-slow); }
.proj-head__meta {
  display: flex; gap: var(--space-4); margin-top: var(--space-2);
  font-size: var(--fs-xs); color: var(--text-3);
}
.proj-card .proj-head__bar { margin-top: 10px; }
/* 里程碑时间轴（项目详情页头）：起点◇已过实心◆今天高亮未来空心，按日期比例定位 */
/* ===== 里程碑 v2：时间轴（今天贯穿线/过去实线/未来虚线/节点气泡）+ 卡片（环形进度/倒计时/状态色） ===== */
.proj-ms { display: flex; align-items: center; gap: 10px; margin-top: var(--space-3); }
.proj-ms__track { position: relative; flex: 1; height: 22px; }
.proj-ms__seg { position: absolute; top: 50%; height: 2px; margin-top: -1px; }
.proj-ms__seg--past { left: 0; background: var(--brand); opacity: .55; }
.proj-ms__seg--future { right: 0; background: repeating-linear-gradient(90deg, var(--line-strong) 0 6px, transparent 6px 11px); }
.proj-ms__today { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--brand); border-radius: 1px; }
.proj-ms__mark {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  font-style: normal; font-size: var(--fs-xs); line-height: 1; cursor: default;
  color: var(--text-4); transition: color var(--t-fast), transform var(--t-fast), background var(--t-fast);
  z-index: 1;
}
.proj-ms__mark--done { color: var(--ok, #2e9e44); font-weight: 700; }
.proj-ms__mark--today { color: var(--brand-dark); font-size: var(--fs-md); font-weight: 700; }
.proj-ms__mark--future { color: var(--text-3); }
.proj-ms__mark--deadline { color: var(--warn); font-size: var(--fs-md); }
.proj-ms__mark--focus { color: var(--brand); font-size: var(--fs-md); font-weight: 700; }
.proj-ms__mark[role="button"] { cursor: pointer; }
.proj-ms__mark--new { animation: proj-ms-pop .45s cubic-bezier(.34, 1.56, .64, 1) both; }
/* 悬停提示走标准浮层语言:面板底+描边+阴影(token 管理,深浅色自动适配),弃用旧反色黑底 */
.proj-ms__mark[role="button"]::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%) scale(.96);
  background: var(--panel, #fff); color: var(--text-1, #222); border: 1px solid var(--line, #e6e8eb);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .16); font-size: var(--fs-xs); white-space: nowrap;
  padding: 4px 9px; border-radius: var(--radius-sm); opacity: 0; pointer-events: none;
  transition: opacity var(--t-fast), transform var(--t-fast); z-index: 30;
}
.proj-ms__mark[role="button"]:hover, .proj-ms__mark[role="button"]:focus-visible { transform: translate(-50%, -50%) scale(1.25); }
.proj-ms__mark[role="button"]:hover::after, .proj-ms__mark[role="button"]:focus-visible::after { opacity: 1; transform: translateX(-50%) scale(1); }
.proj-ms__mark[role="button"]:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.proj-tab { padding: 7px 14px; border: none; background: transparent; color: var(--text-2, #555);
  font-size: var(--fs-sm, 13px); cursor: pointer; border-radius: var(--radius-sm, 6px) var(--radius-sm, 6px) 0 0;
  border-bottom: 2px solid transparent; transition: all var(--t-fast); }
.proj-tab:hover { color: var(--text-1, #222); background: var(--hover-bg, #f6f6f6); }
.proj-tab.on { color: var(--brand); border-bottom-color: var(--brand); font-weight: 600; }
.proj-tab-body { display: flex; flex-direction: column; min-height: 0; }
.proj-ms__add {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: var(--space-1);
  font-size: var(--fs-xs); color: var(--text-3);
  padding: 2px 8px; border-radius: var(--radius-sm); transition: all var(--t-fast);
}
.proj-ms__add:hover { color: var(--brand); background: var(--brand-light); }
.proj-ms__empty { margin-top: var(--space-2); font-size: var(--fs-xs); color: var(--text-3); }
/* ===== 里程碑横条（时间轴下沿）：一排按日期排序的细点，过去实心半透明/当天品牌色光环/未来空心；悬停 CSS 浮层显示日期+关联任务进度（复用既有浮层语言：面板底+描边+阴影） ===== */
.proj-ms-strip {
  position: relative; display: flex; align-items: center; justify-content: space-evenly;
  height: 16px; margin-top: var(--space-2); padding: 0 var(--space-2);
}
.proj-ms-strip::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px; margin-top: -1px; background: var(--line); }
.proj-ms-strip__dot {
  position: relative; display: block; width: 9px; height: 9px; border-radius: 50%;
  cursor: pointer; z-index: 1;
  transition: transform var(--t-fast), box-shadow var(--t-fast), opacity var(--t-fast);
}
.proj-ms-strip__dot--done { background: var(--ok, #2e9e44); opacity: .55; }
.proj-ms-strip__dot--today { background: var(--brand); box-shadow: 0 0 0 3px var(--brand-light); }
.proj-ms-strip__dot--future { background: transparent; border: 1.5px solid var(--text-4, #98a0a8); }
.proj-ms-strip__dot--focus { border-color: var(--brand); }
.proj-ms-strip__dot:hover, .proj-ms-strip__dot:focus-visible { transform: scale(1.35); opacity: 1; }
.proj-ms-strip__dot:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.proj-ms-strip__pop {
  position: absolute; bottom: calc(100% + 9px); left: 50%;
  display: flex; flex-direction: column; gap: 3px; width: max-content; max-width: 240px;
  padding: 8px 10px; border: 1px solid var(--line, #e6e8eb); border-radius: var(--radius-sm, 6px);
  background: var(--panel, #fff); box-shadow: 0 4px 14px rgba(0, 0, 0, .16);
  font-style: normal; font-size: var(--fs-xs); color: var(--text-2); text-align: left;
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateX(-50%) translateY(3px);
  transition: opacity var(--t-fast), transform var(--t-fast), visibility var(--t-fast);
  z-index: 30;
}
.proj-ms-strip__dot:hover .proj-ms-strip__pop, .proj-ms-strip__dot:focus-visible .proj-ms-strip__pop { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); }
.proj-ms-strip__title { font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ms-strip__date { color: var(--text-3); font-variant-numeric: tabular-nums; }
.proj-ms-strip__prog { color: var(--text-2); font-variant-numeric: tabular-nums; }
.proj-ms-strip__prog--none { color: var(--text-4); }
.proj-ms-strip__task { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ms-strip__task::before { content: '· '; }
.proj-ms-strip__more, .proj-ms-strip__hint { color: var(--text-4); }
.proj-ms-strip__hint { border-top: 1px dashed var(--line); padding-top: 4px; margin-top: 2px; }
/* 项目详情页编辑件：⋯菜单、截止日徽标、色板、截止旗标 */
.proj-head__title { position: relative; }
.proj-head__menu {
  margin-left: 6px; padding: 3px 6px; border-radius: var(--radius-sm);
  color: var(--text-3); transition: all var(--t-fast);
}
.proj-head__menu:hover { color: var(--brand); background: var(--brand-light); }
.proj-head__dl {
  font-size: var(--fs-xs); font-weight: 600; color: var(--brand-dark);
  padding: 2px 8px; border-radius: var(--radius-pill); background: var(--brand-light);
}
.proj-head__dl--over { color: var(--danger); background: var(--danger-soft); }
/* Lifecycle status selector (header, next to the deadline pill); width fixed so long labels don't shift the row */
.proj-head__status { width: 96px; flex-shrink: 0; }
.proj-head__colorrow { display: inline-flex; align-items: center; gap: 5px; }
.proj-head__swatch {
  width: 11px; height: 11px; border-radius: 50%; cursor: pointer;
  outline: 2px solid transparent; outline-offset: 1px; transition: outline-color var(--t-fast);
}
.proj-head__swatch:hover { transform: scale(1.2); }
.proj-head__swatch.active { outline-color: var(--text-3); }
/* 里程碑「当前聚焦」（Linear 式） */
.proj-ms__mark--focus { color: var(--brand); font-size: var(--fs-md); font-weight: 700; }
/* 里程碑卡片：环形进度 + 倒计时 + 关联任务数 */
.proj-ms-list { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 6px; }
.proj-ms-row {
  display: flex; align-items: center; gap: var(--space-3); padding: 8px 12px;
  border: 1px solid var(--line); border-radius: var(--radius-md, 10px); background: var(--panel, #fff);
  font-size: var(--fs-sm); cursor: pointer; transition: border-color var(--t-fast), box-shadow var(--t-fast);
}
.proj-ms-row:hover { border-color: var(--brand); box-shadow: 0 2px 10px rgba(17, 121, 121, .08); }
.proj-ms-row:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.proj-ms-row--soon { background: linear-gradient(90deg, rgba(230, 162, 60, .08), transparent 55%); }
.proj-ms-row__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.proj-ms-row__line { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.proj-ms-row__line--sub { font-size: var(--fs-xs); color: var(--text-3); }
.proj-ms-row__title { color: var(--text-1); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ms-row__date { flex-shrink: 0; }
.proj-ms-row__linked { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proj-ms-row__frac { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.proj-ms-row__tag { font-style: normal; font-size: var(--fs-2xs); color: var(--brand); background: var(--brand-light); padding: 1px 7px; border-radius: var(--radius-pill); flex-shrink: 0; }
.proj-ms-row__tag--warn { color: var(--warn); background: rgba(230, 162, 60, .12); }
.proj-ms-row__tag--danger { color: var(--danger); background: var(--danger-soft, rgba(214, 64, 54, .12)); }
.proj-ms-row__tag--ok { color: var(--ok, #2e9e44); background: rgba(46, 158, 68, .1); }
.proj-ms-row__ops { display: flex; align-items: center; gap: var(--space-1); flex-shrink: 0; opacity: 0; transition: opacity var(--t-fast); }
.proj-ms-row:hover .proj-ms-row__ops, .proj-ms-row:focus-within .proj-ms-row__ops { opacity: 1; }
.proj-ms-row__link, .proj-ms-row__del {
  flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-3);
  padding: 2px 7px; border-radius: var(--radius-sm); transition: all var(--t-fast);
}
.proj-ms-row__link:hover, .proj-ms-row__del:hover { color: var(--brand); background: var(--brand-light); }
.proj-ms-row__del:hover { color: var(--danger); }
.proj-ms-tasks { padding: 6px 10px 8px; margin: 2px 0 6px; background: var(--gray-bg); border-radius: var(--radius-sm); }
.proj-ms-tasks__tip { font-size: var(--fs-xs); color: var(--text-3); margin-bottom: 5px; }
.proj-ms-tasks__item { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; font-size: var(--fs-sm); color: var(--text-2); }
.proj-ms-tasks__item .done { text-decoration: line-through; color: var(--text-4); }
/* N4 近 7 天完成迷你趋势（页头元信息行内小柱） */
.proj-head__trend { display: inline-flex; align-items: flex-end; gap: 2px; height: 14px; }
.proj-trend-bar { display: inline-block; width: 3px; border-radius: 1px 1px 0 0; background: var(--brand); opacity: .55; }
.proj-trend-bar:last-child { opacity: 1; }
html[data-theme="dark"] .proj-head { background: rgba(255, 255, 255, .03); }
html[data-theme="dark"] .proj-ms__mark--today { color: var(--brand); }
html[data-theme="dark"] .proj-ms__seg--future { background: repeating-linear-gradient(90deg, #3a4048 0 6px, transparent 6px 11px); }
html[data-theme="dark"] .proj-head__dl--over { background: rgba(245, 108, 108, .15); }
html[data-theme="dark"] .proj-ms__mark--focus { color: var(--brand); }
@keyframes proj-ms-pop { from { transform: translate(-50%, -140%) scale(.4); opacity: 0 } to { transform: translate(-50%, -50%) scale(1); opacity: 1 } }
/* ---- B. 页头标题行（原 待办箱 a2d07ad4 / 已达成 7231d7ac / 回收站 12870041 合并）---- */
.title{display:flex;justify-content:space-between;line-height:28px}
.title__prepend{display:flex;gap:8px;align-items:center}
.title__text{font-size:16px}
.title__append{display:flex;align-items:center;gap:18px}
.title__append .icon-button>i{font-size:20px}
.title__prepend{display:flex;gap:var(--space-2);align-items:center}
.title__text{font-size:16px}
.title__append{display:flex;align-items:center;gap:18px}
.title__append .icon-button>i{font-size:20px}
/* 项目页页签:概览 / 依赖图 / 文档 */
.proj-tabs { display: flex; gap: 2px; margin-top: 10px; border-bottom: 1px solid var(--line, #e6e8eb); }
.ms-ring { flex-shrink: 0; }
.ms-ring__track { stroke: var(--track-bg, #eef0f2); stroke-width: 3.5; }
.ms-ring__bar { stroke: var(--brand); stroke-width: 3.5; stroke-linecap: round; transition: stroke-dashoffset var(--dur-slow) ease; transform: rotate(-90deg); transform-origin: 18px 18px; }
.ms-ring__bar--done { stroke: var(--ok, #2e9e44); }
.ms-ring__num { font-size: var(--fs-2xs); font-weight: 600; fill: var(--text-2); }
</style>
