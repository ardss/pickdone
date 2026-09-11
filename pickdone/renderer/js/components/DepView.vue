<template>
  <div class="depv-wrap" ref="wrap">
    <div class="depv-topbar">
      <div v-if="fixedProjectId == null" class="depv-filter" role="group" :aria-label="$t('statsA.DepView.filterLabel')">
        <button class="depv-chip" :class="{on: projectId === null}" :aria-pressed="projectId === null" @click="projectId = null">{{ $t('statsA.DepView.allProjects') }}</button>
        <button v-for="p in projects" :key="p.categoryId" class="depv-chip" :class="{on: projectId === p.categoryId}"
                :aria-pressed="projectId === p.categoryId"
                @click="projectId = p.categoryId">
          <span class="depv-chip-dot" :style="{background: p.categoryColor}"></span>{{ p.categoryName }}
        </button>
      </div>
      <button class="depv-chip" @click="tidyUp" :title="$t('statsA.DepView.tidyHint')">
        <app-icon name="locate" :size="12"/>{{ $t('statsA.DepView.tidy') }}
      </button>
      <span class="depv-hint">{{ $t('statsA.DepView.dragHint') }}</span>
    </div>

    <!-- 项目头:里程碑/截止/进度(里程碑与截止来自 projectMeta,进度从任务算) -->
    <div v-if="projectId != null && projectInfo" class="depv-proj">
      <span class="depv-chip-dot" :style="{background: projectInfo.color}"></span>
      <span class="depv-proj__name">{{ projectInfo.name }}</span>
      <span class="depv-proj__ms" :class="'depv-proj__ms--' + projectInfo.msState" v-if="projectInfo.msTitle">
        M{{ projectInfo.msIndex + 1 }} · {{ projectInfo.msTitle }} · {{ projectInfo.msDateLabel }}
      </span>
      <span class="depv-proj__noms" v-else>{{ msLoaded ? $t('statsA.DepView.noMilestone') : $t('statsA.DepView.msLoading') }}</span>
      <span class="depv-proj__dl" :class="{'depv-proj__dl--over': projectInfo.dlOver}" v-if="projectInfo.deadline">
        {{ $t('statsA.DepView.deadline') }} {{ projectInfo.dlLabel }}
      </span>
      <span class="depv-proj__bar" role="img" :aria-label="projectInfo.progressLabel">
        <i :style="{width: projectInfo.pct + '%'}"></i>
      </span>
      <span class="depv-proj__pct">{{ projectInfo.progressLabel }}</span>
    </div>

    <!-- Free-form canvas (user-finalized 2026-09-06: hard "stage N" columns were too rigid).
         Cards are absolutely positioned; x/y persist per project in meta (depView.pos.v1) and the
         topological layering survives only as the auto-layout used for new/orphan cards and the
         "tidy up" action. Drag the grip dot to move a card; drag the card itself onto another to
         link a dependency; wires follow card rects. The wire layer must live inside the scroll
         content (track): mounted outside, scrolling would offset wires from their cards. -->
    <div class="depv-cols" ref="viewport">
     <div class="depv-track" ref="track" :style="{ width: trackW + 'px', height: trackH + 'px' }">
      <!-- Empty scope: guide users to pull tasks in (dead .depv-empty CSS finally wired to a real state) -->
      <div v-if="!inScope.length" class="depv-empty">{{ $t('statsA.DepView.emptyHint') }}</div>
      <div v-for="t in inScope" :key="t.taskId" class="depv-task" tabindex="0" role="button"
           :data-tid="t.taskId" draggable="true"
           :style="{ left: (posMap[t.taskId] || { x: 0, y: 0 }).x + 'px', top: (posMap[t.taskId] || { x: 0, y: 0 }).y + 'px' }"
           :class="{
             'depv-task--blocked': !t.complete && missingOf(t).length,
             'depv-task--ready': !t.complete && !missingOf(t).length,
             'depv-task--done': t.complete,
             'depv-task--drop-left': dropTid === t.taskId && dropSide === 'left',
             'depv-task--drop-right': dropTid === t.taskId && dropSide === 'right',
             'depv-task--dragging': dragTid === t.taskId,
             'depv-task--moving': movingTid === t.taskId
           }"
           @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)"
           @contextmenu="taskContextMenu(t, $event)"
           @dragstart="onDragStart(t, $event)" @dragend="onDragEnd"
           @dragover.prevent="onDragOver(t, $event)" @dragleave="onDragLeave(t)" @drop.prevent="onDrop(t, $event)">
        <button class="depv-task__grip" draggable="false" tabindex="-1"
                :title="$t('statsA.DepView.moveHint')" :aria-label="$t('statsA.DepView.moveHint')"
                @pointerdown.prevent.stop="onGripDown(t, $event)">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
            <circle cx="2.5" cy="2.5" r="1.2" fill="currentColor"/><circle cx="7.5" cy="2.5" r="1.2" fill="currentColor"/>
            <circle cx="2.5" cy="7.5" r="1.2" fill="currentColor"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>
          </svg>
        </button>
        <div class="depv-task__main">
              <span class="td-check" :class="{on: !!t.complete}" role="checkbox" :aria-checked="t.complete ? 'true' : 'false'"
                    :aria-label="$t('statsJ.TodoItem.markDone')" tabindex="0"
                    @click.stop="completeTask(t)" @keydown.enter.prevent.stop="completeTask(t)">
                <svg v-if="t.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true">
                  <polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8"
                            stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
                </svg>
              </span>
              <span class="depv-task__text" :class="{'depv-task__text--done': t.complete}">{{ t.taskContent || $t('statsA.DepView.noTitle') }}</span>
              <span v-if="t.dayStart" class="depv-task__due">{{ dueLabel(t) }}</span>
              <button class="mt-act mt-act--del"
                      :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
                      @mousedown.stop @click.stop="quickDelete(t)">
                <app-icon name="trash" :size="13"/>
              </button>
        </div>
        <!-- blocked card second row: who it waits for, one chip per missing predecessor, click jumps to it -->
        <div v-if="!t.complete && missingOf(t).length" class="depv-task__wait">
          <span class="depv-task__wait-label">{{ $t('statsA.DepView.waiting') }}</span>
          <span v-for="m in missingOf(t)" :key="m.id" class="depv-miss" :title="m.name"
                @click.stop="jumpTo(m.id)">{{ m.name }}</span>
        </div>
      </div>

      <!-- Dependency wires: predecessor right edge -> dependent left edge; visual only, never blocks clicks -->
      <svg class="depv-wires" :width="trackW" :height="trackH" aria-hidden="true">
        <defs>
          <marker id="depv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" :fill="wireColor"/>
          </marker>
        </defs>
        <path v-for="(w, i) in wires" :key="i" :d="w.d" fill="none" :stroke="wireColor" stroke-width="1.6"
              stroke-dasharray="5 4" marker-end="url(#depv-arrow)" opacity="0.85"/>
      </svg>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** 依赖层级视图(实验性,developerMode 门控;今日页第四视图)
 *  列 = 依赖深度(拓扑分层):第 1 列无前置,第 n 列依赖前面某列;前置永远在左,连线恒向右。
 *  卡片状态:完成=划线置灰 / 可立即做=绿左缘 / 被阻塞=琥珀左缘+"等谁"chips。
 *  交互:单击开编辑、右键任务菜单、勾选完成(解锁联动)、拖 A 到 B 上 = A 成为 B 的前置(成环拒绝)。
 *  项目头:里程碑(M 序号/标题/日期)+ 截止 + 进度,数据来自 category store projectMeta 与 utils/milestones。
 *  FS 语义与 store/todo.js 的 isTaskReady 同源;parsePredecessors 单源在 utils/core.js。 */
import { dayjs, FMT, parsePredecessors } from '../utils/core.js'
import { toggleTomatoAttach } from '../utils/taskRow.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo, moveWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import { loadMilestones } from '../utils/milestones.js'

export default {
  name: 'DepView',
  props: {
    /** 项目页内嵌时固定项目(隐藏项目切换 chips);今日页独立使用时留空 */
    fixedProjectId: { type: Number, default: null }
  },
  data () {
    return { projectId: this.fixedProjectId != null ? this.fixedProjectId : null, wires: [], trackW: 0, trackH: 0, dragTid: '', dropTid: '', msList: [], msLoaded: true,
      posMap: {}, movingTid: '', dropSide: '' }
  },
  computed: {
    projects () { return this.$store.getters['category/projects'] || [] },
    wireColor () {
      var s = getComputedStyle(document.documentElement).getPropertyValue('--brand')
      return (s || '#0f9d8f').trim() || '#0f9d8f'
    },
    inScope () {
      var list = this.$store.state.todo.todoList.filter(function (t) { return !t.delete })
      if (this.projectId == null) return list
      return list.filter(function (t) { return t.categoryId === this.projectId }.bind(this))
    },
    /** Topological depth: depth(t) = max(depth of predecessors) + 1 (in-scope predecessors only).
     *  No longer rendered as hard "stage" columns - it is the auto-layout for new/orphan cards
     *  and for the tidy-up action (user-finalized 2026-09-06: free canvas, not fixed lanes). */
    depthSeq () {
      var list = this.inScope
      var byId = {}
      for (var i = 0; i < list.length; i++) byId[list[i].taskId] = list[i]
      var memo = {}
      var visiting = {}
      var depthOf = (t) => {
        if (memo[t.taskId] != null) return memo[t.taskId]
        if (visiting[t.taskId]) return 0 // cycle: rejected at store write; here just avoid infinite loop
        visiting[t.taskId] = true
        var preds = parsePredecessors(t.predecessors).filter(pid => byId[pid])
        var l = 0
        for (var k = 0; k < preds.length; k++) l = Math.max(l, depthOf(byId[preds[k]]) + 1)
        visiting[t.taskId] = false
        memo[t.taskId] = l
        return l
      }
      var buckets = []
      for (var j = 0; j < list.length; j++) {
        var t = list[j]
        var l = depthOf(t)
        ;(buckets[l] = buckets[l] || []).push(t)
      }
      // In-lane order: unfinished first, ready before blocked, then by date
      var rank = (t) => (t.complete ? 2 : (this.missingOf(t).length ? 1 : 0))
      return buckets.map(b => b.sort((a, c) =>
        rank(a) - rank(c) || (a.dayStart || 0) - (c.dayStart || 0) || (a.createTime || 0) - (c.createTime || 0)))
    },
    /** 项目头聚合:里程碑/截止/进度一次算好给模板 */
    projectInfo () {
      if (this.projectId == null) return null
      var cat = this.projects.find(p => p.categoryId === this.projectId)
      var meta = (this.$store.getters['category/projectMeta'] || {})[this.projectId] || {}
      var list = this.inScope
      var done = list.filter(t => t.complete).length
      var total = list.length
      var today0 = +dayjs().startOf('day')
      var future = this.msList.filter(m => m.date >= today0)
      var next = future[0] || null
      var idx = next ? this.msList.indexOf(next) : this.msList.length - 1
      var dl = meta.deadline || 0
      return {
        name: cat ? cat.categoryName : '',
        color: cat ? cat.categoryColor : 'var(--brand)',
        msTitle: next ? next.title : '',
        msIndex: Math.max(0, idx),
        msState: next ? (next.date === today0 ? 'today' : 'future') : 'none',
        msDateLabel: next ? dayjs(next.date).format(FMT.cnDate) : '',
        deadline: dl,
        dlLabel: dl ? dayjs(dl).format(FMT.cnDate) : '',
        dlOver: !!dl && dl < today0,
        pct: total ? Math.round(done / total * 100) : 0,
        progressLabel: this.$t('statsA.DepView.progress', { done: done, total: total })
      }
    }
  },
  watch: {
    projectId () {
      this.loadMs()
      this.loadPos()
      this.$nextTick(this.drawWires)
    },
    inScope: {
      deep: false,
      handler () { this.$nextTick(() => { this.ensurePositions(); this.drawWires() }) }
    }
  },
    mounted () {
      // 有项目时默认聚焦第一个项目(按项目看整体链路是本视图的主用法);固定项目(项目页内嵌)时不覆盖
      if (this.fixedProjectId == null && this.projectId == null && this.projects.length) this.projectId = this.projects[0].categoryId
      this.loadMs()
      this.loadPos()
      this.$nextTick(this.drawWires)
      window.addEventListener('resize', this.drawWires)
    },
    beforeUnmount () {
      window.removeEventListener('resize', this.drawWires)
      window.removeEventListener('pointermove', this.onGripMove)
      window.removeEventListener('pointerup', this.onGripUp)
      this.flushPos()
    },
  methods: {
    /** 右键菜单 = 共享任务菜单 + 每条前置一个"移除前置"入口(带 5s 撤销),删除依赖不再只能靠拖拽逆向操作 */
    taskContextMenu (t, e) {
      var extra = []
      var preds = parsePredecessors(t.predecessors)
      var all = this.allLiveById()
      for (var i = 0; i < preds.length; i++) {
        const pid = preds[i]
        const p = all[pid]
        const name = (p && p.taskContent) || pid
        extra.push({
          icon: 'x',
          danger: true,
          label: this.$t('statsA.DepView.removeDep', { a: name }),
          fn: () => this.removeDependency(t, pid, name)
        })
      }
      taskContextMenu(this, t, e, null, extra)
    },
    /** target.predecessors -= prereqId(带 5s 撤销 toast,与 addDependency 同一撤销出口) */
    removeDependency (target, prereqId, name) {
      var cur = parsePredecessors(target.predecessors)
      if (cur.indexOf(prereqId) < 0) return
      var prevDeps = cur.slice()
      moveWithUndo(this, {
        label: this.$t('statsA.DepView.depRemoved', { a: name || prereqId, b: target.taskContent || '' }),
        apply: () => { this.$store.dispatch('todo/updateTodoFields', { taskId: target.taskId, patch: { predecessors: cur.filter(x => x !== prereqId), status: 'update' } }) },
        revert: () => {
          this.$store.dispatch('todo/updateTodoFields', { taskId: target.taskId, patch: { predecessors: prevDeps, status: 'update' } })
          this.$nextTick(this.drawWires)
        }
      })
      this.$nextTick(this.drawWires)
    },
    // —— 画布布局:位置持久化 + 自动整理(自由画布是定稿形态,分层只是布局算法) ——
    posKey () { return 'depView.pos.v1:' + (this.projectId == null ? 'all' : String(this.projectId)) },
    loadPos () {
      this.posMap = {}
      // Sequence token: on rapid project switches, a stale response must not overwrite the newer posMap
      const seq = this._posSeq = (this._posSeq || 0) + 1
      window.todoAPI.dbCall('getMeta', this.posKey()).then(raw => {
        if (seq !== this._posSeq) return
        try { this.posMap = JSON.parse(raw) || {} } catch (e) { this.posMap = {} }
        this.ensurePositions()
        this.$nextTick(this.drawWires)
      }).catch(() => { if (seq === this._posSeq) this.ensurePositions() })
    },
    savePosTimer: null,
    savePos () {
      clearTimeout(this.savePosTimer)
      this.savePosTimer = setTimeout(() => this.flushPos(), 400)
    },
    flushPos () {
      clearTimeout(this.savePosTimer)
      window.todoAPI.dbCall('setMeta', [this.posKey(), JSON.stringify(this.posMap)]).catch(() => {})
    },
    /** Auto-layout (user feedback 2026-09-07: the naive depth-grid looked messy):
     *  1) lane = topological depth; 2) order inside each lane by barycenter of already-placed
     *  neighbours (two passes, left→right then right→left) so wires cross as little as possible;
     *  3) y stacks by the card's REAL measured height + gap; 4) each lane is vertically centered
     *  against the tallest lane, keeping predecessors roughly level with their dependents. */
    computeAutoLayout () {
      var lanes = this.depthSeq
      var byLane = {}
      lanes.forEach((lane, li) => lane.forEach(t => { byLane[t.taskId] = li }))
      var order = lanes.map(lane => lane.map(t => t.taskId))
      var predsOf = {}
      var list = this.inScope
      for (var i = 0; i < list.length; i++) predsOf[list[i].taskId] = parsePredecessors(list[i].predecessors).filter(id => byLane[id] != null)
      var succsOf = {}
      for (var id0 in predsOf) {
        if (!succsOf[id0]) succsOf[id0] = []
        for (var p0 = 0; p0 < predsOf[id0].length; p0++) {
          var up = predsOf[id0][p0]
          if (!succsOf[up]) succsOf[up] = []
          succsOf[up].push(id0)
        }
      }
      // 重心排序两轮:前向按前置的平均行位升序,后向按依赖的平均行位降序
      // (后向必须用后继,否则会把前向排好的顺序整个翻回去)
      for (var pass = 0; pass < 2; pass++) {
        var seq = pass === 0 ? order : order.slice().reverse()
        for (var s = 0; s < seq.length; s++) {
          var laneArr = seq[s]
          if (!laneArr || !laneArr.length) continue
          var li = order.indexOf(laneArr) // backward pass walks a reversed copy; write back via real index
          if (li < 0) continue
          var nbsOf = pass === 0 ? predsOf : succsOf
          var avgOf = function (id) {
            var nbs = nbsOf[id] || []
            var ys = []
            for (var k = 0; k < nbs.length; k++) {
              var at = order[byLane[nbs[k]]].indexOf(nbs[k])
              if (at >= 0) ys.push(at)
            }
            return ys.length ? ys.reduce(function (a, b) { return a + b }, 0) / ys.length : null
          }
          // 无已布邻居的卡保持原相对顺序(稳定),不掺进数值比较;两轮都按平均行位升序
          order[li] = laneArr
            .map(function (id, idx) { return { id: id, idx: idx, avg: avgOf(id) } })
            .sort(function (a, b) {
              if (a.avg == null && b.avg == null) return a.idx - b.idx
              if (a.avg == null) return 1
              if (b.avg == null) return -1
              return a.avg - b.avg
            })
            .map(function (x) { return x.id })
        }
      }
      // 实测卡高(拿不到就回退 84)
      var heights = {}
      var cards = this.$refs.track ? this.$refs.track.querySelectorAll('.depv-task') : []
      for (var c = 0; c < cards.length; c++) heights[cards[c].getAttribute('data-tid')] = cards[c].getBoundingClientRect().height
      var CARD_W = 236, GAP_X = 24, GAP_Y = 20, TOP = 20, LEFT = 24
      var map = {}
      var laneHeight = []
      for (var li2 = 0; li2 < order.length; li2++) {
        var y = TOP
        for (var j = 0; j < order[li2].length; j++) {
          var h = heights[order[li2][j]] || 84
          map[order[li2][j]] = { x: LEFT + li2 * (CARD_W + GAP_X), y: Math.round(y), h: h }
          y += h + GAP_Y
        }
        laneHeight[li2] = y - TOP - GAP_Y
      }
      var maxLane = Math.max.apply(null, laneHeight.concat([0]))
      // 各层垂直居中:前置与依赖大致等高,连线更短更平
      for (var li3 = 0; li3 < order.length; li3++) {
        var offset = Math.round((maxLane - laneHeight[li3]) / 2)
        if (offset > 0) for (var j2 = 0; j2 < order[li3].length; j2++) {
          var id2 = order[li3][j2]
          map[id2].y += offset
        }
      }
      for (var k2 in map) delete map[k2].h
      return map
    },
    ensurePositions () {
      var layout = this.computeAutoLayout()
      // 死键清理:posMap 只保留当前 scope 内还存在的任务,否则删除/移走的卡片位置永远留在 meta 里
      var live = {}
      var list = this.inScope
      for (var n = 0; n < list.length; n++) live[list[n].taskId] = true
      var changed = false
      for (var dead in this.posMap) {
        if (!live[dead]) { delete this.posMap[dead]; changed = true }
      }
      for (var id in layout) {
        if (!this.posMap[id]) { this.posMap[id] = layout[id]; changed = true }
      }
      if (changed) this.savePos()
    },
    tidyUp () {
      this.posMap = this.computeAutoLayout()
      this.savePos()
      this.$nextTick(this.drawWires)
    },
    /** Grip-drag moves the card (pointer capture); linking stays on the native HTML5 drag of the
     *  card body, so the two gestures never compete. preventDefault on pointerdown suppresses the
     *  native drag from the handle. */
    onGripDown (t, e) {
      var p = this.posMap[t.taskId]
      if (!p) { p = { x: 0, y: 0 }; this.posMap[t.taskId] = p }
      var track = this.$refs.track
      var tr = track ? track.getBoundingClientRect() : { left: 0, top: 0 }
      this._mv = { tid: t.taskId, ox: e.clientX - tr.left - p.x, oy: e.clientY - tr.top - p.y, tr }
      this.movingTid = t.taskId
      window.addEventListener('pointermove', this.onGripMove)
      window.addEventListener('pointerup', this.onGripUp)
    },
    onGripMove (e) {
      var mv = this._mv
      if (!mv) return
      var p = this.posMap[mv.tid]
      if (!p) return
      p.x = Math.max(0, Math.round(e.clientX - mv.tr.left - mv.ox))
      p.y = Math.max(0, Math.round(e.clientY - mv.tr.top - mv.oy))
      if (!this._mvRaf) this._mvRaf = requestAnimationFrame(() => { this._mvRaf = 0; this.drawWires() })
    },
    onGripUp () {
      if (!this._mv) return
      this._mv = null
      this.movingTid = ''
      window.removeEventListener('pointermove', this.onGripMove)
      window.removeEventListener('pointerup', this.onGripUp)
      this.savePos()
      this.drawWires()
    },
    rawOf (t) { return this.$store.state.todo.todoList.find(function (x) { return x.taskId === t.taskId }) || t },
    openEdit (t) { this.$store.commit('ui/openEdit', this.rawOf(t)) },
    jumpTo (id) {
      var p = this.$store.state.todo.todoList.find(function (x) { return x.taskId === id })
      if (p) this.$store.commit('ui/openEdit', p)
    },
    loadMs () {
      this.msList = []
      // 加载中与空态区分:避免异步里程碑未返回时闪"未设里程碑"假态
      this.msLoaded = this.projectId == null
      if (this.projectId == null) return
      var pid = this.projectId
      loadMilestones(pid).then(ms => { if (this.projectId === pid) { this.msList = ms || []; this.msLoaded = true } }).catch(() => { if (this.projectId === pid) this.msLoaded = true })
    },
    /** 阻塞/ready 判定的任务表:必须用全量未删任务(含 scope 外/跨项目前置),
     *  否则前置在别的项目时 byId 查不到,依赖卡会被误判为 ready */
    allLiveById () {
      var byId = {}
      var list = this.$store.state.todo.todoList.filter(function (t) { return !t.delete })
      for (var i = 0; i < list.length; i++) byId[list[i].taskId] = list[i]
      return byId
    },
    missingOf (t) {
      var byId = this.allLiveById()
      return parsePredecessors(t.predecessors)
        .map(function (id) { return { id: id, p: byId[id] } })
        .filter(function (x) { return x.p && !x.p.complete })
        .slice(0, 3)
        .map(function (x) { return { id: x.id, name: x.p.taskContent || x.id } })
    },
    completeTask (t) {
      toggleCompleteWithUndo({
        store: this.$store, message: this.$message, todo: this.rawOf(t),
        announce: function (m) { if (this.$announce) this.$announce(m) }.bind(this)
      })
    },
    quickDelete (t) { deleteWithUndo(this, this.$store, this.rawOf(t)) },
    toggleTomato (t) { toggleTomatoAttach(this.$store, t) },
    dueLabel (t) { return t.dayStart ? dayjs(t.dayStart).format(FMT.cnDate) : '' },
    // —— 拖拽建依赖:落到目标卡左半 = 拖的卡成为前置(指向右);落到右半 = 目标卡成为拖卡的前置。
    // 左/右缘分别高亮,方向一目了然(用户定稿 2026-09-06:整卡高亮分不清谁依赖谁) ——
    sideOf (t, e) {
      var rect = e.currentTarget ? e.currentTarget.getBoundingClientRect() : { left: 0, width: 0 }
      return (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
    },
    onDragStart (t, e) {
      this.dragTid = t.taskId
      try { e.dataTransfer.setData('text/plain', t.taskId) } catch (err) { /* IE 形态忽略 */ }
      e.dataTransfer.effectAllowed = 'link'
    },
    onDragEnd () { this.dragTid = ''; this.dropTid = ''; this.dropSide = '' },
    onDragOver (t, e) {
      if (!this.dragTid || this.dragTid === t.taskId) return
      this.dropTid = t.taskId
      this.dropSide = this.sideOf(t, e)
    },
    onDragLeave (t) { if (this.dropTid === t.taskId) { this.dropTid = ''; this.dropSide = '' } },
    onDrop (t, e) {
      var srcId = this.dragTid
      var side = this.dropSide || this.sideOf(t, e)
      this.dropTid = ''
      this.dropSide = ''
      this.dragTid = ''
      if (!srcId || srcId === t.taskId) return
      // left: 拖的卡成为目标的前置(A 指向 B);right: 目标卡成为拖卡的前置(B 指向 A)
      if (side === 'right') this.addDependency(this.inScope.find(x => x.taskId === srcId), t.taskId, t, srcId)
      else this.addDependency(t, srcId, this.inScope.find(x => x.taskId === srcId), t)
    },
    /** target.prerequisites += prereqId(成环拒绝 + 撤销出口);srcNames 仅用于 toast 文案 */
    addDependency (target, prereqId, prereqTask, dependentTask) {
      if (!target || !prereqTask) return
      var cur = parsePredecessors(target.predecessors)
      if (cur.indexOf(prereqId) >= 0) return
      // 成环检测:prereq 的前置链里若已(直接或间接)依赖 target,再加边就闭环
      var byId = {}
      this.inScope.forEach(x => { byId[x.taskId] = x })
      var seen = {}
      var stack = [prereqId]
      while (stack.length) {
        var id = stack.pop()
        if (id === target.taskId) {
          this.$message.error(this.$t('statsA.DepView.cycleErr', { b: target.taskContent || '' }))
          return
        }
        if (seen[id]) continue
        seen[id] = true
        var p = byId[id]
        if (p) parsePredecessors(p.predecessors).forEach(x => stack.push(x))
      }
      var prevDeps = cur.slice()
      moveWithUndo(this, {
        label: this.$t('statsA.DepView.depAdded', { a: prereqTask.taskContent || '', b: dependentTask.taskContent || '' }),
        apply: () => { this.$store.dispatch('todo/updateTodoFields', { taskId: target.taskId, patch: { predecessors: cur.concat(prereqId), status: 'update' } }) },
        revert: () => {
          this.$store.dispatch('todo/updateTodoFields', { taskId: target.taskId, patch: { predecessors: prevDeps, status: 'update' } })
          this.$nextTick(this.drawWires)
        }
      })
      this.$nextTick(this.drawWires)
    },
    /** 依赖连线:前置卡右缘 → 依赖卡左缘(画布上随卡片实时位置走) */
    drawWires () {
      var track = this.$refs.track
      if (!track) return
      var wrect = track.getBoundingClientRect()
      // 画布尺寸 = 卡片位置包围盒 ∪ 视口,绝对定位下 scrollWidth 不再反映内容,必须自算
      var maxX = wrect.width, maxY = wrect.height
      // 包围盒只统计现存卡片的位置(posMap 里的死键不应把画布越撑越大)
      var cards0 = track.querySelectorAll('.depv-task')
      var liveIds = {}
      for (var b0 = 0; b0 < cards0.length; b0++) liveIds[cards0[b0].getAttribute('data-tid')] = true
      for (var b in this.posMap) {
        if (!liveIds[b]) continue
        var pb = this.posMap[b]
        maxX = Math.max(maxX, pb.x + 300)
        maxY = Math.max(maxY, pb.y + 160)
      }
      this.trackW = Math.round(maxX)
      this.trackH = Math.round(maxY)
      var wires = []
      var cards = track.querySelectorAll('.depv-task')
      var pos = {}
      for (var i = 0; i < cards.length; i++) {
        var r = cards[i].getBoundingClientRect()
        pos[cards[i].getAttribute('data-tid')] = r
      }
      var byId = {}
      var list = this.inScope
      for (var k = 0; k < list.length; k++) byId[list[k].taskId] = list[k]
      for (var j = 0; j < cards.length; j++) {
        var el = cards[j]
        var tid = el.getAttribute('data-tid')
        var t = byId[tid]
        if (!t) continue
        var preds = parsePredecessors(t.predecessors)
        var to = pos[tid]
        if (!to) continue
        for (var m = 0; m < preds.length; m++) {
          var pid = preds[m]
          var from = pos[pid]
          if (!from) continue
          var x1 = from.right - wrect.left
          var y1 = from.top - wrect.top + from.height / 2
          var x2 = to.left - wrect.left
          var y2 = to.top - wrect.top + to.height / 2
          var dx = Math.max(24, Math.abs(x2 - x1) / 2)
          wires.push({ d: 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2 })
        }
      }
      this.wires = wires
    }
  }
}
</script>

<style>
/* 依赖层级(实验性):列 = 依赖深度,横向滚动;卡片两行(标题+等谁);连线层绝对覆盖 */
.depv-wrap { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; position: relative; }
.depv-topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.depv-filter { display: flex; gap: 8px; flex-wrap: wrap; }
.depv-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line-2, #e3e6ea); background: transparent; color: var(--text-2, #555); cursor: pointer; font-size: 12px; }
.depv-chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-light, rgba(15, 157, 143, .08)); }
.depv-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.depv-hint { font-size: 11px; color: var(--text-3, #999); margin-left: auto; }

.depv-proj { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 12px; border: 1px solid var(--line, #e6e8eb); border-radius: 10px; background: var(--panel, #fff); }
.depv-proj__name { font-weight: 600; font-size: 13px; color: var(--text-1, #222); }
.depv-proj__ms { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--brand-light, rgba(15, 157, 143, .08)); color: var(--brand); }
.depv-proj__ms--today { background: var(--warn-light, rgba(217, 147, 47, .12)); color: var(--warn, #d9932f); }
.depv-proj__noms { font-size: 12px; color: var(--text-3, #999); }
.depv-proj__dl { font-size: 12px; color: var(--text-2, #555); }
.depv-proj__dl--over { color: var(--danger, #c25649); }
.depv-proj__bar { flex: 1; min-width: 80px; max-width: 180px; height: 5px; border-radius: 999px; background: var(--gray-bg, #eee); overflow: hidden; }
.depv-proj__bar i { display: block; height: 100%; background: var(--brand); border-radius: 999px; transition: width .3s; }
.depv-proj__pct { font-size: 11px; color: var(--text-3, #999); flex-shrink: 0; }

.depv-cols { flex: 1; min-height: 0; overflow: auto; border-radius: 10px; border: 1px solid var(--line, #e6e8eb);
  background: var(--panel, #fff); }
/* 自由画布:点阵底纹给"这是可摆放的画布"的心智;卡片绝对定位,x/y 持久化在 meta */
.depv-track { position: relative;
  background-image: radial-gradient(var(--line, #e6e8eb) 1px, transparent 1px);
  background-size: 24px 24px; background-position: 12px 12px; }
.depv-task { position: absolute; width: 236px; border: 1px solid var(--line, #e6e8eb); border-radius: 8px;
  padding: 6px 8px 6px 6px; cursor: pointer; background: var(--panel, #fff); }
.depv-task:hover { border-color: var(--brand); box-shadow: 0 2px 8px rgba(0, 0, 0, .08); }
.depv-task__grip { position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; padding: 0;
  border: 0; background: none; color: var(--text-3, #999); cursor: grab; opacity: 0; transition: opacity .15s; }
.depv-task:hover .depv-task__grip, .depv-task--moving .depv-task__grip { opacity: 1; }
.depv-task__grip:hover { color: var(--brand); }
.depv-task--moving { cursor: grabbing; box-shadow: 0 8px 20px rgba(0, 0, 0, .22);
  border-color: var(--brand); z-index: 10; }
.depv-task--ready { border-left: 3px solid var(--brand, var(--brand, #0f9d8f)); }
.depv-task--blocked { border-left: 3px solid var(--warn, #d9932f); }
.depv-task--done { opacity: .62; }
/* 拖拽选中态:拖起的卡=品牌青描边+浅底+浮起阴影+微放大(明显选中感,不只是半透明);
   落点指示(用户定稿 2026-09-06):只亮目标卡的左缘或右缘——落在左半=拖的卡是前置(A 指向 B),
   落在右半=目标卡是前置(B 指向 A),方向一目了然;边缘 3px 品牌条+半侧浅底渐变 */
.depv-task--dragging { opacity: .6; border-color: var(--brand); background: var(--brand-light, rgba(15, 157, 143, .1));
  box-shadow: 0 6px 16px rgba(0, 0, 0, .28); transform: scale(1.015); }
.depv-task--drop-left, .depv-task--drop-right { border-color: var(--brand); }
.depv-task--drop-left { box-shadow: inset 3px 0 0 var(--brand, var(--brand, #0f9d8f));
  background: linear-gradient(90deg, var(--brand-light, rgba(15, 157, 143, .12)) 0%, rgba(15, 157, 143, 0) 45%); }
.depv-task--drop-right { box-shadow: inset -3px 0 0 var(--brand, var(--brand, #0f9d8f));
  background: linear-gradient(270deg, var(--brand-light, rgba(15, 157, 143, .12)) 0%, rgba(15, 157, 143, 0) 45%); }
.depv-task__main { display: flex; align-items: center; gap: 8px; }
.depv-task__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-1, #222); }
.depv-task__text--done { text-decoration: line-through; color: var(--text-3, #999); }
.depv-task__wait { display: flex; align-items: center; gap: 6px; margin-top: 6px; padding-left: 22px; flex-wrap: wrap; }
.depv-task__wait-label { font-size: 11px; color: var(--warn, #d9932f); flex-shrink: 0; }
.depv-miss { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--warn-light, rgba(217, 147, 47, .12));
  color: var(--warn, #d9932f); cursor: pointer; }
.depv-miss:hover { text-decoration: underline; }
.depv-task__due { flex-shrink: 0; font-size: 11px; color: var(--text-3, #999); }
.depv-empty { padding: 18px 10px; text-align: center; font-size: 12px; color: var(--text-3, #999); }
.depv-wires { position: absolute; inset: 0; pointer-events: none; overflow: visible; z-index: 5; }
</style>
