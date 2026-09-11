<template>
  <div class="pjdocs">
    <div class="pjdocs__side">
      <button class="pjdocs__new" @click="newDoc"><app-icon name="plus" :size="11"/> {{ $t('statsB.ProjectDocs.new') }}</button>
      <div v-if="!docs.length" class="pjdocs__empty">{{ $t('statsB.ProjectDocs.empty') }}</div>
      <button v-for="d in sortedDocs" :key="d.id" class="pjdocs__item" :class="{on: d.id === activeId}"
              @click="openDoc(d)">
        <span class="pjdocs__item-title">{{ d.title || $t('statsB.ProjectDocs.untitled') }}</span>
        <span class="pjdocs__item-date">{{ fmtDate(d.updatedAt) }}</span>
      </button>
    </div>
    <div v-if="active" class="pjdocs__editor">
      <input class="pjdocs__title" v-model="active.title" :placeholder="$t('statsB.ProjectDocs.titlePh')"
             :aria-label="$t('statsB.ProjectDocs.titleAria')" @input="queueSave"/>
      <textarea class="pjdocs__body" v-model="active.body" :placeholder="$t('statsB.ProjectDocs.bodyPh')"
                :aria-label="$t('statsB.ProjectDocs.bodyAria')" @input="queueSave"></textarea>
      <div class="pjdocs__foot">
        <span class="pjdocs__status">{{ statusText }}</span>
        <button class="pjdocs__del" @click="delDoc">{{ $t('statsB.ProjectDocs.del') }}</button>
      </div>
    </div>
    <div v-else class="pjdocs__editor pjdocs__editor--empty">{{ $t('statsB.ProjectDocs.editorEmpty') }}</div>
  </div>
</template>

<script lang="ts">
/** 项目文档(实验性,project/:id 页"文档"页签)
 *  每个项目一组轻量文档(PRD/会议纪要/标准化流程记录),存 meta `projectDocs:<categoryId>`,
 *  结构 [{id,title,body,createdAt,updatedAt}];与里程碑同套路:meta 持久化,零 schema 变更,CLI 可读写同一 key。
 *  编辑自动保存(600ms 防抖);切换页签/项目或卸载前先把挂起的防抖保存立即落盘,不丢最后 600ms 输入。
 *  删除走全局撤销契约:5s undo toast(utils/confirm.js 的 removeWithUndo),不再用两段红字确认。 */
import { dayjs, FMT } from '../utils/core.js'
import { removeWithUndo } from '../utils/confirm.js'

const keyOf = (catId: number) => 'projectDocs:' + catId
const genId = () => 'doc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export default {
  name: 'ProjectDocs',
  props: { catId: { type: Number, required: true } },
  data () {
    return { docs: [] as any, activeId: '' as any, savedAt: 0, saveTimer: 0 as any }
  },
  computed: {
    sortedDocs () {
      return this.docs.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    },
    active () {
      return this.docs.find(d => d.id === this.activeId) || null
    },
    statusText () {
      if (!this.savedAt) return ''
      return this.$t('statsB.ProjectDocs.saved', { t: dayjs(this.savedAt).format(FMT.time) })
    }
  },
  watch: {
    catId () { this.flushPending(); this.load() }
  },
  mounted () { this.load() },
  beforeUnmount () { this.flushPending() },
  methods: {
    /** 切页签/切项目/卸载前把挂起的 600ms 防抖保存立即落盘,否则最后一次编辑会丢。
     *  catId watcher 触发时 prop 已是新项目,必须用 queueSave 时抓的 key,避免把旧项目文档写进新项目。 */
    flushPending () {
      if (!this.saveTimer) return
      clearTimeout(this.saveTimer)
      this.saveTimer = 0
      this.persist(this._pendingKey || keyOf(this.catId))
    },
    fmtDate (ts) { return ts ? dayjs(ts).format(FMT.cnDate) : '' },
    async load () {
      this.docs = []
      this.activeId = ''
      try {
        const raw = await window.todoAPI.dbCall('getMeta', keyOf(this.catId))
        const arr = JSON.parse(raw || '[]')
        if (Array.isArray(arr)) this.docs = arr
      } catch (e) { this.docs = [] }
    },
    persist (keyOverride) {
      try {
        window.todoAPI.dbCall('setMeta', [keyOverride || keyOf(this.catId), JSON.stringify(this.docs)]).catch(() => {})
      } catch (e) { /* 无桥环境仅内存 */ }
      this.savedAt = Date.now()
    },
    queueSave () {
      if (this.active) this.active.updatedAt = Date.now()
      this._pendingKey = keyOf(this.catId)
      clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(this.persist, 600)
    },
    newDoc () {
      const d = { id: genId(), title: '', body: '', createdAt: Date.now(), updatedAt: Date.now() }
      this.docs.push(d)
      this.activeId = d.id
      this.persist()
    },
    openDoc (d) { this.activeId = d.id },
    /** 删除走全局撤销契约:立即删 + 5s undo toast(removeWithUndo),撤销时按原位置还原并落盘 */
    delDoc () {
      const doc = this.active
      if (!doc) return
      const idx = this.docs.indexOf(doc)
      const catId = this.catId
      removeWithUndo(this, () => {
        this.docs = this.docs.filter(d => d.id !== doc.id)
        if (this.activeId === doc.id) this.activeId = ''
        this.persist()
      }, () => {
        // 撤销可能发生在切到别的项目之后:恢复前先确认还在原项目的文档组里
        if (this.catId !== catId) return
        this.docs.splice(Math.min(idx, this.docs.length), 0, doc)
        this.activeId = doc.id
        this.persist()
      })
    }
  }
}
</script>

<style>
/* 项目文档:左列表右编辑器;全部走 token,深浅色自动适配 */
.pjdocs { display: flex; gap: 12px; height: 100%; min-height: 0; }
.pjdocs__side { width: 240px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px;
  overflow-y: auto; min-height: 0; }
.pjdocs__new { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: 1px dashed var(--line-2, #d5d9de); border-radius: var(--radius-md, 10px); background: transparent;
  color: var(--text-2); cursor: pointer; font-size: var(--fs-sm, 13px); transition: all var(--t-fast); }
.pjdocs__new:hover { border-color: var(--brand); color: var(--brand); }
.pjdocs__empty { padding: 14px 10px; text-align: center; font-size: var(--fs-xs, 12px); color: var(--text-3); }
.pjdocs__item { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px;
  border: 1px solid var(--line, #e6e8eb); border-radius: var(--radius-md, 10px); background: var(--panel);
  cursor: pointer; transition: border-color var(--t-fast); }
.pjdocs__item:hover { border-color: var(--brand); }
.pjdocs__item.on { border-color: var(--brand); background: var(--brand-light, rgba(15, 157, 143, .07)); }
.pjdocs__item-title { font-size: var(--fs-sm, 13px); color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pjdocs__item-date { font-size: var(--fs-2xs, 11px); color: var(--text-3); }
.pjdocs__editor { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--line, #e6e8eb); border-radius: var(--radius-md, 10px); background: var(--panel);
  padding: 12px 14px; }
.pjdocs__editor--empty { align-items: center; justify-content: center; color: var(--text-3); font-size: var(--fs-sm, 13px); }
.pjdocs__title { border: none; outline: none; background: transparent; color: var(--text-1);
  font-size: 16px; font-weight: 600; padding: 2px 0; border-bottom: 1px solid var(--line, #e6e8eb); }
.pjdocs__body { flex: 1; min-height: 0; resize: none; border: none; outline: none; background: transparent;
  color: var(--text-1); font-size: var(--fs-sm, 13px); line-height: 1.7; font-family: inherit; }
.pjdocs__foot { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line, #e6e8eb); padding-top: 8px; }
.pjdocs__status { flex: 1; font-size: var(--fs-2xs, 11px); color: var(--text-3); }
.pjdocs__del { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line, #e6e8eb);
  background: transparent; color: var(--text-3); cursor: pointer; font-size: var(--fs-xs, 12px); transition: all var(--t-fast); }
.pjdocs__del:hover { border-color: var(--danger, #c25649); color: var(--danger, #c25649); }
</style>
