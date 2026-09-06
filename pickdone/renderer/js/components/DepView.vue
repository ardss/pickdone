<template>
  <div class="depv-wrap" ref="wrap">
    <div class="depv-topbar">
      <div class="depv-filter" role="group" :aria-label="$t('statsA.DepView.filterLabel')">
        <button class="depv-chip" :class="{on: projectId === null}" @click="projectId = null">{{ $t('statsA.DepView.allProjects') }}</button>
        <button v-for="p in projects" :key="p.categoryId" class="depv-chip" :class="{on: projectId === p.categoryId}"
                @click="projectId = p.categoryId">
          <span class="depv-chip-dot" :style="{background: p.categoryColor}"></span>{{ p.categoryName }}
        </button>
      </div>
      <span class="depv-hint">{{ $t('statsA.DepView.dragHint') }}</span>
    </div>

    <!-- 项目头:里程碑/截止/进度(里程碑与截止来自 projectMeta,进度从任务算) -->
    <div v-if="projectId != null && projectInfo" class="depv-proj">
      <span class="depv-chip-dot" :style="{background: projectInfo.color}"></span>
      <span class="depv-proj__name">{{ projectInfo.name }}</span>
      <span class="depv-proj__ms" :class="'depv-proj__ms--' + projectInfo.msState" v-if="projectInfo.msTitle">
        M{{ projectInfo.msIndex + 1 }} · {{ projectInfo.msTitle }} · {{ projectInfo.msDateLabel }}
      </span>
      <span class="depv-proj__noms" v-else>{{ $t('statsA.DepView.noMilestone') }}</span>
      <span class="depv-proj__dl" :class="{'depv-proj__dl--over': projectInfo.dlOver}" v-if="projectInfo.deadline">
        {{ $t('statsA.DepView.deadline') }} {{ projectInfo.dlLabel }}
      </span>
      <span class="depv-proj__bar" role="img" :aria-label="projectInfo.progressLabel">
        <i :style="{width: projectInfo.pct + '%'}"></i>
      </span>
      <span class="depv-proj__pct">{{ projectInfo.progressLabel }}</span>
    </div>

    <!-- 依赖层级:列 = 依赖深度(拓扑分层),前置永远在左,依赖在右;横向滚动容纳十几条任务 -->
    <div class="depv-cols" ref="cols">
      <div v-for="(col, ci) in cols" :key="ci" class="depv-col">
        <div class="depv-col__head">
          <span class="depv-col__title">{{ $t('statsA.DepView.stage') }} {{ ci + 1 }}</span>
          <em class="depv-col__count">{{ col.length }}</em>
        </div>
        <div class="depv-col__list">
          <div v-for="t in col" :key="t.taskId" class="depv-task" tabindex="0" role="button"
               :data-tid="t.taskId" draggable="true"
               :class="{
                 'depv-task--blocked': !t.complete && missingOf(t).length,
                 'depv-task--ready': !t.complete && !missingOf(t).length,
                 'depv-task--done': t.complete,
                 'depv-task--droptarget': dropTid === t.taskId && dragTid && dragTid !== t.taskId,
                 'depv-task--dragging': dragTid === t.taskId
               }"
               @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)"
               @contextmenu="taskContextMenu(t, $event)"
               @dragstart="onDragStart(t, $event)" @dragend="onDragEnd"
               @dragover.prevent="onDragOver(t, $event)" @dragleave="onDragLeave(t)" @drop.prevent="onDrop(t)">
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
            <!-- blocked 卡第二行:等谁,一个前置一个 chip,点 chip 跳到该前置 -->
            <div v-if="!t.complete && missingOf(t).length" class="depv-task__wait">
              <span class="depv-task__wait-label">{{ $t('statsA.DepView.waiting') }}</span>
              <span v-for="m in missingOf(t)" :key="m.id" class="depv-miss" :title="m.name"
                    @click.stop="jumpTo(m.id)">{{ m.name }}</span>
            </div>
          </div>
          <div v-if="!col.length" class="depv-empty">—</div>
        </div>
      </div>
    </div>

    <!-- 依赖连线层:前置卡右缘 → 依赖卡左缘,恒向右;纯视觉,不挡点击 -->
    <svg class="depv-wires" :width="wrapW" :height="wrapH" aria-hidden="true">
      <defs>
        <marker id="depv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" :fill="wireColor"/>
        </marker>
      </defs>
      <path v-for="(w, i) in wires" :key="i" :d="w.d" fill="none" :stroke="wireColor" stroke-width="1.6"
            stroke-dasharray="5 4" marker-end="url(#depv-arrow)" opacity="0.85"/>
    </svg>
  </div>
</template>

<script>
/** 依赖层级视图(实验性,developerMode 门控;今日页第四视图)
 *  列 = 依赖深度(拓扑分层):第 1 列无前置,第 n 列依赖前面某列;前置永远在左,连线恒向右。
 *  卡片状态:完成=划线置灰 / 可立即做=绿左缘 / 被阻塞=琥珀左缘+"等谁"chips。
 *  交互:单击开编辑、右键任务菜单、勾选完成(解锁联动)、拖 A 到 B 上 = A 成为 B 的前置(成环拒绝)。
 *  项目头:里程碑(M 序号/标题/日期)+ 截止 + 进度,数据来自 category store projectMeta 与 utils/milestones。
 *  FS 语义与 store/todo.js 的 isTaskReady 同源;parsePredecessors 单源在 utils/core.js。 */
import { dayjs, FMT, parsePredecessors } from '../utils/core.js'
import { toggleTomatoAttach } from '../utils/taskRow.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import { loadMilestones } from '../utils/milestones.js'

export default {
  name: 'DepView',
  data () {
    return { projectId: null, wires: [], wrapW: 0, wrapH: 0, dragTid: '', dropTid: '', msList: [] }
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
    /** 拓扑分层:level(t)=前置 level 最大值+1(仅计范围内前置);完成任务也参与分层(它们是链条的锚点) */
    cols () {
      var list = this.inScope
      var byId = {}
      for (var i = 0; i < list.length; i++) byId[list[i].taskId] = list[i]
      var memo = {}
      var visiting = {}
      var levelOf = (t) => {
        if (memo[t.taskId] != null) return memo[t.taskId]
        if (visiting[t.taskId]) return 0 // 环:store 写入时已拦截,这里只保证不死循环
        visiting[t.taskId] = true
        var preds = parsePredecessors(t.predecessors).filter(pid => byId[pid])
        var l = 0
        for (var k = 0; k < preds.length; k++) l = Math.max(l, levelOf(byId[preds[k]]) + 1)
        visiting[t.taskId] = false
        memo[t.taskId] = l
        return l
      }
      var buckets = []
      for (var j = 0; j < list.length; j++) {
        var t = list[j]
        var l = levelOf(t)
        ;(buckets[l] = buckets[l] || []).push(t)
      }
      if (!buckets.length) buckets = [[]]
      // 列内排序:未完成在前,可立即做的先于被阻塞的,再按日期
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
      this.$nextTick(this.drawWires)
    },
    cols () { this.$nextTick(this.drawWires) }
  },
  mounted () {
    // 有项目时默认聚焦第一个项目(按项目看整体链路是本视图的主用法)
    if (this.projectId == null && this.projects.length) this.projectId = this.projects[0].categoryId
    this.loadMs()
    this.$nextTick(this.drawWires)
    window.addEventListener('resize', this.drawWires)
    this._wireTimer = setInterval(this.drawWires, 1500) // 轻量兜底:列表增删/完成联动后重画(不依赖深层 watcher)
  },
  beforeUnmount () {
    window.removeEventListener('resize', this.drawWires)
    clearInterval(this._wireTimer)
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    rawOf (t) { return this.$store.state.todo.todoList.find(function (x) { return x.taskId === t.taskId }) || t },
    openEdit (t) { this.$store.commit('ui/openEdit', this.rawOf(t)) },
    jumpTo (id) {
      var p = this.$store.state.todo.todoList.find(function (x) { return x.taskId === id })
      if (p) this.$store.commit('ui/openEdit', p)
    },
    loadMs () {
      this.msList = []
      if (this.projectId == null) return
      var pid = this.projectId
      loadMilestones(pid).then(ms => { if (this.projectId === pid) this.msList = ms || [] })
    },
    missingOf (t) {
      var byId = {}
      var list = this.inScope
      for (var i = 0; i < list.length; i++) byId[list[i].taskId] = list[i]
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
    // —— 拖拽建依赖:拖 A 落到 B 上 = A 成为 B 的前置(A 在左,B 在右,与布局语义一致) ——
    onDragStart (t, e) {
      this.dragTid = t.taskId
      try { e.dataTransfer.setData('text/plain', t.taskId) } catch (err) { /* IE 形态忽略 */ }
      e.dataTransfer.effectAllowed = 'link'
    },
    onDragEnd () { this.dragTid = ''; this.dropTid = '' },
    onDragOver (t, e) { if (this.dragTid && this.dragTid !== t.taskId) this.dropTid = t.taskId },
    onDragLeave (t) { if (this.dropTid === t.taskId) this.dropTid = '' },
    async onDrop (t) {
      var srcId = this.dragTid
      this.dropTid = ''
      this.dragTid = ''
      if (!srcId || srcId === t.taskId) return
      var src = this.inScope.find(x => x.taskId === srcId)
      if (!src) return
      var cur = parsePredecessors(t.predecessors)
      if (cur.indexOf(srcId) >= 0) return
      // 成环检测:src 的前置链里若已(直接或间接)依赖 t,再加边就闭环
      var byId = {}
      this.inScope.forEach(x => { byId[x.taskId] = x })
      var seen = {}
      var stack = [srcId]
      while (stack.length) {
        var id = stack.pop()
        if (id === t.taskId) {
          this.$message.error(this.$t('statsA.DepView.cycleErr', { b: t.taskContent || '' }))
          return
        }
        if (seen[id]) continue
        seen[id] = true
        var p = byId[id]
        if (p) parsePredecessors(p.predecessors).forEach(x => stack.push(x))
      }
      try {
        await this.$store.dispatch('todo/updateTodoFields', {
          taskId: t.taskId,
          patch: { predecessors: cur.concat(srcId), status: 'update' }
        })
        this.$message.success(this.$t('statsA.DepView.depAdded', { a: src.taskContent || '', b: t.taskContent || '' }))
        this.$nextTick(this.drawWires)
      } catch (err) {
        this.$message.error(this.$t('statsA.DepView.cycleErr', { b: t.taskContent || '' }))
      }
    },
    /** 依赖连线:前置卡右缘 → 依赖卡左缘(分层保证前置恒在左) */
    drawWires () {
      var wrap = this.$refs.wrap
      if (!wrap) return
      var wrect = wrap.getBoundingClientRect()
      this.wrapW = wrect.width
      this.wrapH = wrect.height
      var wires = []
      var cards = wrap.querySelectorAll('.depv-task')
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

.depv-cols { display: flex; gap: 12px; align-items: stretch; flex: 1; min-height: 0;
  overflow-x: auto; overflow-y: hidden; }
.depv-col { width: 232px; flex-shrink: 0; display: flex; flex-direction: column;
  background: var(--panel, #fff); border: 1px solid var(--line, #e6e8eb); border-radius: 10px; min-height: 120px; }
.depv-col__head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--line, #e6e8eb); }
.depv-col__title { font-weight: 600; font-size: 12px; color: var(--text-2, #555); }
.depv-col__count { margin-left: auto; font-style: normal; font-size: 12px; color: var(--text-3, #999); }
.depv-col__list { display: flex; flex-direction: column; gap: 6px; padding: 8px; flex: 1;
  overflow-y: auto; min-height: 0; }
.depv-task { border: 1px solid var(--line, #e6e8eb); border-radius: 8px; padding: 6px 8px; cursor: pointer; background: var(--panel, #fff); }
.depv-task:hover { border-color: var(--brand); }
.depv-task--ready { border-left: 3px solid var(--brand, #0f9d8f); }
.depv-task--blocked { border-left: 3px solid var(--warn, #d9932f); }
.depv-task--done { opacity: .62; }
.depv-task--dragging { opacity: .4; }
.depv-task--droptarget { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-light, rgba(15, 157, 143, .25)); }
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
