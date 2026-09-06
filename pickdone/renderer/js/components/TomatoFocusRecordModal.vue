<template>

  <div class="modal-container modal-container--settings" style="cursor:default" @click="maskHide">
    <div class="modal-tablecloth modal-tablecloth--body">
      <div class="modal modal--settings" role="dialog" aria-modal="true" :aria-label="$t('statsD.TomatoFocusRecord.title')" @keydown.esc="close">
        <div class="modal__header">
          <span>{{ $t('statsD.TomatoFocusRecord.title') }}</span>
          <button type="button" class="mini primary" style="position:absolute;top:10.5px;right:48px"
                  @click="openAdd">{{ $t('statsD.TomatoFocusRecord.manualAdd') }}</button>
          <button type="button" class="modal__close close-x" :aria-label="$t('statsD.TomatoFocusRecord.close')" @click="close"></button>
        </div>
        <div class="modal__body modal__body--body-no-padding" style="overflow:auto">
          <div v-if="timeline" class="tfr-timeline">
            <div class="tfr-timeline__head">
              <span class="tfr-timeline__nav">
                <button type="button" class="tfr-nav-btn" :aria-label="$t('statsD.TomatoFocusRecord.prevDay')" :disabled="false" @click="tlOffset--">‹</button>
                <span class="tfr-timeline__date">{{ timeline.label }}{{ tlOffset===0 ? $t('statsD.TomatoFocusRecord.todaySuffix') : (tlOffset===-1 ? $t('statsD.TomatoFocusRecord.yesterdaySuffix') : '') }}</span>
                <button type="button" class="tfr-nav-btn" :aria-label="$t('statsD.TomatoFocusRecord.nextDay')" :disabled="tlOffset>=0" @click="tlOffset++">›</button>
              </span>
              <span class="tfr-timeline__sum">{{ $t('statsD.TomatoFocusRecord.pomosSummary', { n: timeline.pomos, d: timeline.durationText }) }}</span>
            </div>
            <div class="tfr-timeline__bar">
              <div class="tfr-timeline__grid" aria-hidden="true">
                <i v-for="h in 23" :key="h" :style="{left:(h/24*100)+'%'}"></i>
              </div>
              <div v-for="(seg,i) in timeline.segs" :key="i" class="tfr-timeline__seg"
                   :class="{'tfr-timeline__seg--hot': highlightId===seg.tomatoId}"
                   :style="seg.style" :title="seg.title"
                   role="button" tabindex="0" :aria-label="$t('statsD.TomatoFocusRecord.locate', { t: seg.title })"
                   @click="locateRecord(seg.tomatoId)" @keydown.enter.prevent="locateRecord(seg.tomatoId)"></div>
            </div>
            <div class="tfr-timeline__scale">
              <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
            </div>
            <div class="tfr-timeline__legend">
              <span><i class="dot dot-focus"></i>{{ $t('statsD.TomatoFocusRecord.focusLegend') }}</span>
              <span><i class="dot dot-idle"></i>{{ $t('statsD.TomatoFocusRecord.idleLegend') }}</span>
            </div>
          </div>
          <div v-if="!dayRecords.length" class="tfr-empty">{{ $t('statsD.TomatoFocusRecord.empty') }}</div>
          <div v-for="r in dayRecords" :key="r.tomatoId" class="tomato-record"
               :class="{'tomato-record--open': expandedId===r.tomatoId, 'tomato-record--hot': highlightId===r.tomatoId}"
               role="button" tabindex="0" :aria-label="$t('statsD.TomatoFocusRecord.recordAria', { r: timeRange(r) })"
               @click="toggleDetail(r.tomatoId)" @keydown.enter.prevent="toggleDetail(r.tomatoId)"
               @contextmenu="onRecordContext($event, r)">
            <div class="tomato-record__title">
              <div class="tomato-record__title__left">
                <span class="tomato-record__task" :class="{ 'tomato-record__task--free': !r.focus }">{{ r.focus || $t('statsD.TomatoPanel.freeFocus') }}</span>
                <span class="tomato-record__range">{{ timeRangeShort(r) }}</span>
              </div>
              <div class="tomato-record__title__interval">
                {{intervalText(r)}}
                <span v-if="r.restDuration > 0" class="rest-badge" :title="$t('statsD.TomatoFocusRecord.restTitle', { n: r.restDuration })">{{ $t('statsD.TomatoFocusRecord.restBadge', { n: r.restDuration }) }}</span>
                <i class="expander" :class="{open:expandedId===r.tomatoId}">▾</i>
              </div>
            </div>
            <div v-if="expandedId===r.tomatoId" class="tomato-record__detail">
              <div>{{ $t('statsD.TomatoFocusRecord.startLabel') }}{{dfmt(r.startTime || (r.endTime||Date.now()) - (r.focusDuration||0)*60000, 'YYYY-MM-DD HH:mm:ss')}}</div>
              <div>{{ $t('statsD.TomatoFocusRecord.endLabel') }}{{dfmt(r.endTime || Date.now(), 'YYYY-MM-DD HH:mm:ss')}}</div>
              <div>{{ $t('statsD.TomatoFocusRecord.focusDurationLabel') }}{{intervalText(r)}}</div>
              <div v-if="r.restDuration > 0">{{ $t('statsD.TomatoFocusRecord.restDurationVal', { n: r.restDuration }) }}</div>
              <div v-if="r.focus">{{ $t('statsD.TomatoFocusRecord.linkedTaskLabel') }}{{r.focus}}</div>
      <!-- Abandoned pomodoro: shows the status and the reason filled when abandoned (previously persisted but visible nowhere) -->
              <div v-if="r.succeed === false">{{ $t('statsD.TomatoFocusRecord.abandonedLabel') }}<span v-if="r.abandonReason">{{ r.abandonReason === 'cli' ? $t('statsJ.TodoItem.cliStopReason') : r.abandonReason }}</span></div>
              <div class="tomato-record__detail-hint">{{ $t('statsD.TomatoFocusRecord.detailHint') }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Manual record add (following the common tomatoRecordAdd pattern: start time / focus duration / rest duration / 3-per-day limit) -->
    <div v-if="$store.state.ui.tomatoRecordAddVisible" class="modal-container" style="z-index: calc(var(--z-modal) + 10) !important" @click="maskHideAdd">
      <div class="modal-tablecloth">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('statsD.TomatoFocusRecord.addTitle')" style="width:500px;max-width:min(500px,92vw)" @keydown.esc="$store.commit('ui/toggleTomatoRecordAdd', false)">
          <div class="modal__header">
            <span>{{ $t('statsD.TomatoFocusRecord.addTitle') }}</span>
            <button type="button" class="modal__close close-x" :aria-label="$t('statsD.TomatoFocusRecord.close')" @click="$store.commit('ui/toggleTomatoRecordAdd', false)"></button>
          </div>
          <div class="modal__body">
            <div class="tfr-form-row">
              <label class="tfr-form-label">{{ $t('statsD.TomatoFocusRecord.startTime') }}</label>
              <el-date-picker v-model="addForm.startTs" type="datetime" size="small" value-format="x" style="width:100%"
                              format="YYYY-MM-DD HH:mm" :placeholder="$t('statsD.TomatoFocusRecord.pickDateTime')"/>
            </div>
            <div class="tfr-form-row">
              <label class="tfr-form-label">{{ $t('statsD.TomatoFocusRecord.focusMinutes') }}</label>
              <div style="display:flex;gap:12px;align-items:center">
                <el-slider v-model="addForm.focusTime" :min="5" :max="120" style="flex:1"/>
                <el-input-number v-model="addForm.focusTime" :min="5" :max="120" size="small" style="width:110px"/>
              </div>
            </div>
            <div class="tfr-form-row">
              <label class="tfr-form-label">{{ $t('statsD.TomatoFocusRecord.restMinutes') }}</label>
              <div style="display:flex;gap:12px;align-items:center">
                <el-slider v-model="addForm.resetTime" :min="1" :max="30" style="flex:1"/>
                <el-input-number v-model="addForm.resetTime" :min="1" :max="30" size="small" style="width:110px"/>
              </div>
            </div>
            <div class="tfr-form-row">
              <label class="tfr-form-label">{{ $t('statsD.TomatoFocusRecord.linkEvent') }}</label>
              <el-select v-model="addForm.focusTaskId" size="small" filterable clearable style="width:100%"
                         :placeholder="$t('statsD.TomatoFocusRecord.pickEvent')">
                <el-option v-for="t in attachCandidates" :key="t.taskId" :label="t.taskContent" :value="t.taskId"/>
              </el-select>
              <el-input v-if="!addForm.focusTaskId" v-model="addForm.focusText" size="small" style="margin-top:8px"
                        maxlength="100" :placeholder="$t('statsD.TomatoFocusRecord.freeFocusPlaceholder')"/>
            </div>
            <p class="tfr-add-info">{{ $t('statsD.TomatoFocusRecord.addInfoA') }}<span class="text-primary">{{ $t('statsD.TomatoFocusRecord.addQuota') }}</span>{{ $t('statsD.TomatoFocusRecord.addInfoB') }}<span class="text-primary">{{addLeft}}</span></p>
          </div>
          <div class="modal__footer">
            <button type="button" class="mini" @click="$store.commit('ui/toggleTomatoRecordAdd', false)">{{ $t('statsD.TomatoFocusRecord.cancel') }}</button>
            <button type="button" class="mini primary" :disabled="addSaving" @click="saveAdd">{{ $t('statsD.TomatoFocusRecord.confirm') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Pomodoro focus record full-screen modal -- following the common tomatoFocusRecord pattern (base-modal width/height 100% + body-no-padding):
 *  Header "Pomodoro Focus Record" + top-right "Add record manually"; body lists .tomato-record entries (date/time range/duration/linked task/right-click delete).
 *  Manual add follows the common tomatoRecordAdd pattern: start time + focus/rest duration sliders, limited to 3 per day (settings.tomatoRecordAddDate/Count). */
import { dayjs, FMT } from '../utils/core.js'
import { genTomatoId } from '../utils/core.js'
import { loadRuntime, saveRuntime } from '../store/runtimeState.js'
import dialogA11y from '../utils/dialogA11y.js'

function fmtSec (sec) {
  const s = Math.max(0, Math.round(sec))
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default {
  name: 'TomatoFocusRecord',
  mixins: [dialogA11y],
  data () {
    return {
      addForm: { startTs: Date.now(), focusTime: 25, resetTime: 5, focusTaskId: null, focusText: '' },
      addSaving: false,
      menuRecord: null as any,
      tlOffset: 0,
      expandedId: null as any,
      highlightId: null as any
    }
  },
  computed: {
    records () { return this.$store.state.tomato.tomatoRecordList || [] },
    addCountToday () {
      // 跨零点按日期核对:昨日剩余额不得显示成今日可用(2026-09-05 复核 P2)
      const rt = loadRuntime()
      const d = rt.tomatoRecordAddDate ? dayjs(rt.tomatoRecordAddDate).format(FMT.date) : ''
      return d === dayjs().format(FMT.date) ? (Number(rt.tomatoRecordAddCount) || 0) : 0
    },
    addLeft () { return Math.max(0, 3 - this.addCountToday) },
    attachCandidates () {
      return [...this.$store.state.todo.todoList].filter(t => !t.complete && t.taskContent).slice(0, 200)
    },
    /** Currently selected day (tlOffset: 0 = today, -1 = yesterday...) */
    selDayStart () { return this.$store.state.todo.todayTimestamp + (this.tlOffset || 0) * 86400000 },
    selDayLabel () {
      const t = this.$store.state.todo.todayTimestamp
      const d = this.selDayStart
      if (d === t) return d + this.$t('statsD.TomatoFocusRecord.todaySuffix')
      if (d === t - 86400000) return d + this.$t('statsD.TomatoFocusRecord.yesterdaySuffix')
      return String(d)
    },
    /** Records of the selected day (sorted by end time, descending) */
    dayRecords () {
      const start = this.selDayStart; const end = start + 86400000
      return this.records.filter(r => { const e = r.endTime || 0; return e > start && e < end })
        .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
    },
    /** Timeline: lays the selected day's focus/rest segments onto a 0-24h bar (clipped to the day when crossing midnight) */
    timeline () {
      const list = this.dayRecords
      const dayStart = this.selDayStart
      const dayEnd = dayStart + 86400000
      const segs = []
      let totalMin = 0
      for (const r of list) {
        const end = r.endTime || 0
        const start = r.startTime || end - (r.focusDuration || 0) * 60000
        if (end <= dayStart || start >= dayEnd) continue
        const s = Math.max(start, dayStart)
        const e = Math.min(end, dayEnd)
        totalMin += (e - s) / 60000
        // One pomodoro unit = one rectangle (user-finalized): focus in brand color, rest as an orange segment squared up at the tail, no longer split into two blocks
        const uLeft = ((s - dayStart) / 86400000) * 100
        const uFocusW = Math.max(0.4, ((e - s) / 86400000) * 100)
        let uRestPct = 0
        if (r.restDuration > 0) {
          const rs = Math.min(e + r.restDuration * 60000, dayEnd)
          if (e < rs) uRestPct = ((rs - e) / 86400000) * 100
        }
        const uWidth = Math.max(0.4, uFocusW) + Math.max(0, uRestPct)
        // One unit, one solid rectangle (user-finalized: no yellow/orange; rest is not shown separately)
        const uStyle = { left: uLeft + '%', width: uWidth + '%' }
        segs.push({
          style: uStyle,
          tomatoId: r.tomatoId,
          title: r.restDuration > 0
            ? this.$t('statsD.TomatoFocusRecord.segFocus', { a: this.dfmt(s, 'HH:mm'), b: this.dfmt(e, 'HH:mm'), x: this.intervalText(r) }) + (r.focus ? ` · ${r.focus}` : '') + ' · ' + this.$t('statsD.TomatoFocusRecord.restBadge', { n: r.restDuration })
            : this.$t('statsD.TomatoFocusRecord.segFocus', { a: this.dfmt(s, 'HH:mm'), b: this.dfmt(e, 'HH:mm'), x: this.intervalText(r) }) + (r.focus ? ` · ${r.focus}` : '')
        })
      }
      segs.sort((a, b) => a.left - b.left)
      // At-a-glance summary: pomodoro count (one per 25 minutes, rounded up) + duration
      const pomos = Math.ceil(totalMin / 25)
      const hours = Math.floor(totalMin / 60)
      const mins = Math.round(totalMin % 60)
      const durationText = hours ? this.$t('statsD.TomatoFocusRecord.hoursMinutes', { h: hours, m: mins }) : this.$t('statsD.TomatoFocusRecord.minutesOnly', { m: mins })
      return { label: this.dfmt(dayStart, this.$t('statsE.TomatoFocusRecordModal.dateFormat')), pomos, durationText, totalMin: Math.round(totalMin), segs }
    }
  },
  methods: {
    dfmt (ts, f) { return dayjs(ts).format(f) },
    /** List row click: expand/collapse details */
    toggleDetail (id) { this.expandedId = this.expandedId === id ? null : id },
    /** Timeline segment click: scroll to and highlight the corresponding record row */
    locateRecord (id) {
      this.highlightId = id
      this.$nextTick(() => {
        const row = this.$el.querySelector('.tomato-record--hot')
        if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      clearTimeout(this._hotTimer)
      this._hotTimer = setTimeout(() => { this.highlightId = null }, 2200)
    },
    /** Earlier versions displayed HH:mm:ss-HH:mm:ss from startTime/endTime; local records are booked by endTime, start time = end - duration.
     *  Rest belongs to the pomodoro unit (user-finalized): with rest present the span = focus start → rest end, presented as a whole span rather than only the focus segment */
    timeRange (r) {
      const end = r.endTime || Date.now()
      const start = r.startTime || end - (r.focusDuration || 0) * 60000
      const rangeEnd = r.restDuration > 0 ? end + r.restDuration * 60000 : end
      return `${this.dfmt(start, 'HH:mm:ss')}-${this.dfmt(rangeEnd, 'HH:mm:ss')}`
    },
    intervalText (r) { return fmtSec((r.focusDuration || 0) * 60) },
    /** List rows use minute-level spans (seconds are noisy); a full unit = focus start → rest end */
    timeRangeShort (r) {
      const end = r.endTime || Date.now()
      const start = r.startTime || end - (r.focusDuration || 0) * 60000
      const rangeEnd = r.restDuration > 0 ? end + r.restDuration * 60000 : end
      return `${this.dfmt(start, 'HH:mm')}-${this.dfmt(rangeEnd, 'HH:mm')}`
    },
    openAdd () {
      // Earlier-version day rollover reset: if the record-add date is not today, reset the count to zero
      const rt = loadRuntime()
      const today = dayjs().format(FMT.date)
      const savedDate = rt.tomatoRecordAddDate ? dayjs(rt.tomatoRecordAddDate).format(FMT.date) : ''
      if (savedDate !== today) {
        saveRuntime({ tomatoRecordAddDate: Date.now(), tomatoRecordAddCount: 0 })
      } else if (this.addLeft <= 0) {
        this.$message.info(this.$t('statsD.TomatoFocusRecord.addLimitReached'))
        return
      }
      this.addForm = { startTs: Date.now(), focusTime: 25, resetTime: 5, focusTaskId: null, focusText: '' }
      this.$store.commit('ui/toggleTomatoRecordAdd', true)
    },
    async saveAdd () {
      if (this.addSaving) return
      // 补限额校验:openAdd 校验后弹窗可能跨零点/连续提交,写前重查每日 3 条限额(2026-09-05 终审 P2)
      const rtNow = loadRuntime()
      const todayNow = dayjs().format(FMT.date)
      const savedDateNow = rtNow.tomatoRecordAddDate ? dayjs(rtNow.tomatoRecordAddDate).format(FMT.date) : ''
      const usedCount = savedDateNow === todayNow ? (Number(rtNow.tomatoRecordAddCount) || 0) : 0
      if (usedCount >= 3) {
        this.$message.info(this.$t('statsD.TomatoFocusRecord.addLimitReached'))
        this.$store.commit('ui/toggleTomatoRecordAdd', false)
        return
      }
      this.addSaving = true
      try {
        const f = this.addForm
        const end = f.startTs + f.focusTime * 60000
        const task = f.focusTaskId ? this.$store.state.todo.todoList.find(x => x.taskId === f.focusTaskId) : null
        this.$store.commit('tomato/addRecord', {
          tomatoId: genTomatoId(), endTime: end, startTime: f.startTs,
          dateKey: dayjs(end).format(FMT.date),
          focus: task ? task.taskContent : (f.focusText || '').trim(),
          focusTaskId: task ? task.taskId : null,
          focusDuration: f.focusTime, rest: f.resetTime, restDuration: f.resetTime,
          succeed: true, status: 'local'
        })
        saveRuntime({ tomatoRecordAddDate: Date.now(), tomatoRecordAddCount: usedCount + 1 }) // 日期+计数同写,跨零点不串账
        this.$message.success(this.$t('statsD.TomatoFocusRecord.addSuccess'))
        this.$store.commit('ui/toggleTomatoRecordAdd', false)
      } finally { this.addSaving = false }
    },
    onRecordContext (e, r) {
      e.preventDefault()
      this.menuRecord = r
      this.$store.commit('ui/openMenu', {
        x: e.clientX, y: e.clientY,
        items: [{ label: this.$t('statsD.TomatoFocusRecord.delete'), icon: 'trash', danger: true, fn: () => this.confirmRemove(r) }]
      })
    },
    confirmRemove (r) {
      this.$confirm(this.$t('statsD.TomatoFocusRecord.confirmDelete'), this.$t('statsD.TomatoFocusRecord.tip'), { type: 'warning', confirmButtonText: this.$t('statsD.TomatoFocusRecord.delete'), cancelButtonText: this.$t('statsD.TomatoFocusRecord.cancel') })
        .then(() => {
          this.$store.commit('tomato/removeRecord', r.tomatoId)
          this.$message.success(this.$t('statsD.TomatoFocusRecord.deleteSuccess'))
        }).catch(() => {})
    },
    close () { this.$store.commit('ui/toggleTomatoFocusRecord', false) },
    /* Click outside blank area to dismiss: same overlay-hit rule as the settings modal (a container/tablecloth hit closes it; clicks inside the dialog are unaffected) */
    maskHide (e) {
      const t = e.target
      if (t && (t.classList.contains('modal-container') || t.classList.contains('modal-tablecloth'))) this.close()
    },
    maskHideAdd (e) {
      const t = e.target
      if (t && (t.classList.contains('modal-container') || t.classList.contains('modal-tablecloth'))) this.$store.commit('ui/toggleTomatoRecordAdd', false)
    }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* 番茄专注记录 · 24h 时间轴：灰轨道=全天，青块=专注时段，hover 显示明细 */
.tfr-timeline { padding: 12px 14px 6px; border-bottom: 1px solid var(--line); }
.tfr-timeline__head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: var(--fs-sm); color: var(--text-2); margin-bottom: 8px;
}
.tfr-timeline__sum { color: var(--brand); }
.tfr-timeline__bar {
  position: relative; height: 14px; border-radius: var(--radius-md);
  background: #ececec; overflow: hidden;
}
.tfr-timeline__seg {
  position: absolute; top: 0; bottom: 0; background: var(--brand);
  border-radius: var(--radius-xs); cursor: default;
  transition: filter .15s, transform .1s;
}
.tfr-timeline__seg:hover { filter: brightness(1.15); }
.tfr-timeline__scale {
  display: flex; justify-content: space-between;
  font-size: var(--fs-2xs); color: var(--text-3); margin-top: 4px;
}
/* 时间轴小时刻度线与图例 */
.tfr-timeline__grid { position: absolute; inset: 0; pointer-events: none; }
.tfr-timeline__grid i { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(0, 0, 0, .06); }
.tfr-timeline__legend { display: flex; gap: 14px; font-size: var(--fs-xs); color: var(--text-3); margin-top: 6px; }
.tfr-timeline__legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: var(--radius-xs); margin-right: 4px; vertical-align: -1px; }
.tfr-timeline__legend .dot-focus { background: var(--brand); }
.tfr-timeline__legend .dot-idle { background: #ececec; }
/* 时间轴被点中的色块短时高亮 */
.tfr-timeline__seg--hot { filter: brightness(1.25); box-shadow: 0 0 0 2px rgba(15, 157, 143, .35); }
/* 时间轴休息块（橙）与记录行休息徽标 */

/* 时间轴日期切换 + 空状态 */
.tfr-timeline__nav { display: inline-flex; align-items: center; gap: 8px; }
.tfr-timeline__date { min-width: 120px; text-align: center; color: var(--text-1); }
/* ===== 以下规则自 base/style-2/3/4 迁入（原散落在各浅色文件内，2026-08-30 集中治理）。内容逐字未改 ===== */
html[data-theme="dark"] .tfr-timeline__bar { background: #2a3038; }
html[data-theme="dark"] .tfr-timeline__grid i { background: rgba(255, 255, 255, .07); }
html[data-theme="dark"] .tfr-timeline__legend .dot-idle { background: #2a3038; }
.tomato-record:last-of-type { border-bottom: 1px solid transparent; }
.tomato-record:hover { background-color: var(--gray-bg, #f7f8fa); }
.tomato-record__title { display: flex; align-items: center; justify-content: space-between; color: var(--text-1, #333); font-weight: 400; font-size: var(--fs-base); line-height: 20px; }
.tomato-record__title__left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.tomato-record__task { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tomato-record__task--free { color: var(--text-3, #909399); }
.tomato-record__range { flex-shrink: 0; font-variant-numeric: tabular-nums; font-size: var(--fs-sm); color: var(--text-3, #909399); }
.tomato-record__title__text { display: flex; align-items: center; }
.tomato-record__title__text__icon { display: block; flex-shrink: 0; width: 14px; height: 14px; margin-left: 10px; background: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22 fill=%22%23ccc%22/></svg>') no-repeat 50%/100% 100%; }
.tomato-record__date { width: 100px; flex-shrink: 0; }
.tomato-record__title__interval { flex-shrink: 0; margin-left: 15px; }
.tomato-record__description { display: flex; align-items: center; margin-top: 10px; }
.tomato-record__description__icon { display: flex; flex-shrink: 0; width: 14px; height: 14px; margin-right: 10px; background: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22 fill=%22%23ccc%22/></svg>') no-repeat 50%/100% 100%; }
.tomato-record__description__text { display: -webkit-box; overflow: hidden; color: #666; font-size: var(--fs-base); line-height: 20px; text-overflow: ellipsis; word-break: break-all; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
/* 添加记录表单行 */
.tfr-form-row { margin-bottom: 16px; }
.tfr-form-label { display: block; margin-bottom: 6px; color: var(--text-2); font-size: var(--fs-md); }
.tfr-add-info { margin: 4px 0 0; color: var(--text-3); font-size: var(--fs-sm); }
.tfr-add-info .text-primary { color: var(--brand, #0c8172); }
/* 专注记录：行点击展开详情 + 时间轴定位高亮 */
.tomato-record { cursor: pointer; }
.tomato-record--open { background: #f3f6f6; }
.tomato-record--hot { background: var(--brand-light); box-shadow: inset 3px 0 0 var(--brand); }
.tomato-record__title__interval { display: flex; align-items: center; gap: 6px; }
.tomato-record .expander { font-style: normal; color: var(--text-3); font-size: var(--fs-2xs); transition: transform .18s; }
.tomato-record .expander.open { transform: rotate(180deg); }
.tomato-record__detail {
  padding: 8px 12px 10px 52px; font-size: var(--fs-sm); color: var(--text-2); line-height: 1.9;
  border-top: 1px dashed var(--line); animation: qa-chip-pop .15s cubic-bezier(.2, .8, .2, 1);
}
.tomato-record__detail-hint { color: var(--text-3); font-size: var(--fs-xs); }
.tfr-nav-btn {
  width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel, #fff);
  color: var(--text-2); font-size: var(--fs-md); line-height: 1; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.tfr-nav-btn:hover:not(:disabled) { color: var(--brand); border-color: var(--brand); }
.tfr-nav-btn:disabled { opacity: .35; cursor: default; }
.tfr-empty { padding: 26px 0 8px; text-align: center; font-size: var(--fs-sm); color: var(--text-3); }
/* —— 白噪音 / 关联任务胶囊：外层相对定位 + 隐藏 el-select 覆盖层 —— */
/* 待开始态的关联任务胶囊（同款样式族） */

/* ==================== 2. base-modal 弹窗体系（modal-container/modal-tablecloth/modal） ==================== */
.modal-container {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  /* 低于 Element UI 弹层基线(2000+)：设置内部的 select/date-picker 下拉与 $confirm 才能浮在弹窗之上 */
  z-index: var(--z-modal) !important;
  background-color: rgba(0,0,0,.25);
  animation: tt-fade-in .2s ease both;
}
.modal-tablecloth {
  position: absolute;
  left: 235px;
  bottom: 110px;
  top: 30px;
  right: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.modal-tablecloth--top { align-items: flex-start; }
.modal-tablecloth--body { left: 0; right: 0; top: 0; bottom: 0; }
/* —— 设置中心：全屏式改为居中无边框卡片弹窗。
      顶边从 25px 开始避开窗口标题栏（蓝色区域），卡片圆角+投影与内容脱钩 —— */
.modal-container--settings { top: 25px; }
@keyframes tt-fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
