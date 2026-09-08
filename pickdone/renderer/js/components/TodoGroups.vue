<template>

  <div class="td-groups">
    <div v-if="!hasAny" class="empty-state">
      <img src="app://app/assets/img/todo-list-empty.svg" alt="" draggable="false">
      <p>{{emptyText || $t('statsH.TodoGroups.empty')}}</p>
    </div>
    <section v-for="g in groups.filter(x=>x.todos.length||!x.hideEmpty)" :key="g.key" class="tg-group">
      <header class="tg-head" role="button" tabindex="0"
              :aria-expanded="isOpen(g.key) ? 'true' : 'false'" :aria-label="$t('statsH.TodoGroups.toggleGroup', { label: g.label })"
              @click="toggle(g.key)" @keydown.enter.prevent="toggle(g.key)">
        <i class="arrow" :class="{open:isOpen(g.key)}" aria-hidden="true"><svg viewBox="0 0 256 512"><path fill="currentColor" d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 34 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 34 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z"/></svg></i>
        <h3 :class="{brand:g.brand}">{{g.label}}</h3>
        <span v-if="weekLabel(g)" class="tg-week">{{weekLabel(g)}}</span>
        <em v-if="g.count!=null">{{g.count}}</em>
      </header>
      <transition name="collapse"
                  @before-enter="colBeforeEnter" @enter="colEnter" @after-enter="colAfterEnter"
                  @before-leave="colBeforeLeave" @leave="colLeave" @after-leave="colAfterLeave">
        <div v-show="isOpen(g.key)" class="tg-body">
          <transition-group name="listfade" tag="div">
            <todo-item v-for="t in g.todos" :key="t.taskId" :todo="t" :group-key="g.key"
                       :show-date-badge="showDateBadge" :query="query"/>
          </transition-group>
        </div>
      </transition>
    </section>
  </div>
</template>

<script lang="ts">
/** Grouped list -- group header style aligned with the project baseline (▾ Today Thu 13) */
import TodoItem from './TodoItem.vue'
import { dayjs } from '../utils/core.js'

// [component-fixes] pure-start (extracted verbatim by tests/component-fixes-renderer.test.mjs)
/** Drop stale persisted fold keys: an `expired-<dayStartTs>` key whose timestamp is before today's
 *  start can never match a group again (the timestamp drifts daily) and would accumulate forever
 *  in settings.foldedTodoList. Non-expired keys pass through untouched. */
function pruneExpiredFoldKeys (list, todayStart0) {
  return (list || []).filter(k => {
    const s = String(k)
    return !(s.startsWith('expired-') && Number(s.slice('expired-'.length)) < todayStart0)
  })
}
// [component-fixes] pure-end

export default {
  name: 'TodoGroups',
  components: { TodoItem },
  props: {
    groups: { type: Array as any, required: true },
    showDateBadge: { type: Boolean, default: true },
    query: { type: String, default: '' },
    emptyText: { type: String, default: '' }
  },
  computed: {
    folded () { return this.$store.state.settings.foldedTodoList },
    hasAny () { return this.groups.some(g => g.todos.length) }
  },
  methods: {
    isOpen (key) { return !this.folded.includes(key) },
    toggle (key) {
      const next = this.folded.includes(key) ? this.folded.filter(k => k !== key) : [...this.folded, key]
      // Persist only still-matchable keys: expired groups from previous days drift away daily and must not pile up in settings
      const list = pruneExpiredFoldKeys(next, +dayjs().startOf('day'))
      this.$store.commit('settings/updateSettings', { foldedTodoList: list })
    },
    weekLabel (g) {
      // "Today Thu"-style sub-label (reuses DayDateStrip's weekday keys)
      if (!g.weekOf) return ''
      return this.$t('statsD.DayDateStrip.wd' + dayjs(g.weekOf).day())
    },
    /** Group collapse/expand: JS hooks write explicit heights so the CSS height transition actually fires
     *  (the old name="collapse" only has Vue2 class hooks; under Vue3 no attribute changes at all, leaving just idle delay).
     *  The target height must be written inside rAF: writing it in the same frame as the start state skips style calculation and the animation jumps */
    colBeforeEnter (el) { el.style.height = '0'; el.style.opacity = '0' },
    colEnter (el) {
      requestAnimationFrame(() => { el.style.height = el.scrollHeight + 'px'; el.style.opacity = '1' })
    },
    colAfterEnter (el) { el.style.height = ''; el.style.opacity = '' },
    colBeforeLeave (el) { el.style.height = el.scrollHeight + 'px' },
    colLeave (el) {
      requestAnimationFrame(() => { el.style.height = '0'; el.style.opacity = '0' })
    },
    colAfterLeave (el) { el.style.height = ''; el.style.opacity = '' }
  },

}
</script>
<style>.tg-week { color: #5f6368; font-size: var(--fs-base); }
</style>
