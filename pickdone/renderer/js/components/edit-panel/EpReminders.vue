<template>
  <!-- Row-level button semantics (same pattern as the deadline/repeat rows) to avoid a double click target with a nested inner button -->
  <div class="ep-row ep-remind" role="button" tabindex="0" :aria-expanded="remindOpen ? 'true' : 'false'"
       @click="toggleRemind" @keydown.enter.prevent="toggleRemind">
    <span class="ep-remind-main">
      <img class="ep-ico" src="app://app/assets/img/icon-clock.svg">
      <span class="ep-remind-label" :class="{'ep-remind-label--active': task.remindTs>0}">{{task.remindTs? remindMainLabel : $t('statsJ.EditPanel.addReminder')}}</span>
    </span>
    <span class="ml-auto"></span>
    <transition name="fade">
      <b v-if="task.remindTs>0" class="ep-remind-clear close-x close-x--sm" :title="$t('statsJ.EditPanel.clearReminder')" role="button" tabindex="0"
         :aria-label="$t('statsJ.EditPanel.clearReminder')" @click.stop="clearRemind" @keydown.enter.prevent.stop="clearRemind"></b>
    </transition>
  </div>
  <transition name="collapse">
    <div v-show="remindOpen" class="ep-remind-pop" @click.stop>
      <div v-for="(r, i) in remindRows" :key="i" class="ep-remind-line">
        <el-date-picker size="small" value-format="x" type="date" :placeholder="$t('statsJ.EditPanel.dateLabel')"
                        v-model="r.date" @update:model-value="commitReminders" style="width:118px"/>
        <el-time-picker size="small" value-format="HH:mm" format="HH:mm" :placeholder="$t('statsJ.EditPanel.timeLabel')"
                        v-model="r.time" @update:model-value="commitReminders" style="width:90px"/>
        <span v-if="i === 0" class="ep-remind-line-tag">{{ $t('statsJ.EditPanel.remindMain') }}</span>
        <b v-else class="ep-remind-line-x close-x close-x--sm" role="button" tabindex="0"
           :aria-label="$t('statsJ.EditPanel.clearReminder')" @click.stop="removeRemindRow(i)"
           @keydown.enter.prevent.stop="removeRemindRow(i)"></b>
      </div>
      <div class="ep-remind-add" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.addReminder')"
           @click="addRemindRow" @keydown.enter.prevent="addRemindRow">
        <span class="ep-remind-add-plus">+</span>{{ $t('statsJ.EditPanel.addReminder') }}
      </div>
      <div v-if="task.remindTs>0" class="ep-remind-offsets">
        <span class="ep-remind-offsets-label" :title="$t('statsJ.EditPanel.remindOffsetsHint')">{{ $t('statsJ.EditPanel.remindAlso') }}</span>
        <button v-for="p in offsetPresetsList()" :key="p.v" type="button" class="ep-offset-chip"
                :class="{on: task.reminderOffsets.includes(p.v)}" role="switch"
                :aria-checked="task.reminderOffsets.includes(p.v) ? 'true' : 'false'"
                @click="toggleOffset(p.v)">{{ p.l }}</button>
      </div>
    </div>
  </transition>
</template>

<script lang="ts">
/**
 * EditPanel reminders block (S4 split 2026-09-12): multiple reminder row editor
 * (row 0 = main reminder; date + time on one row, + to keep adding) plus the
 * offset chips. Pure view + local editing state: every persisted change is
 * emitted (commit / clear / offsets) and EditPanel applies it to the task
 * snapshot through the unified save pipeline.
 */
import { dayjs, FMT } from '../../utils/core.js'
import { removeWithUndo } from '../../utils/confirm.js'

// [h7-fixes] pure-start
/** Undo re-insert index: the index captured at delete time can be stale after concurrent
 *  removals — clamp it to the current list length instead of blindly reusing it. */
function clampInsertIndex (len, i) { return Math.max(0, Math.min(i, len)) }
/** Undo must not cross tasks: only re-insert when the panel still edits the same task. */
function sameTask (currentId, capturedId) { return !!currentId && currentId === capturedId }
// [h7-fixes] pure-end

export default {
  name: 'EpReminders',
  props: {
    /** The panel's hydrated task snapshot (EditPanel's `e`). */
    task: { type: Object as any, default: null }
  },
  emits: ['commit', 'clear', 'offsets'],
  watch: {
    // The panel stays open across a task switch (hydrate replaces the task prop without
    // unmounting this child): stale local editing state -- the open popover and the rows
    // of the previous task -- must be reset, otherwise the old rows get committed into
    // the new task on the next commitReminders.
    'task.taskId' () { this.reset() }
  },
  data () {
    return {
      remindOpen: false,
      remindRows: [] // Multiple reminder row model [{date: ts|null, time: 'HH:mm'}]; row 0 = main reminder
    }
  },
  computed: {
    today0 () { return this.$store.state.todo.todayTimestamp },
    /** Main reminder row summary: first reminder time + total reminder count (with multiple reminders), so the result is visible on one line */
    remindMainLabel () {
      const base = dayjs(this.task.remindTs).format(FMT.cnDate + ' ' + FMT.time)
      const n = 1 + (Array.isArray(this.task.reminderExtra) ? this.task.reminderExtra.length : 0)
      return n > 1 ? base + ' · ' + this.$t('statsJ.EditPanel.remindTotal', { n }) : base
    }
  },
  methods: {
    toggleRemind () {
      if (!this.task) return
      if (this.remindOpen) { this.remindOpen = false; return }
      const day0 = this.task.dateTs || this.today0
      const toRow = ts => {
        const d = dayjs(ts)
        return { date: d.startOf('day').valueOf(), time: d.format(FMT.time) }
      }
      const rows = []
      if (this.task.remindTs) rows.push(toRow(this.task.remindTs))
      for (const ts of (Array.isArray(this.task.reminderExtra) ? this.task.reminderExtra : [])) rows.push(toRow(ts))
      if (!rows.length) rows.push({ date: day0 || null, time: '09:00' })
      this.remindRows = rows
      this.remindOpen = true
    },
    addRemindRow () {
      // New rows default to the task's date (empty if undated); the time is staggered 30 minutes after the previous row to avoid collisions
      const last = this.remindRows[this.remindRows.length - 1]
      const [h, m] = String((last && last.time) || '09:00').split(':').map(Number)
      const nm = (h * 60 + m + 30) % 1440
      this.remindRows.push({ date: (last && last.date) || (this.task.dateTs || null), time: String(Math.floor(nm / 60)).padStart(2, '0') + ':' + String(nm % 60).padStart(2, '0') })
    },
    removeRemindRow (i) {
      const row = this.remindRows[i]
      const tid = this.task && this.task.taskId
      removeWithUndo(this,
        () => {
          this.remindRows.splice(i, 1)
          if (!this.remindRows.length) { this.clearRemind(); return }
          this.commitReminders()
        },
        () => {
          // Undo must not cross tasks: if the panel switched tasks while the undo toast
          // was pending, the deleted reminder belongs to the previous task — drop it.
          if (!sameTask(this.task && this.task.taskId, tid)) return
          // The captured index may be stale after concurrent removals — clamp, don't reuse blindly
          this.remindRows.splice(clampInsertIndex(this.remindRows.length, i), 0, row)
          this.commitReminders()
        })
    },
    /** Task switch: collapse the popover and drop uncommitted local rows. */
    reset () {
      this.remindOpen = false
      this.remindRows = []
    },
    /** Sort the edited rows into absolute timestamps and hand them to the parent for persistence. */
    commitReminders () {
      if (!this.task) return
      const list = []
      for (const r of this.remindRows) {
        const baseDay = r.date || this.task.dateTs || this.today0
        if (!baseDay) continue
        const [h, m] = String(r.time || '09:00').split(':').map(Number)
        list.push(dayjs(baseDay).hour(h || 0).minute(m || 0).second(0).millisecond(0).valueOf())
      }
      if (!list.length) { this.clearRemind(); return }
      list.sort((a, b) => a - b)
      this.$emit('commit', list[0], list.slice(1))
    },
    clearRemind () {
      this.remindOpen = false
      this.$emit('clear')
    },
    /* Multiple reminders: offsets are relative to the main reminder (negative = earlier), inherited automatically on recurrence renewal */
    offsetPresetsList (): Array<{ v: number, l: string }> {
      return [
        { v: 0, l: this.$t('statsJ.EditPanel.remindOnTime') },
        { v: -10, l: this.$t('statsJ.EditPanel.remindMin10') },
        { v: -30, l: this.$t('statsJ.EditPanel.remindMin30') },
        { v: -60, l: this.$t('statsJ.EditPanel.remindHour1') },
        { v: -1440, l: this.$t('statsJ.EditPanel.remindDay1') }
      ]
    },
    toggleOffset (v) {
      if (!this.task) return
      const cur = Array.isArray(this.task.reminderOffsets) ? this.task.reminderOffsets.slice() : []
      const i = cur.indexOf(v)
      if (i >= 0) cur.splice(i, 1)
      else cur.push(v)
      // Sort offsets ascending and deduplicate, keeping the persisted form stable (scheduler and display share one source)
      const sorted = [...new Set(cur)].sort((a: any, b: any) => a - b)
      this.$emit('offsets', sorted)
    }
  }
}
</script>

<style>
/* EditPanel reminders block styles (S4 split: moved verbatim from EditPanel.vue; global, ep- prefixed) */
/* 编辑栏多重提醒：每行=日期+时间+✕；+ 添加提醒行 */
.ep-remind-line { display: flex; align-items: center; gap: var(--space-1); margin-bottom: 6px; }
.ep-remind-line .el-date-editor--date { width: 118px !important; }
.ep-remind-line .el-date-editor--time { width: 90px !important; }
.ep-remind-line-tag { font-size: var(--fs-2xs); color: var(--brand); border: 1px solid var(--brand);
  border-radius: 8px; padding: 0 6px; line-height: 16px; white-space: nowrap; }
.ep-remind-line-x { cursor: pointer; color: var(--text-3); font-weight: 400; padding: 2px; }
.ep-remind-line-x:hover { color: var(--danger, #e05a4e); }
.ep-remind-add { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--fs-sm);
  color: var(--text-2, #5f6672); cursor: pointer; border-radius: 6px; padding: 3px 6px; }
.ep-remind-add:hover { color: var(--brand); background: var(--brand-light, #eef1fe); }
.ep-remind-add-plus { font-weight: 700; }
/* 内联提醒选择器行（日期 + 时间） */
.ep-remind-pop {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: 8px 2px 10px; border-bottom: 1px solid var(--line);
}
/* 多重提醒偏移 chips（相对主提醒的提前量，0=准时） */
.ep-remind-offsets { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ep-remind-offsets-label { font-size: var(--fs-xs); color: var(--text-3); margin-right: 2px; }
.ep-offset-chip {
  font-size: var(--fs-2xs); color: var(--text-2); background: transparent;
  border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 2px 9px; cursor: pointer;
  transition: color var(--dur-fast), border-color var(--dur-fast), background-color var(--dur-fast);
}
.ep-offset-chip:hover { border-color: var(--brand); color: var(--brand); }
.ep-offset-chip.on { background: var(--brand); border-color: var(--brand); color: #fff; }
/* 提醒行主体按钮铺满剩余宽度，行尾清除键为兄弟节点（无 ARIA 嵌套） */
.ep-remind-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
/* .ep-remind-label 基础态在 EditPanel.vue（重复/截止行共用），这里只保留提醒行自身的 hover 联动 */
.ep-remind:hover .ep-remind-label { color: #919191; }
.ep-remind:hover .ep-remind-label--active { color: var(--brand-hover); }
.ep-remind:hover .ep-remind-clear { opacity: 1; }
</style>
