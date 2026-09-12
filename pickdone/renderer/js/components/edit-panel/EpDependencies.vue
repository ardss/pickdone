<template>
  <div class="ep-row ep-cat-row" role="button" tabindex="0" :aria-expanded="depOpen ? 'true' : 'false'"
       @click="depOpen=!depOpen" @keydown.enter.prevent="depOpen=!depOpen">
    <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.depsLabel')"><app-icon name="link" :size="13"/></span>
    <span class="ep-cat-name is-placeholder">{{ $t('statsJ.EditPanel.depsN', { n: depPreds.length }) }}</span>
    <span class="ml-auto"></span>
    <span class="ep-row-arrow" :class="{on: depOpen}">▾</span>
  </div>
  <!-- ARIA: group (not listbox) — the rows are not selectable options, and the existing-pred
       row embeds a remove button, which would be invalid nesting inside an option -->
  <div v-if="depOpen" v-click-outside="() => depOpen = false" class="ep-cat-pop" role="group">
    <div v-for="(name, i) in depPredNames" :key="depPreds[i]" class="ep-cat-opt">
      <span class="ep-cat-dot" style="background:var(--brand)"></span> {{ name }}
      <span class="ml-auto"></span>
      <button class="close-x" :aria-label="$t('statsJ.EditPanel.depsRemove')" @click.stop="rmPred(depPreds[i])"></button>
    </div>
    <div v-for="c in depCandidates" :key="c.taskId" class="ep-cat-opt" role="button"
         tabindex="0" @click="addPred(c.taskId)" @keydown.enter.prevent="addPred(c.taskId)">
      <span class="ep-cat-dot" style="background:var(--text-4)"></span> + {{ c.taskContent }}
    </div>
    <!-- Candidate list is capped (render cost); make the truncation explicit instead of silently hiding the rest -->
    <div v-if="depTotal > depCandidates.length" class="ep-dep-truncated" role="note">
      {{ $t('statsJ.EditPanel.depsTruncated', { shown: depCandidates.length, total: depTotal }) }}
    </div>
  </div>
</template>

<script lang="ts">
/**
 * EditPanel dependencies block (S4 split 2026-09-12): predecessor multi-select
 * (experimental feature). Reads the todo store directly for names/candidates and
 * emits the merged/filtered predecessors JSON; EditPanel applies it to the task
 * snapshot through the unified save pipeline. Rendered only under the devMode
 * gate owned by the parent (developerMode && showDepsModule).
 */
export default {
  name: 'EpDependencies',
  props: {
    /** The panel's hydrated task snapshot (EditPanel's `e`). */
    task: { type: Object as any, default: null }
  },
  emits: ['patch'],
  data () {
    return {
      depOpen: false
    }
  },
  computed: {
    depPreds () { // parse predecessors of the task under edit
      try { const a = JSON.parse((this.task && this.task.predecessors) || '[]'); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { return [] }
    },
    depPredNames () {
      const byId = {}
      for (const t of this.$store.state.todo.todoList) byId[t.taskId] = t
      return this.depPreds.map(id => (byId[id] && (byId[id].taskContent || byId[id].taskId)) || id)
    },
    depCandidates () { // undone tasks (excl. self & existing preds), first 8 by recency
      return this.allDepCandidates().slice(0, 8)
    },
    depTotal () { // full candidate count before the render cap (drives the truncation notice)
      return this.allDepCandidates().length
    }
  },
  methods: {
    allDepCandidates () {
      const have = new Set(this.depPreds)
      const self = this.task && this.task.taskId
      return this.$store.state.todo.todoList
        .filter(t => !t.delete && !t.complete && t.taskId !== self && !have.has(t.taskId) && t.taskContent)
    },
    addPred (id) {
      if (!id || this.depPreds.includes(id)) return
      // Stay expanded after adding (symmetric with rmPred): multi-select workflows add several
      // predecessors in a row; force-collapsing made that a repeated reopen dance
      this.$emit('patch', JSON.stringify(this.depPreds.concat(id)))
    },
    rmPred (id) {
      this.$emit('patch', JSON.stringify(this.depPreds.filter(x => x !== id)))
    }
  }
}
</script>

<style>
/* EditPanel dependencies block styles (S4 split: moved verbatim from EditPanel.vue; global, ep- prefixed) */
/* Dependency candidate truncation notice (list is render-capped at 8) */
.ep-dep-truncated { padding: 6px 8px 2px; font-size: var(--fs-xs); color: var(--text-3); }
</style>
