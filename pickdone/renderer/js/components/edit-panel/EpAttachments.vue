<template>
  <!-- section="bar": content toolbar entries; section="list": thumbnails + file rows.
       One component in two slots keeps the original DOM order (bar sits under the
       description, the lists under the deadline row). -->
  <template v-if="section === 'bar'">
    <!-- Content toolbar: image/attachment entries unified on the description area (the standalone "upload image" row was merged in, Option B) -->
    <div class="ep-attach-bar">
      <span class="ep-attach-btn" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.imagesLabel')"
            @click="$emit('pick', 'img')" @keydown.enter.prevent="$emit('pick', 'img')">
        <img class="ep-ico" src="app://app/assets/img/icon-pic.svg">{{ $t('statsJ.EditPanel.imagesLabel') }}<b v-if="imgList.length" class="ep-attach-n">{{ imgList.length }}</b>
      </span>
      <span class="ep-attach-btn" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.attachmentsLabel')"
            @click="$emit('pick', 'file')" @keydown.enter.prevent="$emit('pick', 'file')">
        <app-icon name="file" :size="12"/>{{ $t('statsJ.EditPanel.attachmentsLabel') }}<b v-if="fileList.length" class="ep-attach-n">{{ fileList.length }}</b>
      </span>
    </div>
  </template>
  <template v-else>
    <div class="ep-imgs" v-if="imgList.length">
      <div v-for="(im,i) in imgList" :key="i" class="ep-img-cell">
        <button type="button" class="ep-img-btn" :aria-label="$t('statsJ.EditPanel.zoomImage') + (Number(i)+1)" @click="$emit('preview', im.url)">
          <img :src="im.url" alt="" loading="lazy" @error="onImgErr($event)">
        </button>
        <b class="x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.removeImage')" @click.stop="$emit('remove', 'imgList', i)" @keydown.enter.prevent.stop="$emit('remove', 'imgList', i)"></b>
      </div>
    </div>
    <div v-for="(f,i) in fileList" :key="'f'+i" class="ep-file">
      <app-icon name="file" :size="12" style="opacity:.6"/> {{f.name}} <a role="button" tabindex="0" @click.prevent.stop="openFileUrl(f)" @keydown.enter.prevent.stop="openFileUrl(f)">{{ $t('statsJ.EditPanel.openBtn') }}</a> <b class="x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.removeFile')" @click.stop="$emit('remove', 'fileList', i)" @keydown.enter.prevent.stop="$emit('remove', 'fileList', i)"></b>
    </div>
  </template>
</template>

<script lang="ts">
/**
 * EditPanel attachments block (S4 split 2026-09-12): toolbar entries + thumbnails +
 * file rows. Uploads, removal (with the 5.5s disk-delete guard) and the preview mask
 * stay in EditPanel.vue because imgList/fileList are save-pipeline state owned by
 * the parent; this component emits pick/preview/remove.
 */
export default {
  name: 'EpAttachments',
  props: {
    section: { type: String as any, default: 'list' }, // 'bar' | 'list'
    imgList: { type: Array as any, default: () => [] },
    fileList: { type: Array as any, default: () => [] }
  },
  emits: ['pick', 'preview', 'remove'],
  methods: {
    /* 粘贴/上传失败的兜底：不显示 Chromium 碎图图标，改用居中感叹号占位（视觉上与关闭✕可区分） */
    onImgErr (e) { (e.target as HTMLElement).classList.add('ep-img-broken') },
    openFileUrl (f) { window.todoAPI.openFile(f.url) }
  }
}
</script>

<style>
/* EditPanel attachments block styles (S4 split: moved verbatim from EditPanel.vue; global, ep- prefixed) */
/* 内容工具条:图片/附件入口挂描述区(方案B统一入口) */
.ep-attach-bar { display: flex; align-items: center; gap: 14px; margin: 4px 0 6px; }
.ep-attach-btn { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--text-3); cursor: pointer; border-radius: var(--radius-sm); padding: 3px 6px; transition: background var(--dur-fast), color var(--dur-fast); }
.ep-attach-btn:hover { background: var(--hover-bg); color: var(--text-1); }
.ep-attach-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: -1px; }
.ep-attach-n { font-size: var(--fs-2xs); font-weight: 600; color: var(--brand); background: var(--brand-light); border-radius: 8px; padding: 0 5px; line-height: 15px; }
/* 粘贴/拖入后缩略图入场反馈 */
.ep-img-cell { animation: ep-img-in .18s ease-out; }
.ep-img-cell { position: relative; aspect-ratio: 1; border-radius: var(--radius-md); overflow: hidden; background: var(--gray-bg); }
.ep-img-cell img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
/* 粘贴/上传失败的兜底：不显示 Chromium 碎图图标，改用居中感叹号占位（视觉上与关闭✕可区分） */
.ep-img-cell img.ep-img-broken { object-fit: none; background: var(--gray-bg); }
.ep-img-cell img.ep-img-broken::after { content: '！'; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--text-3); font-size: 20px; }
.ep-img-cell .x, .ep-file .x { position: absolute; top: 3px; right: 5px; color: #fff; background: rgba(0,0,0,.4); border-radius: 50%; width: 16px; height: 16px; text-align: center; font-size: var(--fs-2xs); line-height: 16px; cursor: pointer; }
.ep-file { display: flex; gap: var(--space-2); align-items: center; font-size: var(--fs-sm); background: var(--gray-bg); padding: var(--space-2) 10px; border-radius: var(--radius-md); margin-bottom: var(--space-1); position: relative; }
.ep-file a { color: var(--brand); cursor: pointer; margin-right: 18px; }
/* 编辑栏图片格子改为可聚焦按钮：继承格子外观 */
.ep-img-btn {
  display: block; width: 100%; height: 100%; padding: 0;
  background: none; border: none; cursor: pointer;
}
.ep-img-btn img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.ep-imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 8px 0; }
@keyframes ep-img-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
</style>
