<template>

  <div class="page completed-page">
    <div class="page__header">
      <div class="title">
        <div class="title__prepend">
          <i class="icon-prepend"></i>
          <div class="title__text"> {{ $t('statsC.Completed.title') }} </div>
          <!-- [component-r5] click trigger + focusable reference: keyboard (Enter/Space) and touch can open the tip too; default (closed) rendering unchanged -->
          <el-popover placement="bottom-start" width="320" trigger="click">
            <ul class="tip-completed-list">
              <li>{{ $t('statsC.Completed.tip1') }}</li>
              <li>{{ $t('statsC.Completed.tip2') }}</li>
            </ul>
            <template #reference>
              <span class="tip-icon tip-q" role="button" tabindex="0" :aria-label="$t('statsC.Completed.tipAria')"
                    @keydown.enter.prevent="triggerTip($event)">?</span>
            </template>
          </el-popover>
        </div>
        <div class="title__append">
          <span class="grp-toggle-btn" role="button" tabindex="0"
                :aria-label="anyCollapsed ? $t('statsC.Completed.expandAll') : $t('statsC.Completed.collapseAll')"
                @click="toggleAllGroups" @keydown.enter.prevent="toggleAllGroups">
            <app-icon :name="anyCollapsed ? 'chevron-down' : 'chevron-up'" :size="12"/>
            {{ anyCollapsed ? $t('statsC.Completed.expandAll') : $t('statsC.Completed.collapseAll') }}
          </span>
        </div>
      </div>
    </div>
    <div class="page__main page__main--flow-top">
      <empty-state v-if="!groups.length"><template #text>{{ $t('statsC.Completed.empty') }}</template></empty-state>
      <div v-for="g in groups" :key="g.key" class="todo-list-item-group" :class="{'todo-list-item-group--collapsed': isCol(g.key)}">
        <div class="todo-list-item-group__header-container">
          <div class="todo-list-item-group__header" role="button" tabindex="0"
               :aria-expanded="isCol(g.key) ? 'false' : 'true'"
               :aria-label="$t('statsC.Completed.ariaGroup', { name: g.title })"
               @click="toggleCol(g.key)" @keydown.enter.prevent="toggleCol(g.key)">
            <div class="todo-list-item-group__arrow">
              <svg viewBox="0 0 256 512"><path fill="currentColor" d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 34 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 34 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z"/></svg>
            </div>
            <div class="todo-list-item-group__title"> {{ $t(g.titleKey || g.title) }} </div>
            <div class="todo-list-item-group__count"> {{ g.todos.length }} </div>
          </div>
        </div>
        <div class="todo-list-item-group-container">
          <transition name="collapse">
          <div v-show="!isCol(g.key)" class="todo-list-item-group-container__list">
            <transition-group name="listfade" tag="div">
              <div v-for="t in g.todos" :key="t.taskId" class="done-row-orig row-btn-row">
                <todo-item :todo="t" :show-date-badge="true"/>
                <button class="row-btn" @click.stop="undo(t)">{{ $t('statsC.Completed.btnUndo') }}</button>
              </div>
            </transition-group>
          </div>
          </transition>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Completed view (project baseline route todo-list-completed, component scope)
 * Structure aligned with the project baseline render function:
 *   todo-page-layout > .page__header > .title
 *     .title__prepend: i.icon-prepend (completed icon) + .title__text + hover bubble (TipCompleted copy)
 *   body: [empty] .empty "no schedules"; [non-empty] grouped by completion time (today/yesterday/2 days ago/7 days ago/30 days ago)
 * Rows still reuse the shared <todo-item> component; "restore to incomplete" reuses the toggleComplete logic.
 */
import TodoItem from '../components/TodoItem.vue'
import EmptyState from '../components/EmptyState.vue'
import { buildCompletedBuckets } from '../utils/buckets.js'

import { toggleCompleteWithUndo } from '../utils/completeAction.js'

export default {
  name: 'CompletedView',
  components: { TodoItem, EmptyState },
  data () {
    return { collapsedMap: {} }
  },
  computed: {
    list () { return this.$store.state.todo.views.completed },
    groups () { return buildCompletedBuckets(this.list) },
    anyCollapsed () { return this.groups.some(g => this.collapsedMap[g.key]) }
  },
  methods: {
    isCol (key) { return !!this.collapsedMap[key] },
    // TS cast lives here: the structure guard rejects `as` expressions inside templates
    triggerTip (e) { (e.currentTarget as HTMLElement).click() },
    toggleCol (key) { this.collapsedMap = { ...this.collapsedMap, [key]: !this.collapsedMap[key] } },
    toggleAllGroups () {
      const expand = this.anyCollapsed
      const next = { ...this.collapsedMap }; for (const g of this.groups) next[g.key] = !expand; this.collapsedMap = next
    },
    undo (t) {
      // Uniformly go through toggleCompleteWithUndo: bidirectional undo toast shared with the whole app (2026-08-31 consistency consolidation)
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: t, announce: m => this.$announce && this.$announce(m) })
    }
  },

}
</script>
<style>/* ---- C. 页头左侧图标（资源沿用，按视图根类区分）---- */
.icon-prepend{display:block;width:20px;height:20px;background-repeat:no-repeat;background-position:50%;background-size:contain}
.completed-page .icon-prepend{background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22 fill=%22%23ccc%22/></svg>')}
/* ---- J. 提示问号（原 已达成页 .tip-icon）与分组设置按钮（原 __btn-settings cog）---- */
.tip-icon{color:var(--text-4)}
.tip-icon>svg,.icon-append>svg{display:block}
.done-row-orig{display:flex;align-items:stretch}
.done-row-orig>:first-child{flex:1;min-width:0}
.tip-q{margin-left:8px;color:var(--text-4);border-color:var(--text-4)}
/* 已达成页提示气泡文案列表（原 TipCompleted 内容，样式按设计稿 tip 12px 灰字） */
.tip-completed-list{list-style:none;margin:0;padding:0;font-size: var(--fs-sm);color:var(--text-2);line-height:20px}
.tip-completed-list li{padding:2px 0}
/* 条目右侧悬停操作按钮的显示时机：悬停所在行时出现 */
.done-row-orig:hover .row-btn,.todo-box-list-item__tools{opacity:1}
</style>
