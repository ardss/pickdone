<template>

  <div v-if="taskId" class="modal-container" style="z-index: calc(var(--z-modal) + 20) !important; cursor: default;"
       @click="e => { if (e.target.classList && (e.target.classList.contains('modal-container') || e.target.classList.contains('modal-tablecloth'))) close() }">
    <div class="modal-tablecloth">
      <div class="task-account" role="dialog" aria-modal="true" @keydown.esc="close">
        <div class="task-account__head">
          <b>{{ $t('statsK.TomatoAccount.title', { name: task ? task.taskContent : '' }) }}</b>
          <button type="button" class="close-x close-x--sm ta-x" :aria-label="$t('statsK.TomatoAccount.close')" @click="close"></button>
        </div>
        <div class="task-account__sum">
          <span v-if="records.length">{{ $t('statsK.TomatoAccount.sumLine', { n: actualTotal }) }}</span>
          <span v-else>{{ $t('statsK.TomatoAccount.emptyTitle') }}</span>
        </div>
        <div class="task-account__list">
          <div v-if="!records.length" class="task-account__empty">{{ $t('statsK.TomatoAccount.emptyDesc') }}</div>
          <div v-for="r in records" :key="r.tomatoId" class="ta-row">
            <div class="ta-row__main" role="button" tabindex="0" @click="toggleEdit(r)" @keydown.enter.prevent="toggleEdit(r)">
              <span class="ta-row__date">{{ fmtDate(r) }}</span>
              <span class="ta-row__time">{{ fmtRange(r) }}</span>
              <span v-if="r.manual" class="ta-badge manual">{{ $t('statsK.TomatoAccount.manual') }}</span>
              <span v-if="r.abandoned" class="ta-badge giveup">{{ $t('statsK.TomatoAccount.givenUp') }}</span>
              <span class="ta-row__dur">{{ r.dur }}{{ $t('statsK.TomatoAccount.minUnit') }}</span>
            </div>
            <div v-if="editingId === r.tomatoId && draft" class="ta-edit">
              <div class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.start') }}</span>
                <el-time-picker size="small" format="HH:mm" :clearable="false" :model-value="minToDate(draft.startMin)" @update:model-value="v => { draft.startMin = dateToMin(v) }"/></div>
              <div class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.focusMin') }}</span>
                <el-input-number size="small" :min="1" :max="720" :step="5" controls-position="right" :model-value="draft.dur" @update:model-value="v => { draft.dur = v }"/></div>
              <div v-if="!draft.abandoned" class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.restMin') }}</span>
                <el-input-number size="small" :min="0" :max="120" :step="5" controls-position="right" :model-value="draft.rest" @update:model-value="v => { draft.rest = v }"/></div>
              <div class="ta-btns">
                <button class="ta-btn-save" @click="saveEdit">{{ $t('statsK.TomatoAccount.save') }}</button>
                <button class="ta-btn-del" @click="delRecord(r)">{{ $t('statsK.TomatoAccount.delete') }}</button>
              </div>
            </div>
          </div>
        </div>
        <div class="task-account__foot">
          <div v-if="draft && draft.create" class="ta-form">
            <div class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.start') }}</span>
              <el-time-picker size="small" format="HH:mm" :clearable="false" :model-value="minToDate(draft.startMin)" @update:model-value="v => { draft.startMin = dateToMin(v) }"/></div>
            <div class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.focusMin') }}</span>
              <el-input-number size="small" :min="1" :max="720" :step="5" controls-position="right" :model-value="draft.dur" @update:model-value="v => { draft.dur = v }"/></div>
            <div class="ta-edit-row"><span>{{ $t('statsK.TomatoAccount.restMin') }}</span>
              <el-input-number size="small" :min="0" :max="120" :step="5" controls-position="right" :model-value="draft.rest" @update:model-value="v => { draft.rest = v }"/></div>
            <div class="ta-hint">{{ $t('statsK.TomatoAccount.addHint') }}</div>
          </div>
          <button v-if="!(draft && draft.create)" class="task-account__add" @click="openAdd">{{ $t('statsK.TomatoAccount.addBtn') }}</button>
          <div v-else class="ta-btns">
            <button class="ta-btn-save" @click="saveCreate">{{ $t('statsK.TomatoAccount.addSave') }}</button>
            <button class="ta-btn-del" @click="draft = null">{{ $t('statsK.TomatoAccount.cancel') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/* Pomodoro ledger · task posting detail dialog
   Product model: a task's "actual" is not an independent number — it equals the total of the focus records under this task (single source of truth).
   Changing "actual" = posting — add/remove/modify entries (vouchers) here and the total follows automatically. Ledger integrity is non-negotiable, yet no detour to the timeline is needed.
   The empty state teaches: users opening it for the first time learn the "actual" semantics right here. */
import { FMT, dayjs } from '../utils/core.js'
import dialogA11y from '../utils/dialogA11y.js'

const CSS = `
.task-account { background: var(--panel, #fff); border: 1px solid var(--line, #f3f3f3); border-radius: var(--radius-lg, 10px); width: 460px; max-width: 92vw; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 12px 32px rgba(0,0,0,.18); overflow: hidden; }
.task-account__head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; border-bottom: 1px solid var(--line, #f3f3f3); }
.task-account__head b { font-size: 14px; color: var(--text-1, #303133); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-account__sum { padding: 10px 16px; font-size: 12px; color: var(--text-2, #606266); background: var(--gray-bg, #f8f8f8); }
.task-account__sum b { color: var(--brand, #0f9d8f); }
.task-account__list { flex: 1; overflow-y: auto; padding: 6px 8px; }
.task-account__empty { padding: 28px 16px; text-align: center; color: var(--text-3, #6d7278); font-size: 12.5px; line-height: 1.8; }
.ta-row { border: 1px solid var(--line, #f3f3f3); border-radius: 8px; margin: 4px 8px; padding: 7px 10px; font-size: 12px; }
.ta-row__main { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.ta-row__date { color: var(--text-4, #c0c4cc); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.ta-row__time { color: var(--text-1, #303133); font-variant-numeric: tabular-nums; flex: 1; }
.ta-row__dur { color: var(--brand, #0f9d8f); font-weight: 600; font-variant-numeric: tabular-nums; }
.ta-badge { font-size: 10px; border-radius: 6px; padding: 1px 6px; }
.ta-badge.manual { color: var(--text-3, #6d7278); background: var(--gray-bg, #f8f8f8); }
.ta-badge.giveup { color: var(--danger-strong, #d9534f); background: var(--danger-soft, #fef0f0); }
.ta-edit { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line, #f3f3f3); }
.ta-edit-row { display: flex; align-items: center; gap: 8px; }
.ta-edit-row > span { width: 60px; flex-shrink: 0; color: var(--text-2, #606266); font-size: 11px; }
.ta-edit-row .el-time-picker, .ta-edit-row .el-input-number, .ta-edit-row .el-select { flex: 1; min-width: 0; }
.ta-btns { display: flex; gap: 8px; }
.ta-btns button { flex: 1; border: 0; border-radius: 6px; padding: 5px 0; font: inherit; font-size: 12px; cursor: pointer; }
.ta-btn-save { background: var(--brand, #0f9d8f); color: #fff; }
.ta-btn-save:hover { filter: brightness(1.1); }
.ta-btn-del { background: var(--danger-soft, #fef0f0); color: var(--danger-strong, #d9534f); }
.ta-btn-del:hover { background: var(--danger-strong, #d9534f); color: #fff; }
.task-account__foot { padding: 10px 16px 14px; border-top: 1px solid var(--line, #f3f3f3); }
.task-account__add { width: 100%; border: 1.5px dashed var(--brand, #0f9d8f); background: transparent; color: var(--brand, #0f9d8f); border-radius: 8px; padding: 7px 0; font: inherit; font-size: 12px; cursor: pointer; }
.task-account__add:hover { background: var(--brand-light, #e2f4f1); }
.ta-form { display: flex; flex-direction: column; gap: 8px; padding-bottom: 8px; }
.ta-hint { font-size: 10.5px; color: var(--text-4, #c0c4cc); }
.ta-x { flex-shrink: 0; }
`

function injectStyle () {
  if (document.getElementById('task-account-style')) return
  const el = document.createElement('style')
  el.id = 'task-account-style'
  el.textContent = CSS
  document.head.appendChild(el)
}

export default {
  name: 'TaskAccountModal',
  mixins: [dialogA11y],
  data: () => ({ editingId: null, draft: null }),
  computed: {
    taskId () { return this.$store.state.ui.accountTaskId },
    task () { return this.$store.state.todo.todoList.find(t => t.taskId === this.taskId) || null },
    records () {
      return (this.$store.state.tomato.tomatoRecordList || [])
        .filter(r => r && r.focusTaskId === this.taskId)
        .map(r => {
          const dur = Number(r.focusDuration || 0)
          const rest = r.succeed === false ? 0 : Number(r.restDuration || 0)
          // 分钟偏移锚定记录所在日零点(2026-09-04 深审 P0 修复:原锚定"今天零点",历史记录 startMin 为大负数,
          // 时间选择器 clamp 到 0-1439 显示成今天 00:00,一动选择器就把历史账搬进今天)
          const day0 = dayjs(Number(r.endTime)).startOf('day').valueOf()
          const startMin = ((Number(r.endTime) - dur * 60000) - day0) / 60000
          return { ...r, day0, startMin, dur, rest, abandoned: r.succeed === false }
        })
        .sort((a, b) => b.endTime - a.endTime)
    },
    actualTotal () { return this.records.filter(r => !r.abandoned).length }
  },
  methods: {
    close () { this.$store.commit('ui/openTaskAccount', '') },
    fmtRange (r) {
      const hm = ts => dayjs(ts).format('HH:mm')
      const start = hm(Number(r.endTime) - r.dur * 60000)
      // 有休息尾巴才展示区间;两侧同表达式恒真是死分支(2026-09-05 终审 P2 修复)
      return r.rest > 0 ? (start + ' – ' + hm(Number(r.endTime) + r.rest * 60000)) : start
    },
    // FMT.date 为 YYYY-MM-DD 全格式时缩写 MM-DD;原 slice(0,5)==='20' 恒假(2026-09-05 终审 P2 修复)
    fmtDate (r) { return dayjs(Number(r.endTime)).format(FMT.date === 'YYYY-MM-DD' ? 'MM-DD' : FMT.date) },
    toggleEdit (r) {
      if (this.editingId === r.tomatoId) { this.editingId = null; this.draft = null; return }
      this.editingId = r.tomatoId
      this.draft = { tomatoId: r.tomatoId, day0: r.day0, startMin: Math.round(r.startMin), dur: r.dur, rest: r.rest, abandoned: r.abandoned }
    },
    saveEdit () {
      const d = this.draft
      if (!d) return
      const startTs = d.day0 + d.startMin * 60000
      this.$store.commit('tomato/updateRecord', { tomatoId: d.tomatoId, patch: { endTime: startTs + d.dur * 60000, focusDuration: d.dur, restDuration: d.abandoned ? 0 : d.rest, succeed: !d.abandoned } })
      this.$message.success(this.$t('statsK.TomatoAccount.saved'))
      this.editingId = null
      this.draft = null
    },
    delRecord (r) {
      this.$confirm(this.$t('statsK.TomatoAccount.deleteConfirm'), this.$t('statsK.TomatoAccount.delete'), { type: 'warning' })
        .then(() => {
          this.$store.commit('tomato/removeRecord', r.tomatoId)
          this.$message.success(this.$t('statsK.TomatoAccount.deleted'))
        }).catch(() => {})
    },
    openAdd () {
      const now = new Date()
      const nowMin = Math.max(25, now.getHours() * 60 + now.getMinutes())
      this.editingId = null
      this.draft = { create: true, startMin: nowMin - 25, dur: 25, rest: 5, abandoned: false }
    },
    saveCreate () {
      const d = this.draft
      if (!d || !d.create) return
      const startTs = dayjs().startOf('day').valueOf() + d.startMin * 60000
      this.$store.commit('tomato/addRecord', {
        // Manually added records get a random tail: two backfills with the same minute and duration are no longer silently swallowed by deterministic-id idempotent dedup
        tomatoId: 'tmt_a2_' + startTs + '_' + d.dur + '_' + Math.random().toString(36).slice(2, 7), endTime: startTs + d.dur * 60000,
        dateKey: dayjs(startTs).format(FMT.date),
        focus: this.task ? this.task.taskContent : '', focusTaskId: this.taskId,
        focusDuration: d.dur, rest: d.rest, restDuration: d.rest,
        succeed: true, status: 'local', manual: true
      })
      this.$message.success(this.$t('statsK.TomatoAccount.added'))
      this.draft = null
    },
    minToDate (m) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setMinutes(Math.max(0, Math.min(1439, Math.round(m)))); return d },
    dateToMin (d) { if (!(d instanceof Date)) return 0; return d.getHours() * 60 + d.getMinutes() }
  },
  mounted () { injectStyle() },

}
</script>
