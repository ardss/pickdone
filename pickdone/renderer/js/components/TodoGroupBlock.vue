<template>

  <div class="todo-list-item-group" :class="groupCls">
    <div class="todo-list-item-group__header-container">
      <div class="todo-list-item-group__header" role="button" tabindex="0"
           :aria-expanded="collapsed ? 'false' : 'true'"
           @click="toggle" @keydown.enter.prevent="toggle">
        <div class="todo-list-item-group__arrow">
          <svg viewBox="0 0 256 512" aria-hidden="true"><path fill="currentColor" d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 34 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 34 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z"/></svg>
        </div>
        <div class="todo-list-item-group__title"> {{ title }} </div>
        <div v-if="count > 0" class="todo-list-item-group__count"> {{ count }} </div>
      </div>
      <div v-if="hasSettings" class="todo-list-item-group__header-append" role="button" tabindex="0"
           :title="$t('statsE.TodoGroupBlock.groupViewOptions')" @click.stop="gear" @keydown.enter.prevent="gear">
        <i class="todo-list-item-group__btn-settings todo-list-item-group__btn-settings-char">&#9881;</i>
      </div>
      <div v-if="hasRecomplete" class="todo-list-item-group__header-append" role="button" tabindex="0"
           style="margin-left:8px;color:var(--danger)" @click.stop="recomplete" @keydown.enter.prevent="recomplete">{{ $t('statsE.TodoGroupBlock.rescheduleBtn') }}</div>
    </div>
    <div class="todo-list-item-group-container">
      <!-- transition-group: when a task completes, the old group fades out, the new group fades in, and remaining entries FLIP smoothly into place -->
      <transition-group v-show="!collapsed" name="listfade" tag="div" class="todo-list-item-group-container__list">
        <todo-item v-for="t in todos" :key="t.taskId" :todo="t" :show-date-badge="showDate"/>
      </transition-group>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Group header component (shared by three views) -- aligned with the TodoListItemGroup + GroupContainer reference
 * a11y: the header supports Tab + Enter to toggle collapse
 */
import TodoItem from './TodoItem.vue'

export default {
  name: 'TodoGroupBlock',
  components: { TodoItem },
  props: {
    title: { type: String, default: '' },
    count: { type: Number, default: 0 },
    color: { type: String, default: '' },
    hasSettings: { type: Boolean, default: false },
    hasRecomplete: { type: Boolean, default: false },
    collapsed: { type: Boolean, default: false },
    todos: { type: Array as any, required: true },
    showDate: { type: Boolean, default: true }
  },
  computed: {
    groupCls () {
      return {
        'todo-list-item-group--collapsed': this.collapsed,
        'todo-list-item-group--color2': this.color === 'color2',
        'todo-list-item-group--color3': this.color === 'color3'
      }
    }
  },
  methods: {
    toggle () { this.$emit('update:collapsed', !this.collapsed) },
    gear () { this.$store.commit('ui/toggleSettings', true) },
    recomplete () { this.$emit('recomplete') }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* ---- E. 分组列表（原 TodoListItemGroup d79a80b2 / GroupList 5f948ac6 / GroupContainer bc3cef5e）---- */
.todo-list-item-group{padding:6px 0;background-color:var(--panel, #fff);box-shadow:0 2px 4px hsla(0,0%,91.4%,.5);border-top:1px solid var(--line)}
.todo-list-item-group:focus{outline:0}
.todo-list-item-group:hover{background-color:var(--hover-bg)}
.todo-list-item-group:active{background-color:var(--active-bg)}
.todo-list-item-group__header-container{display:flex;gap:6px;align-items:center;margin:0 18px}
.todo-list-item-group__header{display:flex;flex-shrink:0;align-items:center;height:26px;padding:0 8px;transition:all .3s cubic-bezier(.23,1,.32,1)}
.todo-list-item-group__header:hover{filter:brightness(.95)}
.todo-list-item-group__header-append{display:flex;flex-shrink:0;align-items:center;opacity:0;transition:all .3s cubic-bezier(.23,1,.32,1)}
.todo-list-item-group__header-container:hover .todo-list-item-group__header-append{opacity:1}
.todo-list-item-group__btn-settings{color:var(--text-4);cursor:pointer}
.todo-list-item-group__title{flex:1;margin-right:20px;margin-left:6px;color:var(--text-3);font-size: var(--fs-base)}
/* 分组标题不可编辑：用默认箭头，禁文字选中（避免 I 型输入光标与双击误选） */
.todo-list-item-group__header,
.todo-list-item-group__title { cursor: default; }
.todo-list-item-group__header-append { cursor: pointer; }
.todo-list-item-group__count{flex-shrink:0;color:#a0a0a0;font-size: var(--fs-base)}
.todo-list-item-group__arrow{display:flex;flex-shrink:0;justify-content:center;color:var(--text-4);font-size: var(--fs-sm);transition:all .3s cubic-bezier(.23,1,.32,1)}
.todo-list-item-group--collapsed{box-shadow:none}
.todo-list-item-group--collapsed .todo-list-item-group__arrow{transform:rotate(-90deg)}
.todo-list-item-group--color2 .todo-list-item-group__title{color:var(--danger-strong)}
.todo-list-item-group--color3 .todo-list-item-group__title{color:#4053d8}
/* 品牌蓝加深 6.09:1 */
.todo-list-item-group-list{display:flex;flex-direction:column;min-height:100%;box-sizing:border-box}
/* 分组列表与今日待办同构:普通文档流滚动,禁用sticky(整组sticky会吞掉高于视口的组,组头sticky则与今日待办行为不一致) */
.todo-list-item-group-list .todo-list-item-group{position:static}
.todo-list-item-group-container__list{overflow:hidden;transform-origin:top;transition:all .3s cubic-bezier(.23,1,.32,1)}
.todo-list-item-group-container__list .todo-list-item:last-child{border-bottom:none}
/* 分组行展开箭头字符尺寸与垂直居中 */
.todo-list-item-group__arrow svg{width:12px;height:12px;display:block}
.todo-list-item-group__btn-settings-char{font-size: var(--fs-base);line-height:1;font-style:normal}
/* 分组内条目与设计稿一致的「最后一行去底线」规则（我方行类为 .td-item） */
.todo-list-item-group-container__list .td-item:last-child{border-bottom:none}
/* ==================== 4. 分组头（今天 周四 N） ==================== */
/* 设计稿 grep 核实：编译 CSS 中不存在 #7fc5c6；「今天 周四」是一整串标题文本，
   .todo-list-item-group__title{color:var(--text-3);font-size: var(--fs-base)}；
   计数 .todo-list-item-group__count{color:#a0a0a0;font-size: var(--fs-base)} */
.tg-head h3 { color: #5f6368; font-size: var(--fs-base); font-weight: 400; }
/* 折叠箭头：设计稿 .todo-list-item-group__arrow{color:#c3c3c3;font-size: var(--fs-sm);
   transition:all var(--dur-slow) cubic-bezier(.23,1,.32,1)} 收起时 rotate(-90deg) */
.tg-head .arrow { color: var(--text-4); font-size: var(--fs-xs); transition: all var(--dur-slow) cubic-bezier(.23, 1, .32, 1); }
</style>
