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
