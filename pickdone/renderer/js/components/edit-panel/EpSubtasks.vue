<template>
  <div class="ep-subs" ref="subList">
    <!-- Stable per-row key (`_key` minted by the parent on hydrate/add): the index key desynced
         rows after Sortable moved DOM nodes / concurrent removals -->
    <div v-for="(s,i) in subs" :key="s._key != null ? s._key : s.text + '_' + i" class="ep-sub">
      <span class="ep-sub-check" :class="{on:s.checked}" role="checkbox" :aria-checked="s.checked ? 'true' : 'false'"
            tabindex="0" @click.stop="toggleSub(s)" @keydown.enter.prevent.stop="toggleSub(s)">{{ s.checked ? '✓' : '' }}</span>
      <span v-if="renameIndex !== i" class="ep-sub-text" :class="{strike:s.checked}" role="button" tabindex="0"
            :aria-label="s.text" @click="toggleSub(s)" @dblclick="startRename(i)"
            @keydown.enter.prevent.stop="startRename(i)">{{s.text}}</span>
      <!-- [R2] Inline rename: double-click (or Enter on the focused text) opens the editor; Enter/blur
           commits via the 'rename' emit, Esc cancels. commitRename is re-entrant-safe (blur after the
           Enter commit is a no-op because renameIndex was already reset). -->
      <input v-else v-model="renameText" class="ep-sub-rename-input" :aria-label="$t('statsJ.EditPanel.addSubtask')"
             @keydown.enter.prevent.stop="onRenameEnter(i, $event)" @keydown.esc.prevent.stop="cancelRename" @blur="commitRename(i)"/>
      <b class="ep-sub-x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.deleteSubtask')"
         @click.stop="delSub(i)" @keydown.enter.prevent.stop="delSub(i)"></b>
      <b class="ep-sub-drag">≡</b>
      <span class="ep-sub-move">
        <i role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.moveSubtaskUp')" @click.stop="moveSub(i,-1)" @keydown.enter.prevent.stop="moveSub(i,-1)">↑</i><i role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.moveSubtaskDown')" @click.stop="moveSub(i,1)" @keydown.enter.prevent.stop="moveSub(i,1)">↓</i>
      </span>
    </div>
    <div class="ep-row ep-addsub">
      <img class="ep-ico" src="app://app/assets/img/icon-sublist.svg">
      <input v-model="newSub" :placeholder="$t('statsJ.EditPanel.addSubtaskAria')+subDoneText" :aria-label="$t('statsJ.EditPanel.addSubtask')" @keydown.enter="onSubEnter" class="ep-addsub-input"/>
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
  emits: ['add', 'toggle', 'remove', 'move', 'rename'],
  data () {
    return {
      newSub: '',
      // [R2] inline rename state: index of the row being renamed ('' = none) + the edit buffer
      renameIndex: -1,
      renameText: ''
    }
  },
  computed: {
    subDoneText () {
      const d = this.subs.filter(s => s.checked).length
      return this.subs.length ? `(${d}/${this.subs.length})` : ''
    }
  },
  methods: {
    // IME guard: keyup.enter can't see the 229 composition flag, so listen on keydown and
    // skip the Enter that commits an IME composition
    onSubEnter (e) {
      if (e.isComposing || e.keyCode === 229) return
      this.addSub()
    },
    // IME guard for the inline rename editor: the Enter that ends a pinyin composition arrives as
    // keydown (isComposing / keyCode 229) and must not commit the half-converted pinyin —
    // same rule as onSubEnter above (fix for the D4-ime finding: commitRename had no guard)
    onRenameEnter (i, e) {
      if (e.isComposing || e.keyCode === 229) return
      this.commitRename(i)
    },
    addSub () {
      const text = this.newSub.trim()
      if (!text) return
      this.$emit('add', text)
      this.newSub = ''
    },
    toggleSub (s) { this.$emit('toggle', s) },
    delSub (i) { this.$emit('remove', i) },
    moveSub (i, dir) { this.$emit('move', i, dir) },
    // [R2] inline rename: open the editor, commit via 'rename' (parent owns subList + save pipeline), cancel on Esc
    startRename (i) {
      const s = this.subs[i]
      if (!s) return
      this.renameIndex = i
      this.renameText = s.text
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('.ep-sub-rename-input')
        if (el) el.focus()
      })
    },
    commitRename (i) {
      // blur fires after an Enter commit removed the editor — re-entrancy guard
      if (this.renameIndex !== i) return
      const text = (this.renameText || '').trim()
      this.renameIndex = -1
      this.renameText = ''
      if (!text || !this.subs[i] || text === this.subs[i].text) return
      this.$emit('rename', i, text)
    },
    cancelRename () {
      this.renameIndex = -1
      this.renameText = ''
    }
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
.ep-addsub-input::placeholder { color: var(--text-4); }
/* [R2] inline rename editor: same metrics as the row text so the swap is visually seamless */
.ep-sub-rename-input { flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--brand); background: none; font-size: var(--fs-md); color: var(--text-1); padding: 0 2px; }
/* 子任务 ✕ 与 ≡ hover 该行才显示
   （设计稿 .todo-sublist-editor__delete(青灰叉)/__move(bars,#9b9b9b)） */
.ep-sub-x, .ep-sub-drag { opacity: 0; transition: opacity var(--dur-mid); }
.ep-sub:hover .ep-sub-x, .ep-sub:hover .ep-sub-drag { opacity: 1; }
.ep-sub-x { color: #a8b2f7; }
.ep-sub-x:hover { color: var(--danger); }
.ep-sub-drag { color: var(--text-3); cursor: grab; }
</style>
