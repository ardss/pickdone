<template>
  <div class="depv-wrap">
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
               @click="openEdit(t)" @keydown.enter.prevent="openEdit(t)"
               @contextmenu="taskContextMenu(t, $event)">
            <span class="td-check" :class="{on: !!t.complete}" role="checkbox" :aria-checked="t.complete ? 'true' : 'false'"
                  :aria-label="$t('statsJ.TodoItem.markDone')" tabindex="0"
                  @click.stop="completeTask(t)" @keydown.enter.prevent.stop="completeTask(t)">
              <svg v-if="t.complete" class="td-check-svg" viewBox="0 0 12 12" aria-hidden="true">
                <polyline points="2,6.2 5,9 10,3" fill="none" stroke="#fff" stroke-width="1.8"
                          stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
              </svg>
            </span>
            <span class="depv-task__text" :class="{'depv-task__text--done': t.complete}">{{ t.taskContent || $t('statsA.DepView.noTitle') }}</span>
            <!-- blocked 卡:前置缺什么直接摊在卡上,点 chip 跳到该前置(依赖视图的核心信息) -->
            <span v-for="m in missingOf(t)" :key="m.id" class="depv-miss" :title="m.name"
                  @click.stop="jumpTo(m.id)">{{ m.name }}</span>
            <span v-if="t.dayStart" class="depv-task__due">{{ dueLabel(t) }}</span>
            <button class="mt-act mt-act--del"
                    :title="$t('statsE.TodoItem.moveToRecycleBin')" :aria-label="$t('statsE.TodoItem.moveToRecycleBin')"
                    @mousedown.stop @click.stop="quickDelete(t)">
              <app-icon name="trash" :size="13"/>
            </button>
          </div>
          <div v-if="!lane.tasks.length" class="depv-empty">{{ lane.emptyText }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
/** 依赖泳道视图(实验性,developerMode 门控;今日页第四视图)
 *  一屏回答"现在能做什么、什么被什么挡着":Ready(前置全完成或无前置)/ Blocked(有未完成前置,卡片上摊开缺的前置)/ 刚完成(48h)。
 *  FS 语义与 store/todo.js 的 parsePredecessors/isTaskReady 同源;项目过滤走 category store 的 projects getter。 */
import { dayjs, FMT, parsePredecessors } from '../utils/core.js'
import { chkColor, toggleTomatoAttach } from '../utils/taskRow.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { deleteWithUndo } from '../utils/confirm.js'
import { taskContextMenu } from '../utils/taskMenu.js'

export default {
  name: 'DepView',
  data () {
    return { projectId: null }
  },
  computed: {
    projects () { return this.$store.getters['category/projects'] || [] },
    inScope () {
      const list = this.$store.state.todo.todoList.filter(t => !t.delete)
      return this.projectId == null ? list : list.filter(t => t.categoryId === this.projectId)
    },
    lanes () {
      const list = this.inScope
      const byId = {}
      for (const t of list) byId[t.taskId] = t
      const ready = []
      const blocked = []
      for (const t of list) {
        if (t.complete) continue
        const preds = parsePredecessors(t.predecessors)
        const open = preds.filter(pid => byId[pid] && !byId[pid].complete)
        ;(open.length ? blocked : ready).push(t)
      }
      const cutoff = Date.now() - 48 * 3600 * 1000
      const done = list.filter(t => t.complete && (t.completedAt || 0) >= cutoff)
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 20)
      return [
        { key: 'ready', title: this.$t('statsA.DepView.ready'), tasks: ready, emptyText: this.$t('statsA.DepView.readyEmpty') },
        { key: 'blocked', title: this.$t('statsA.DepView.blocked'), tasks: blocked, emptyText: this.$t('statsA.DepView.blockedEmpty') },
        { key: 'done', title: this.$t('statsA.DepView.done'), tasks: done, emptyText: this.$t('statsA.DepView.doneEmpty') }
      ]
    }
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e) },
    rawOf (t) { return this.$store.state.todo.todoList.find(x => x.taskId === t.taskId) || t },
    openEdit (t) { this.$store.commit('ui/openEdit', this.rawOf(t)) },
    jumpTo (id) {
      const p = this.$store.state.todo.todoList.find(x => x.taskId === id)
      if (p) this.$store.commit('ui/openEdit', p)
    },
    missingOf (t) {
      const byId = {}
      for (const x of this.inScope) byId[x.taskId] = x
      return parsePredecessors(t.predecessors)
        .map(id => ({ id, p: byId[id] }))
        .filter(x => x.p && !x.p.complete)
        .slice(0, 3)
        .map(x => ({ id: x.id, name: x.p.taskContent || x.id }))
    },
    completeTask (t) {
      toggleCompleteWithUndo({
        store: this.$store, message: this.$message, todo: this.rawOf(t),
        announce: m => this.$announce && this.$announce(m)
      })
    },
    chkColor (t) { return chkColor(this.$store, t) },
    quickDelete (t) { deleteWithUndo(this, this.$store, this.rawOf(t)) },
    toggleTomato (t) { toggleTomatoAttach(this.$store, t) },
    dueLabel (t) { return t.dayStart ? dayjs(t.dayStart).format(FMT.cnDate) : '' }
  }
}
</script>

<style>
/* 依赖泳道(实验性):三列等高,卡片语言沿用 matrix-task 的行形态,列头沿用 matrix-quadrant 的头 */
.depv-wrap { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }
.depv-filter { display: flex; gap: 8px; flex-wrap: wrap; }
.depv-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line-2, #e3e6ea); background: transparent; color: var(--text-2, #555); cursor: pointer; font-size: 12px; }
.depv-chip.on { border-color: var(--brand); color: var(--brand); background: var(--brand-light, rgba(15, 157, 143, .08)); }
.depv-chip-dot { width: 8px; height: 8px; border-radius: 50%; }
.depv-lanes { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; align-items: start; flex: 1; min-height: 0; overflow: auto; }
.depv-lane { background: var(--panel, #fff); border: 1px solid var(--line, #e6e8eb); border-radius: 10px; min-height: 120px; }
.depv-lane__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line, #e6e8eb); }
.depv-lane__title { font-weight: 600; font-size: 13px; color: var(--text-1, #222); }
.depv-lane__count { margin-left: auto; font-style: normal; font-size: 12px; color: var(--text-3, #999); }
.depv-lane--blocked .depv-lane__title { color: var(--warn, #d9932f); }
.depv-lane--done .depv-lane__title { color: var(--text-3, #999); }
.depv-lane__list { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.depv-task { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line, #e6e8eb);
  border-radius: 8px; cursor: pointer; background: var(--panel, #fff); }
.depv-task:hover { border-color: var(--brand); }
.depv-task__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-1, #222); }
.depv-task__text--done { text-decoration: line-through; color: var(--text-3, #999); }
.depv-miss { flex-shrink: 0; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--warn-light, rgba(217, 147, 47, .12));
  color: var(--warn, #d9932f); cursor: pointer; }
.depv-task__due { flex-shrink: 0; font-size: 11px; color: var(--text-3, #999); }
.depv-empty { padding: 18px 10px; text-align: center; font-size: 12px; color: var(--text-3, #999); }
</style>
