<template>
  <!-- Extracted verbatim from SideNav.vue (2026-09-12 split, zero behavior change): manage-tags dialog;
       rename/delete = rewriting the #tag across all task content and descriptions in sync.
       Stays mounted with the sidebar so el-dialog keeps its native open/close transition -->
  <el-dialog :title="$t('statsG.SideNav.manageTagTitle')" v-model="visible" width="420px" append-to-body class="cat-mgr-dialog" @closed="$emit('close')">
    <div class="cat-mgr-tip">{{ $t('statsG.SideNav.tagMgrTip') }}</div>
    <div v-for="t in tags" :key="t.name" class="cat-mgr-row cat-mgr-row--tag">
      <i class="cat-mgr-drag" :title="$t('statsG.SideNav.tagTitle')"><app-icon name="tag" :size="13"/></i>
      <input v-if="tagMgrEditing===t.name" v-model="tagMgrName" class="sn-cat-edit"
             @keyup.enter="renameTag(t)" @blur="renameTag(t)"/>
      <span v-else class="cat-mgr-name" role="button" tabindex="0" :title="$t('statsG.SideNav.clickRenameTitle')"
            @click="tagMgrEditing=t.name; tagMgrName=t.name" @keydown.enter.prevent="tagMgrEditing=t.name">{{t.name}}</span>
      <em class="cat-mgr-count">{{ $t('statsG.SideNav.countItems', { n: t.count }) }}</em>
      <button class="cat-mgr-del" @click="removeTag(t)">{{ $t('statsG.SideNav.deleteBtn') }}</button>
    </div>
    <div v-if="!tags.length" class="cat-mgr-tip" style="padding:12px 2px">{{ $t('statsG.SideNav.noTagsTip') }}</div>
    <template #footer>
      <el-button size="small" type="primary" @click="visible=false">{{ $t('statsG.SideNav.doneBtn') }}</el-button>
    </template>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { extractTags } from '../../utils/search.js'

export default defineComponent({
  name: 'SnManageTagsModal',
  props: {
    open: { type: Boolean, default: false }
  },
  emits: ['close'],
  data () {
    return {
      // Mirrors the `open` prop; the el-dialog transition runs against this local flag
      visible: false,
      // Manage tags modal: renaming/deleting a tag = rewriting the #tag in all task content
      tagMgrEditing: null as any,
      tagMgrName: ''
    }
  },
  watch: {
    open (val) { this.visible = val }
  },
  computed: {
    /* Same derivation as SideNav/SnTagPanel (todoList #tags + empty userTags placeholders) */
    tags () {
      const set = new Map()
      for (const t of [...this.$store.state.todo.todoList]) {
        for (const tag of extractTags(t.taskContent, t.taskDescribe)) {
          set.set(tag, (set.get(tag) || 0) + 1)
        }
      }
      // Empty tags created via "New Tag" also enter the list (count 0), otherwise they disappear right after creation
      for (const name of this.$store.state.ui.userTags) {
        if (!set.has(name)) set.set(name, 0)
      }
      return [...set.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }
  },
  methods: {
    /* ===== Manage tags: rename/delete = rewrite the #tag across all task content and descriptions in sync ===== */
    tagTodos (name): any[] {
      return this.$store.state.todo.todoList.filter(t =>
        extractTags(t.taskContent, t.taskDescribe).includes(name))
    },
    async renameTag (t) {
      const next = this.tagMgrName.trim().replace(/^#/, '')
      this.tagMgrEditing = null
      if (!next || next === t.name) return
      if (this.tags.some(x => x.name === next)) return this.$message.warning(this.$t('statsG.SideNav.tagExists', { name: next }))
      const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('#' + esc + '(?=\\s|$)', 'g')
      for (const todo of this.tagTodos(t.name)) {
        const patch: any = {}
        if (todo.taskContent) {
          const v = todo.taskContent.replace(re, '#' + next)
          if (v !== todo.taskContent) patch.taskContent = v
        }
        if (todo.taskDescribe) {
          const v = todo.taskDescribe.replace(re, '#' + next)
          if (v !== todo.taskDescribe) patch.taskDescribe = v
        }
        if (Object.keys(patch).length) await this.$store.dispatch('todo/updateTodoFields', { taskId: todo.taskId, patch })
      }
      this.$message.success(this.$t('statsG.SideNav.tagRenamed', { name: next }))
    },
    async removeTag (t) {
      try {
        await this.$confirm(this.$t('statsG.SideNav.delTagConfirm', { name: t.name, count: this.tagTodos(t.name).length }), this.$t('statsE.SideNav.tipTitle'), { type: 'warning' })
      } catch { return }
      const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g')
      for (const todo of this.tagTodos(t.name)) {
        const patch: any = {}
        if (todo.taskContent) {
          const v = todo.taskContent.replace(re, '').trim()
          if (v !== todo.taskContent) patch.taskContent = v
        }
        if (todo.taskDescribe) {
          const v = todo.taskDescribe.replace(re, '').trim()
          if (v !== todo.taskDescribe) patch.taskDescribe = v
        }
        if (Object.keys(patch).length) await this.$store.dispatch('todo/updateTodoFields', { taskId: todo.taskId, patch })
      }
      this.$message.success(this.$t('statsG.SideNav.tagDeleted', { name: t.name }))
    }
  }
})
</script>

<style>
/* Shared cat-mgr row rules (copy of the block in SnManageCategoriesModal.vue — this dialog can
   mount on its own, and both are v-if components, so each carries the styles it renders) */
.cat-mgr-tip { font-size: var(--fs-sm); color: var(--text-3); padding: 0 2px 10px; }
.cat-mgr-row {
  display: flex; align-items: center; gap: 10px;
  height: 42px; padding: 0 8px; font-size: var(--fs-md); color: var(--text-1);
  border-bottom: 1px solid var(--line); background: var(--panel, #fff); cursor: grab;
}
.cat-mgr-row:last-of-type { border-bottom: none; }
.cat-mgr-row:hover { background: var(--gray-bg); }
.cat-mgr-row { transition: background var(--dur-fast), transform var(--dur-fast); }
.cat-mgr-row { position: relative; }
.cat-mgr-drag { font-style: normal; color: var(--text-3); font-size: var(--fs-base); cursor: grab; flex-shrink: 0; }
.cat-mgr-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; cursor: text;
}
.cat-mgr-name:hover { color: var(--brand); }
.cat-mgr-count { font-style: normal; flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-3); }
.cat-mgr-del {
  flex-shrink: 0; font-size: var(--fs-sm); color: var(--text-3);
  padding: 3px 8px; border-radius: var(--radius-sm); transition: all var(--dur-fast);
}
.cat-mgr-del:hover { color: var(--danger); background: var(--danger-soft); }
html[data-theme="dark"] .cat-mgr-row { background: var(--gray-bg); }
</style>
