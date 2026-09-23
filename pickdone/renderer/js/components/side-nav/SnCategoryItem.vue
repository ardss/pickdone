<template>
  <!-- One sidebar category row. Maint/dw-wave2 (domain-2): the folder / child / flat variants were
       three near-verbatim template copies inside SideNav.vue (each with its own inline sn-cat-edit
       input and rename/del icon pair); they are consolidated here and differ only via props.
       All state (editing/drag/fold) and every mutation stay in the parent — the child only re-emits. -->
  <div class="sn-cat-item"
       :class="[variantClass, {
         active: active,
         'drag-over-before': draggable && dragOver && dragPos==='before',
         'drag-over-after': draggable && dragOver && dragPos==='after',
         dragging: draggable && dragging,
         busy: isFlat && busy
       }]"
       :role="isFolder ? 'button' : 'link'" tabindex="0" :draggable="draggable ? 'true' : null"
       :title="$t('statsG.SideNav.dblclickRenameTip')"
       :aria-expanded="isFolder ? (expanded ? 'true' : 'false') : null"
       @click="$emit(isFolder ? 'toggle' : 'open')"
       @keydown.enter.prevent="$emit(isFolder ? 'toggle' : 'open')"
       @dblclick.stop="$emit('rename')"
       @dragstart="draggable && $emit('drag-start', $event)"
       @dragover.prevent="draggable && $emit('drag-over', $event)"
       @drop.prevent="draggable && $emit('drop', $event)"
       @dragend="draggable && $emit('drag-end')">
    <app-icon v-if="isFolder" name="folder" :size="14" :style="{color:cat.categoryColor}"/>
    <span v-else-if="isChild" class="sn-dot" :style="{background:cat.categoryColor}"></span>
    <span v-else class="sn-dot" :style="{borderColor:cat.categoryColor, background:cat.categoryColor}"></span>
    <template v-if="editing">
      <input :value="newCatName" class="sn-cat-edit"
             @input="$emit('edit-input', $event.target.value)"
             @keydown.enter.prevent="$emit('edit-enter', $event)"
             @keydown.esc.prevent="$emit('edit-cancel')"
             @blur="$emit('edit-save')"/>
    </template>
    <template v-else><span :class="{'sn-cat-name': isFolder}">{{cat.categoryName}}</span></template>
    <i v-if="isFolder" class="folder-toggle-icon"><app-icon :name="expanded?'chevron-down':'chevron-right'" :size="11"/></i>
    <i class="sn-cat-del sn-cat-ren" role="button" tabindex="0" :aria-label="$t('statsG.SideNav.renameCatAria')" style="display:inline-flex"
       :title="$t('statsG.SideNav.renameCatTitle')" @click.stop="$emit('rename')" @keydown.enter.prevent.stop="$emit('rename')"><app-icon name="edit" :size="12"/></i>
    <i class="sn-cat-del" role="button" tabindex="0" :aria-label="$t('statsG.SideNav.delCatAria')" style="display:inline-flex"
       :title="$t('statsG.SideNav.delCatTitle')" @click.stop="$emit('del')" @keydown.enter.prevent.stop="$emit('del')"><app-icon name="trash" :size="12"/></i>
  </div>
</template>

<script lang="ts">
/** Sidebar category row (folder / child / flat), extracted verbatim from SideNav.vue's three copies.
 *  Pure presentational: state + handlers live in the parent via the events below. */
export default {
  name: 'SnCategoryItem',
  props: {
    /** category record (categoryId / categoryName / categoryColor) */
    cat: { type: Object, required: true },
    /** 'folder' | 'child' | 'flat' — the three former template copies */
    variant: { type: String, required: true },
    /** folder rows: current expand state (drives aria-expanded + chevron) */
    expanded: { type: Boolean, default: false },
    /** route-active highlight (child/flat) */
    active: { type: Boolean, default: false },
    /** inline rename active for this row */
    editing: { type: Boolean, default: false },
    /** parent-owned rename buffer (value of the inline input) */
    newCatName: { type: String, default: '' },
    /** drag-over highlight state (folder/flat) */
    dragOver: { type: Boolean, default: false },
    /** 'before' | 'after' — insert indicator side */
    dragPos: { type: String, default: null },
    /** this row is the drag source */
    dragging: { type: Boolean, default: false },
    /** D6-F4 busy flag (flat rows only): cascade delete in flight */
    busy: { type: Boolean, default: false }
  },
  emits: ['toggle', 'open', 'rename', 'del', 'edit-input', 'edit-enter', 'edit-cancel', 'edit-save', 'drag-start', 'drag-over', 'drop', 'drag-end'],
  computed: {
    isFolder () { return this.variant === 'folder' },
    isChild () { return this.variant === 'child' },
    isFlat () { return this.variant === 'flat' },
    variantClass () { return this.isFolder ? 'sn-cat-folder' : (this.isChild ? 'sn-cat-child' : '') },
    draggable () { return this.isFolder || this.isFlat }
  }
}
</script>
