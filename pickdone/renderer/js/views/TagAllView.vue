<template>

  <div class="view-page tagall-page">
    <div class="page__header page__header--no-shadow"><h1>{{ $t('statsC.TagAll.title') }}</h1></div>
    <div v-if="!tags.length" class="tagall-empty">{{ $t('statsC.TagAll.emptyHint') }}</div>
    <div v-else class="tagall-grid">
      <span v-for="t in tags" :key="t.name" class="ep-tag-chip tagall-chip" role="link" tabindex="0"
            @click="goTag(t.name)" @keydown.enter.prevent="goTag(t.name)">
        #{{ t.name }} <em class="tagall-count">{{ t.count }}</em>
      </span>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * All tags overview —— entry page for the sidebar's "all tags" item
 * Tags are virtually derived from #xxx in task text; this page aggregates all tags + occurrence counts; clicking opens that tag's TagView
 */
import { extractTags } from '../utils/search.js'

export default {
  name: 'TagAllView',
  computed: {
    tags () {
      const set = new Map()
      for (const t of this.$store.state.todo.todoList.filter(x => !x.delete)) {
        for (const tag of extractTags(t.taskContent, t.taskDescribe)) {
          set.set(tag, (set.get(tag) || 0) + 1)
        }
      }
      // The empty-tag placeholder (created via the sidebar's "new tag") is also included in the overview
      for (const name of this.$store.state.ui.userTags) {
        if (!set.has(name)) set.set(name, 0)
      }
      return [...set.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }
  },
  methods: {
    goTag (name) { this.$router.push({ name: 'todo-list-tag', params: { id: name } }).catch(() => {}) }
  },

}
</script>
<style>/* ---- 所有标签总览页（侧边栏「所有标签」入口，2026-08-28） ---- */
.tagall-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); padding-top: 6px; }
.tagall-chip { cursor: pointer; font-size: var(--fs-md); padding: var(--space-1) 12px; border-radius: 15px; }
.tagall-chip:hover { color: var(--brand); }
.tagall-count { font-style: normal; color: var(--text-3); font-size: var(--fs-xs); }
.tagall-empty { padding-top: var(--space-5); font-size: var(--fs-md); color: var(--text-3); }
</style>
