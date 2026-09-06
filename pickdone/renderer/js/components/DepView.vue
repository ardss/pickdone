<template>
  <div class="depv-wrap" ref="wrap">
    <div class="depv-filter" role="group" :aria-label="$t('statsA.DepView.filterLabel')">
      <button class="depv-chip" :class="{on: projectId === null}" @click="projectId = null">{{ $t('statsA.DepView.allProjects') }}</button>
      <button v-for="p in projects" :key="p.categoryId" class="depv-chip" :class="{on: projectId === p.categoryId}"
              @click="projectId = p.categoryId">
        <span class="depv-chip-dot" :style="{background: p.categoryColor}"></span>{{ p.categoryName }}
      </button>
    </div>

    <div class="depv-lanes">
      <div v-for="lane in lanes" :key="lane.key" class="depv-lane" :class="'depv-lane--' + lane.key">
        <div class="depv-lane__head">
          <span class="depv-lane__title">{{ lane.title }}</span>
          <em class="depv-lane__count">{{ lane.tasks.length }}</em>
        </div>
        <div class="depv-lane__list">
          <div v-for="t in lane.tasks" :key="t.taskId" class="depv-task" tabindex="0" role="button"
               :data-tid="t.taskId" :class="{'depv-task--blocked': lane.key === 'blocked' && missingOf(t).length}"
               @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)"
               @contextmenu="taskContextMenu(t, $event)">
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
            <div v-if="lane.key === 'blocked' && missingOf(t).length" class="depv-task__wait">
              <span class="depv-task__wait-label">{{ $t('statsA.DepView.waiting') }}</span>
              <span v-for="m in missingOf(t)" :key="m.id" class="depv-miss" :title="m.name"
                    @click.stop="jumpTo(m.id)">{{ m.name }}</span>
            </div>
          </div>
          <div v-if="!lane.tasks.length" class="depv-empty">{{ lane.emptyText }}</div>
        </div>
      </div>
    </div>

    <!-- 依赖连线层:被依赖卡 → 依赖它的卡,贝塞尔曲线 + 箭头;纯视觉,不挡点击 -->
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
/** 依赖泳道视图(实验性,developerMode 门控;今日页第四视图)
 *  一屏回答"现在能做什么、什么被什么挡着":Ready(前置全完成或无前置)/ Blocked(有未完成前置,卡上摊开"等谁")/ 刚完成(48h)。
 *  SVG 连线把"谁依赖谁"画出来:被依赖卡右缘 → 依赖卡左缘,数据变化/滚动/窗口缩放时重算。
 *  FS 语义与 store/todo.js 的 isTaskReady 同源;parsePredecessors 单源在 utils/core.js;项目过滤走 category store 的 projects getter。 */
import { dayjs, FMT, parsePredecessors } from '../utils/core.js'
import { toggleTomatoAttach } from '../utils/taskRow.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'

export default {
  name: 'DepView',
  data () {
    return { projectId: null, wires: [], wrapW: 0, wrapH: 0 }
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
    lanes () {
      var list = this.inScope
      var byId = {}
      for (var i = 0; i < list.length; i++) byId[list[i].taskId] = list[i]
      var ready = []
      var blocked = []
      for (var j = 0; j < list.length; j++) {
        var t = list[j]
        if (t.complete) continue
        var preds = parsePredecessors(t.predecessors)
        var open = preds.filter(function (pid) { return byId[pid] && !byId[pid].complete })
        ;(open.length ? blocked : ready).push(t)
      }
      var cutoff = Date.now() - 48 * 3600 * 1000
      var done = list.filter(function (t) { return t.complete && (t.completedAt || 0) >= cutoff })
        .sort(function (a, b) { return (b.completedAt || 0) - (a.completedAt || 0) }).slice(0, 20)
      return [
        { key: 'ready', title: this.$t('statsA.DepView.ready'), tasks: ready, emptyText: this.$t('statsA.DepView.readyEmpty') },
        { key: 'blocked', title: this.$t('statsA.DepView.blocked'), tasks: blocked, emptyText: this.$t('statsA.DepView.blockedEmpty') },
        { key: 'done', title: this.$t('statsA.DepView.done'), tasks: done, emptyText: this.$t('statsA.DepView.doneEmpty') }
      ]
    }
  },
  watch: {
    projectId () { this.$nextTick(this.drawWires) }
  },
  mounted () {
    // 有项目时默认聚焦第一个项目(按项目看整体链路是本视图的主用法)
    if (this.projectId == null && this.projects.length) this.projectId = this.projects[0].categoryId
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
    /** 依赖连线:Blocked 卡左缘 ← 它缺失的每个前置卡右缘;坐标相对泳道容器 */
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
      for (var j = 0; j < cards.length; j++) {
        var el = cards[j]
        var tid = el.getAttribute('data-tid')
        var t = this.inScope.find(function (x) { return x.taskId === tid })
        if (!t || t.complete) continue
        var byId = {}
        var list = this.inScope
        for (var k = 0; k < list.length; k++) byId[list[k].taskId] = list[k]
        var preds = parsePredecessors(t.predecessors)
        var to = pos[tid]
        if (!to) continue
        for (var m = 0; m < preds.length; m++) {
          var pid = preds[m]
          var from = pos[pid]
          if (!from) continue
          var fp = byId[pid]
          if (!fp || fp.complete) continue
          var x1 = from.right - wrect.left
          var y1 = from.top - wrect.top + from.height / 2
          var x2 = to.left - wrect.left
          var y2 = to.top - wrect.top + to.height / 2
          if (x2 < x1) { // 依赖卡在左侧(理论不发生,泳道从左到右)——直连
            var dx = Math.abs(x2 - x1)
            wires.push({ d: 'M' + x1 + ',' + y1 + ' C' + (x1 - dx / 2) + ',' + y1 + ' ' + (x2 + dx / 2) + ',' + y2 + ' ' + x2 + ',' + y2 })
          } else {
            var cx = (x1 + x2) / 2
            wires.push({ d: 'M' + x1 + ',' + y1 + ' C' + cx + ',' + y1 + ' ' + cx + ',' + y2 + ' ' + x2 + ',' + y2 })
          }
        }
      }
      this.wires = wires
    }
  }
}
</script>

<style>
/* 依赖泳道(实验性):三列,卡片两行(标题+等谁);连线层绝对覆盖 */
.depv-wrap { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; position: relative; }
.depv-filter { display: flex; gap: 8px; flex-wrap: wrap; }
.depv-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line-2, #e3e6ea); background: transparent; color: var(--text-2, #555); cursor: pointer; font-size: 12px; }
.depv-chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-light, rgba(15, 157, 143, .08)); }
.depv-chip-dot { width: 8px; height: 8px; border-radius: 50%; }
.depv-lanes { display: grid; grid-template-columns: 1fr 1.2fr 1fr; gap: 12px; align-items: start; flex: 1; min-height: 0; overflow: auto; }
.depv-lane { background: var(--panel, #fff); border: 1px solid var(--line, #e6e8eb); border-radius: 10px; min-height: 120px; }
.depv-lane__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line, #e6e8eb); }
.depv-lane__title { font-weight: 600; font-size: 13px; color: var(--text-1, #222); }
.depv-lane__count { margin-left: auto; font-style: normal; font-size: 12px; color: var(--text-3, #999); }
.depv-lane--blocked .depv-lane__title { color: var(--warn, #d9932f); }
.depv-lane--done .depv-lane__title { color: var(--text-3, #999); }
.depv-lane__list { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.depv-task { border: 1px solid var(--line, #e6e8eb); border-radius: 8px; padding: 6px 8px; cursor: pointer; background: var(--panel, #fff); }
.depv-task:hover { border-color: var(--brand); }
.depv-task--blocked { border-left: 3px solid var(--warn, #d9932f); }
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
