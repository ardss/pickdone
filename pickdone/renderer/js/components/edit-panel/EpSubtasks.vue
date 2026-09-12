<template>
  <div class="ep-subs" ref="subList">
    <!-- Stable per-row key (`_key` minted by the parent on hydrate/add): the index key desynced
         rows after Sortable moved DOM nodes / concurrent removals -->
    <div v-for="(s,i) in subs" :key="s._key != null ? s._key : s.text + '_' + i" class="ep-sub">
      <span class="ep-sub-check" :class="{on:s.checked}" role="checkbox" :aria-checked="s.checked ? 'true' : 'false'"
            tabindex="0" @click.stop="toggleSub(s)" @keydown.enter.prevent.stop="toggleSub(s)">{{ s.checked ? '✓' : '' }}</span>
      <span class="ep-sub-text" :class="{strike:s.checked}" @click="toggleSub(s)">{{s.text}}</span>
      <b class="ep-sub-x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.deleteSubtask')"
         @click.stop="delSub(i)" @keydown.enter.prevent.stop="delSub(i)"></b>
      <b class="ep-sub-drag">≡</b>
      <span class="ep-sub-move">
        <i role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.moveSubtaskUp')" @click.stop="moveSub(i,-1)" @keydown.enter.prevent.stop="moveSub(i,-1)">↑</i><i role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.moveSubtaskDown')" @click.stop="moveSub(i,1)" @keydown.enter.prevent.stop="moveSub(i,1)">↓</i>
      </span>
    </div>
    <div class="ep-row ep-addsub">
      <img class="ep-ico" src="app://app/assets/img/icon-sublist.svg">
      <input v-model="newSub" :placeholder="$t('statsJ.EditPanel.addSubtaskAria')+subDoneText" :aria-label="$t('statsJ.EditPanel.addSubtask')" @keyup.enter="addSub" class="ep-addsub-input"/>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * EditPanel subtasks block (S4 split 2026-09-12): list view + add input + keyboard
 * move fallback. Drag sorting (Sortable) stays in EditPanel.vue because its onEnd
 * feeds the parent's save pipeline; this component only emits granular change
 * events (add/toggle/remove/move) and the parent owns subList + the save pipeline.
 */
export default {
  name: 'EpSubtasks',
  props: {
    /** Live subtask array owned by EditPanel (save-pipeline state), rendered read-only here. */
    subs: { type: Array as any, default: () => [] }
  },
  emits: ['add', 'toggle', 'remove', 'move'],
  data () {
    return {
      newSub: ''
    }
  },
  computed: {
    subDoneText () {
      const d = this.subs.filter(s => s.checked).length
      return this.subs.length ? `(${d}/${this.subs.length})` : ''
    }
  },
  methods: {
    addSub () {
      const text = this.newSub.trim()
      if (!text) return
      this.$emit('add', text)
      this.newSub = ''
    },
    toggleSub (s) { this.$emit('toggle', s) },
    delSub (i) { this.$emit('remove', i) },
    moveSub (i, dir) { this.$emit('move', i, dir) }
  }
}
</script>

<style>
/* EditPanel subtasks block styles (S4 split: moved verbatim from EditPanel.vue; global, ep- prefixed) */
.ep-sub { display: flex; align-items: center; gap: var(--space-2); padding: 6px 2px; font-size: var(--fs-md); color: var(--text-2); }
.ep-sub-text { flex: 1; min-width: 0; word-break: break-all; cursor: pointer; }
.ep-sub-x { color: var(--text-3); font-weight: 400; cursor: pointer; }
.ep-sub-x:hover { color: var(--danger); }
.ep-sub-drag { color: var(--text-3); font-weight: 400; cursor: grab; }
/* Up/Down keyboard fallback buttons: opacity (not display:none) keeps them in the Tab chain —
   visible on row hover AND whenever focus is anywhere inside the subtask row */
.ep-sub-move { opacity: 0; pointer-events: none; transition: opacity var(--dur-mid); }
.ep-sub:hover .ep-sub-move, .ep-sub:focus-within .ep-sub-move { opacity: 1; pointer-events: auto; }
.ep-sub-move i { font-style: normal; color: var(--text-3); cursor: pointer; margin-left: 3px; font-size: var(--fs-xs); }
.ep-addsub-input { flex: 1; border: 0; background: none; font-size: var(--fs-md); color: var(--text-1); }
.ep-addsub-input::placeholder { color: #8a9099; }
/* 子任务 ✕ 与 ≡ hover 该行才显示
   （设计稿 .todo-sublist-editor__delete(青灰叉)/__move(bars,#9b9b9b)） */
.ep-sub-x, .ep-sub-drag { opacity: 0; transition: opacity var(--dur-mid); }
.ep-sub:hover .ep-sub-x, .ep-sub:hover .ep-sub-drag { opacity: 1; }
.ep-sub-x { color: #a8b2f7; }
.ep-sub-x:hover { color: var(--danger); }
.ep-sub-drag { color: var(--text-3); cursor: grab; }
</style>
