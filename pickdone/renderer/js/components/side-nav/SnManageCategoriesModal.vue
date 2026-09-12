<template>
  <!-- Extracted verbatim from SideNav.vue (2026-09-12 split, zero behavior change): manage-categories
       dialog with its own mgrDrag* sort state machine; connects directly to the category store.
       Stays mounted with the sidebar so el-dialog keeps its native open/close transition:
       `open` prop drives visibility, `close` is emitted after the leave animation (dialog closed) -->
  <el-dialog :title="$t('statsG.SideNav.manageCatTitle')" v-model="visible" width="460px" append-to-body class="cat-mgr-dialog" @closed="$emit('close')">
    <div class="cat-mgr-tip">{{ $t('statsG.SideNav.catMgrTip') }}</div>
    <div class="cat-mgr-head" aria-hidden="true">
      <span class="cat-mgr-hname">{{ $t('statsG.SideNav.catSection') }}</span><span class="cat-mgr-hcount">{{ $t('statsG.SideNav.unfinishedHeader') }}</span><span class="cat-mgr-hops">{{ $t('statsG.SideNav.opsHeader') }}</span>
    </div>
    <template v-for="c in categories" :key="c.categoryId">
    <div class="cat-mgr-row"
         :class="{ 'cat-mgr-row--dragging': mgrDragId === c.categoryId,
                   'cat-mgr-row--over-before': mgrDragOverId === c.categoryId && mgrDragPos === 'before',
                   'cat-mgr-row--over-after': mgrDragOverId === c.categoryId && mgrDragPos === 'after' }"
         draggable="true"
         @dragstart="dragMgrStart(c,$event)" @dragover.prevent="dragMgrOver(c,$event)" @drop.prevent="dropMgrOn(c)" @dragend="mgrDragId=null; mgrDragOverId=null; mgrDragPos=null">
      <i class="cat-mgr-drag" :title="$t('statsG.SideNav.dragSortTitle')"><app-icon name="dots" :size="13"/></i>
      <span class="sn-dot" :style="{borderColor:c.categoryColor, background:c.categoryColor}"></span>
      <input v-if="mgrEditing===c.categoryId" v-model="mgrName" class="sn-cat-edit"
             @keyup.enter="saveMgrEdit(c)" @blur="saveMgrEdit(c)"/>
      <span v-else class="cat-mgr-name" role="button" tabindex="0" :title="$t('statsG.SideNav.clickRenameTitle')"
            @click="startMgrEdit(c)" @keydown.enter.prevent="startMgrEdit(c)">{{c.categoryName}}</span>
      <em class="cat-mgr-count" role="button" tabindex="0" :title="$t('statsG.SideNav.previewTitle')"
          @click="toggleMgrPreview(c.categoryId)"
          @keydown.enter.prevent="toggleMgrPreview(c.categoryId)"
          @keydown.space.prevent="toggleMgrPreview(c.categoryId)">{{ $t('statsG.SideNav.countItems', { n: countOf(c.categoryId) }) }}
        <app-icon :name="mgrExpanded[c.categoryId] ? 'chevron-up' : 'chevron-down'" :size="11"/></em>
      <button class="cat-mgr-del" :class="{'cat-mgr-del--on': isProject(c.categoryId)}" @click="toggleProject(c)">{{isProject(c.categoryId) ? $t('statsE.SideNav.cancelProject') : $t('statsG.SideNav.setProjectBtn')}}</button>
      <button class="cat-mgr-del" @click="removeMgrCat(c)">{{ $t('statsG.SideNav.deleteBtn') }}</button>
    </div>
    <div v-if="mgrExpanded[c.categoryId]" class="cat-mgr-preview">
      <div v-for="(title,i) in previewOf(c.categoryId)" :key="i" class="cat-mgr-preview__item">· {{title}}</div>
      <div v-if="!previewOf(c.categoryId).length" class="cat-mgr-preview__item cat-mgr-preview__empty">{{ $t('statsG.SideNav.noUnfinished') }}</div>
      <div v-if="countOf(c.categoryId) > 5" class="cat-mgr-preview__more">{{ $t('statsG.SideNav.moreItems', { n: countOf(c.categoryId) }) }}</div>
    </div>
    </template>
    <template #footer>
      <el-button size="small" type="primary" @click="visible=false">{{ $t('statsG.SideNav.doneBtn') }}</el-button>
    </template>
  </el-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'SnManageCategoriesModal',
  props: {
    open: { type: Boolean, default: false }
  },
  emits: ['close'],
  data () {
    return {
      // Mirrors the `open` prop; the el-dialog transition runs against this local flag
      visible: false,
      // Manage categories modal: inline rename / delete (with confirmation) / item count / drag sorting
      mgrEditing: null as any,
      mgrName: '',
      mgrDragId: null as any,
      mgrDragOverId: null as any,
      mgrDragPos: null,      // drop position: 'before' | 'after' (gap-level indicator)
      mgrExpanded: {}        // expanded state of the category content preview
    }
  },
  computed: {
    categories () { return this.$store.getters['category/sortedAll'] }
  },
  watch: {
    open (val) { this.visible = val }
  },
  methods: {
    countOf (id) {
      // Exclude recycle-bin rows: previewOf already filters !t.delete — the badge and the
      // preview must agree (the badge used to count deleted rows and read inflated)
      return this.$store.state.todo.todoList.filter(t => t.categoryId === id && !t.complete && !t.delete).length
    },
    isProject (id) { return this.$store.state.category.projectIds.includes(id) },
    /** Set/unset as project (secondary path; the primary entry is "New Project" on the project overview page) */
    toggleProject (c) {
      const flag = !this.isProject(c.categoryId)
      this.$store.commit('category/setProject', { id: c.categoryId, flag })
      this.$message.success(flag ? this.$t('statsG.SideNav.setProject', { name: c.categoryName }) : this.$t('statsG.SideNav.unsetProject', { name: c.categoryName }))
    },
    startMgrEdit (c) {
      this.mgrEditing = c.categoryId
      this.mgrName = c.categoryName
      this.$nextTick(() => {
        // append-to-body moves the dialog DOM under document.body, so component-root queries
        // miss it — query at document level (defensive pattern per EditPanel's datePick ref)
        const inp = document.querySelector('.cat-mgr-dialog input.sn-cat-edit')
        if (inp) { inp.focus(); inp.select() }
      })
    },
    saveMgrEdit (c) {
      if (this.mgrEditing !== c.categoryId) return
      this.$store.commit('category/updateCategory', { categoryId: c.categoryId, categoryName: this.mgrName.trim() || c.categoryName })
      this.mgrEditing = null
    },
    dragMgrStart (c, e) {
      this.mgrDragId = c.categoryId
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(c.categoryId))
    },
    dragMgrOver (c, e) {
      if (this.mgrDragId == null || this.mgrDragId === c.categoryId) return
      const rect = e.currentTarget.getBoundingClientRect()
      this.mgrDragPos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
      this.mgrDragOverId = c.categoryId
    },
    dropMgrOn (c) {
      const from = this.mgrDragId
      const pos = this.mgrDragPos
      this.mgrDragId = null
      this.mgrDragOverId = null
      this.mgrDragPos = null
      if (from == null || from === c.categoryId) return
      const ids = this.categories.map(x => x.categoryId)
      const fi = ids.indexOf(from)
      let ti = ids.indexOf(c.categoryId)
      if (fi < 0 || ti < 0) return
      ids.splice(fi, 1)
      if (fi < ti) ti -= 1 // remove before inserting; the drop index is corrected for the visual position
      ids.splice(pos === 'after' ? ti + 1 : ti, 0, from)
      this.$store.commit('category/reorder', ids)
    },
    /** Category content preview: first 5 incomplete task titles */
    previewOf (id) {
      return this.$store.state.todo.todoList
        .filter(t => t.categoryId === id && !t.complete && !t.delete)
        .slice(0, 5).map(t => t.taskContent)
    },
    toggleMgrPreview (id) { this.mgrExpanded = { ...this.mgrExpanded, [id]: !this.mgrExpanded[id] } },
    async removeMgrCat (c) { await this.delCat(c) },
    /* Delete path copied verbatim from SideNav.vue (the sidebar rows/trash keep their own copy): the
       modal needs the same confirm + soft-delete + task-detach + settings-keys cleanup sequence */
    async delCat (c) {
      try {
        await this.$confirm(this.$t('statsG.SideNav.delCatConfirm', { name: c.categoryName }), this.$t('statsE.SideNav.tipTitle'), { type: 'warning' })
      } catch { return } // user cancelled; leave the data untouched
      this.$store.commit('category/softDelete', c.categoryId)
      if (this.isProject(c.categoryId)) this.$store.commit('category/setProject', { id: c.categoryId, flag: false })
      for (const t of this.$store.state.todo.todoList.filter(x => x.categoryId === c.categoryId)) {
        await this.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { categoryId: 0 } })
      }
      // Clean up settings keys pointing at the dead category id: otherwise the todo box filtered by that category stays forever empty (showing 0 items even after data restore)
      const st: any = this.$store.state.settings
      const reset: any = {}
      if (st.todoBoxCategoryId === c.categoryId) reset.todoBoxCategoryId = -1
      if (st.newTodoCategoryId === c.categoryId) reset.newTodoCategoryId = 0
      if (st.calendarCategory === c.categoryId) reset.calendarCategory = 0
      if (Object.keys(reset).length) this.$store.commit('settings/updateSettings', reset)
    }
  }
})
</script>

<style>
/* cat-mgr rules moved here from SideNav.vue (this dialog is their only primary owner);
   the tag dialog carries its own copy of the shared row rules (both are v-if mounted) */
.cat-mgr-tip { font-size: var(--fs-sm); color: var(--text-3); padding: 0 2px 10px; }
.cat-mgr-row {
  display: flex; align-items: center; gap: 10px;
  height: 42px; padding: 0 8px; font-size: var(--fs-md); color: var(--text-1);
  border-bottom: 1px solid var(--line); background: var(--panel, #fff); cursor: grab;
}
.cat-mgr-row:last-of-type { border-bottom: none; }
.cat-mgr-row:hover { background: var(--gray-bg); }
.cat-mgr-row { transition: background var(--dur-fast), transform var(--dur-fast); }
.cat-mgr-row:hover .cat-mgr-drag { color: var(--brand); }
.cat-mgr-row--dragging { opacity: .4; transform: scale(.99); cursor: grabbing; }
/* 拖拽落点指示：独立伪元素横线浮在两行交界的缝隙上（上沿=插到前面，下沿=插到后面），
   首行上沿/末行下沿同样生效；3px 青色圆角线 + 光晕，确保可见 */
.cat-mgr-row { position: relative; }
.cat-mgr-row--over-before::before,
.cat-mgr-row--over-after::after {
  content: ''; position: absolute; left: 6px; right: 6px; height: 3px;
  border-radius: var(--radius-xs); background: var(--brand);
  box-shadow: 0 0 6px rgba(15, 157, 143, .55);
  z-index: 2; pointer-events: none;
}
.cat-mgr-row--over-before::before { top: -2px; }
.cat-mgr-row--over-after::after { bottom: -2px; }
/* 表头：与行同一左右内边距，形成表格感 */
.cat-mgr-head {
  display: flex; align-items: center; gap: 10px;
  padding: 0 8px 6px; font-size: var(--fs-xs); color: var(--text-3);
}
.cat-mgr-hname { flex: 1; margin-left: 40px; }
.cat-mgr-hcount { width: 52px; text-align: right; }
.cat-mgr-hops { width: 40px; text-align: center; }
/* 条目数 = 预览开关：可点击、带箭头 */
.cat-mgr-count { cursor: pointer; min-width: 52px; text-align: right; }
.cat-mgr-count:hover { color: var(--brand); }
/* 预览区：缩进浅底，展示分类内未完成任务 */
.cat-mgr-preview {
  padding: 6px 8px 8px 48px; margin: -1px 0 2px;
  background: var(--gray-bg); border-radius: var(--radius-md); font-size: var(--fs-sm); color: var(--text-2);
  animation: mgr-preview-in .15s cubic-bezier(.2, .8, .2, 1);
}
.cat-mgr-preview__item { line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-mgr-preview__empty { color: var(--text-3); }
.cat-mgr-preview__more { color: var(--text-3); font-size: var(--fs-xs); }
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
/* 管理分类弹窗：项目标记按钮选中态 */
.cat-mgr-del--on { color: var(--brand); }
.cat-mgr-del--on:hover { color: var(--brand-dark); background: var(--brand-light); }
/* 分类管理行 / 番茄计时器选项 */
html[data-theme="dark"] .cat-mgr-row { background: var(--gray-bg); }
html[data-theme="dark"] .cat-mgr-del--on:hover { background: rgba(15, 157, 143, .15); }
</style>
