<template>

  <div class="modal-container" @click.self="close">
    <!-- --body centered in the full viewport: the default tablecloth insets (left:235px/bottom:110px) exist to make room for the sidebar/tomato bar for the settings half-screen dialog; the repeat dialog landing on them would skew over the edit bar (user-reported occlusion + skew) -->
    <div class="modal-tablecloth modal-tablecloth--body" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('statsD.RepeatModal.aria')" style="width:520px;max-height:100%" @keydown.esc="close">
        <div class="modal__header"><span>{{ $t('statsD.RepeatModal.title') }}</span><button type="button" class="modal__close close-x" :aria-label="$t('statsD.RepeatModal.close')" @click="close"></button></div>
        <div class="modal__body">
          <template v-if="templateTodo">
          <div class="rm-base">{{ $t('statsD.RepeatModal.baseEvent') }}{{baseLabel}} · {{templateTodo.taskContent}}</div>

          <div class="rm-row">
            <span class="rl">{{ $t('statsD.RepeatModal.type') }}</span>
            <!-- radio value = stable key (day/week/month/year); label = i18n text. Values used to be translated strings, which mismatched persisted rules under non-Chinese UI -->
            <el-radio-group size="small" :model-value="form.repeatType" @change="v=>patch({repeatType:v})">
              <el-radio-button value="day">{{ $t('statsD.RepeatModal.byDay') }}</el-radio-button>
              <el-radio-button value="week">{{ $t('statsD.RepeatModal.byWeek') }}</el-radio-button>
              <el-radio-button value="month">{{ $t('statsD.RepeatModal.byMonth') }}</el-radio-button>
              <el-radio-button value="year">{{ $t('statsD.RepeatModal.byYear') }}</el-radio-button>
            </el-radio-group>
          </div>

          <div class="rm-row" v-if="form.repeatType!=='year'">
            <span class="rl">{{ $t('statsD.RepeatModal.interval') }}</span>
            <span class="rm-ctl">{{ $t('statsD.RepeatModal.every') }} <el-input-number size="small" :controls="false" v-model="form.repeatInterval" :min="1" :max="60"/><span class="hint-q" :title="$t('statsD.RepeatModal.intervalHint')">?</span> {{ form.repeatType==='day' ? $t('statsD.RepeatModal.unitDay') : form.repeatType==='week' ? $t('statsD.RepeatModal.unitWeek') : $t('statsD.RepeatModal.unitMonth') }}</span>
          </div>

          <div class="rm-row">
            <span class="rl">{{ $t('statsD.RepeatModal.count') }}</span>
            <span class="rm-ctl">
              <template v-if="form.repeatType==='day'"><el-input-number size="small" :controls="false" v-model="form.repeatDayCount" :min="1" :max="365"/> {{ $t('statsD.RepeatModal.inDays') }}</template>
              <template v-if="form.repeatType==='week'"><el-input-number size="small" :controls="false" v-model="form.repeatWeekCount" :min="1" :max="104"/> {{ $t('statsD.RepeatModal.inWeeks') }}</template>
              <template v-if="form.repeatType==='month'"><el-input-number size="small" :controls="false" v-model="form.repeatMonthCount" :min="1" :max="120"/> {{ $t('statsD.RepeatModal.inMonths') }}</template>
              <template v-if="form.repeatType==='year'"><el-input-number size="small" :controls="false" v-model="form.repeatYearCount" :min="1" :max="10"/> {{ $t('statsD.RepeatModal.inYears') }}</template>
              <span class="hint-q" :title="$t('statsD.RepeatModal.countHint')">?</span>
            </span>
          </div>

          <div class="rm-row" v-if="form.repeatType==='week'">
            <span class="rl">{{ $t('statsD.RepeatModal.weekly') }}</span>
            <el-checkbox-group size="small" :model-value="form.repeatWeekDays" @update:model-value="v=>patch({repeatWeekDays:v})">
              <el-checkbox-button v-for="w in weekdays" :key="w.v" :label="w.v">{{ $t('statsD.RepeatModal.' + w.l) }}</el-checkbox-button>
            </el-checkbox-group>
          </div>

          <div class="rm-row" v-if="form.repeatType==='month'">
            <span class="rl">{{ $t('statsD.RepeatModal.monthly') }}</span>
            <el-select multiple collapse-tags size="small" style="width:280px" :placeholder="$t('statsD.RepeatModal.selectDates')"
                       :model-value="form.repeatMonthDays" @change="v=>patch({repeatMonthDays:v})">
              <el-option v-for="d in monthDaysOptions" :key="d" :label="$t('statsD.RepeatModal.dayN', { d })" :model-value="d"/>
            </el-select>
          </div>

          <div class="rm-row" v-if="form.repeatType==='year'">
            <span class="rl">{{ $t('statsD.RepeatModal.yearly') }}</span>
            <el-radio-group size="small" :model-value="form.repeatYearType" @change="v=>patch({repeatYearType:v})">
              <el-radio-button value="gregorian">{{ $t('statsD.RepeatModal.gregorian') }}</el-radio-button>
              <el-radio-button value="lunar">{{ $t('statsD.RepeatModal.lunar') }}</el-radio-button>
            </el-radio-group>
          </div>

          <div class="rm-row" v-if="form.repeatType==='year' && form.repeatYearType!=='lunar'">
            <span class="rl">{{ $t('statsD.RepeatModal.yearly') }}</span>
            <el-date-picker size="small" type="date" :placeholder="$t('statsD.RepeatModal.pickFixedDate')" value-format="x"
                            :model-value="new Date(2026, form.repeatYearMonth-1, form.repeatYearMonthDay).getTime()"
                            @update:model-value="ts=>{const d=new Date(ts);patch({repeatYearMonth:d.getMonth()+1,repeatYearMonthDay:d.getDate()})}"/>
          </div>

          <div class="rm-row" v-if="form.repeatType==='year' && form.repeatYearType==='lunar'">
            <span class="rl">{{ $t('statsD.RepeatModal.yearly') }}</span>
            <el-select size="small" style="width:140px" :model-value="form.repeatYearMonth"
                       @change="v=>patch({repeatYearMonth:v})">
              <el-option v-for="m in 12" :key="m" :label="$t('statsD.RepeatModal.lunarMonthN', { m })" :value="m"/>
            </el-select>
            <el-select size="small" style="width:120px" :model-value="form.repeatYearMonthDay"
                       @change="v=>patch({repeatYearMonthDay:v})">
              <el-option v-for="d in 30" :key="d" :label="$t('statsD.RepeatModal.lunarDayN', { d })" :value="d"/>
            </el-select>
            <span class="hint-q" :title="$t('statsD.RepeatModal.lunarSkipHint')">?</span>
          </div>

          <div class="rm-skip">
            <label><el-switch :model-value="form.skipStatutoryHolidays" @change="v=>patch({skipStatutoryHolidays:v})" :disabled="form.statutoryWorkdays"/></label> {{ $t('statsD.RepeatModal.skipHolidays') }} &nbsp;&nbsp;
            <label><el-switch :model-value="form.skipWeekends" @change="v=>patch({skipWeekends:v})" :disabled="form.statutoryWorkdays"/></label> {{ $t('statsD.RepeatModal.skipWeekends') }} &nbsp;&nbsp;
            <label><el-switch :model-value="form.statutoryWorkdays" @change="v=>patch({statutoryWorkdays:v})"/></label> {{ $t('statsD.RepeatModal.workdaysOnly') }}<span class="hint-q" :title="$t('statsD.RepeatModal.workdayHint')">?</span>
          </div>

          <div class="rm-preview">{{ $t('statsD.RepeatModal.previewPrefix') }}<b>{{previewCount}}</b>{{ $t('statsD.RepeatModal.previewSuffix') }}</div>
          </template>
          <div v-else class="rm-base">{{ $t('statsD.RepeatModal.noBase') }}</div>
        </div>
        <div class="modal__footer">
          <el-button size="small" @click="close">{{ $t('statsD.RepeatModal.cancel') }}</el-button>
          <el-button size="small" type="primary" :loading="generating" :disabled="!templateTodo" @click="generate">{{ $t('statsD.RepeatModal.generate') }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Recurring task settings modal -- generates a batch of pre-expanded groups (rule fields aligned with repeatSettingsV2) */
import { expandRepeatDates } from '../utils/repeat.js'
import {dayjs, FMT } from '../utils/core.js'
import dialogA11y from '../utils/dialogA11y.js'

// l is the i18n key tail segment (statsD.RepeatModal.wd*), resolved with $t at render time
const WEEKDAYS = [{ v: 1, l: 'wd1' }, { v: 2, l: 'wd2' }, { v: 3, l: 'wd3' }, { v: 4, l: 'wd4' }, { v: 5, l: 'wd5' }, { v: 6, l: 'wd6' }, { v: 7, l: 'wd7' }]

export default {
  name: 'RepeatModal',
  mixins: [dialogA11y],
  data () {
    return {
      form: null as any,
      weekdays: WEEKDAYS,
      monthDaysOptions: Array.from({ length: 31 }, (_, i) => i + 1),
      generating: false
    }
  },
  computed: {
    templateTodo () {
      const id = this.$store.state.ui.showRepeatModalFor
      return this.$store.state.todo.todoList.find(t => t.taskId === id) || null
    },
    /* Preview and generation share the same expanded sequence: the first day is excluded (the template task already has one that day; including the first day would create a same-day duplicate) */
    effectiveDates () {
      const tpl = this.templateTodo
      if (!tpl || !tpl.todoTime) return []
      const base0 = +new Date(tpl.todoTime).setHours(0, 0, 0, 0)
      return expandRepeatDates(tpl.todoTime, this.form, this.$store.state.todo.holidayList)
        .filter(d => +new Date(d).setHours(0, 0, 0, 0) !== base0)
    },
    previewCount () {
      if (!this.templateTodo || !this.templateTodo.todoTime) return this.form.repeatType === 'day' ? this.form.repeatDayCount : '-'
      return Math.min(this.effectiveDates.length, this.maxRepeat)
    },
    maxRepeat () { return parseInt(this.$store.state.settings.maxRepeat) || 2 },
    baseLabel () {
      return this.templateTodo && this.templateTodo.todoTime
        ? dayjs(this.templateTodo.todoTime).format(FMT.cnFull)
        : this.$t('statsD.RepeatModal.noDate')
    }
  },
  created () {
    this.form = JSON.parse(JSON.stringify(this.$store.state.repeatSettings))
  },
  methods: {
    patch (p) { Object.assign(this.form, p) },
    async generate () {
      if (!this.templateTodo) return
      this.generating = true
      try {
        const tpl = this.templateTodo
        // Persist the current rule as the default
        this.$store.commit('repeatSettings/updateSettings', JSON.parse(JSON.stringify(this.form)))
        let dates = []
        if (tpl.todoTime) dates = this.effectiveDates
        // Respect the "max recurring task group count" setting
        let truncated = false
        if (dates.length > this.maxRepeat) { dates = dates.slice(0, this.maxRepeat); truncated = true }
        const repeatId = `repeat_${tpl.userId}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
        // The rule is persisted with the group: when the last item in the group completes, toggleComplete can use it to auto-renew
        const ruleJson = JSON.stringify(this.form)
        // Authority = meta (same source as CLI; the 5175 shim implements meta too); the historical LS fallback was removed (2026-09-03 redundancy cleanup)
        window.todoAPI.dbCall('setMeta', ['repeatRule:' + repeatId, ruleJson]).catch(e => console.error('[repeat] rule save failed:', e))
        let made = 0
        for (let i = 0; i < dates.length; i++) {
          const d = dates[i]
          let remind = 0
          if (tpl.reminderTime > 0) {
            const t = dayjs(tpl.reminderTime)
            remind = d.hour(t.hour()).minute(t.minute()).second(0).valueOf()
          }
          await this.$store.dispatch('todo/addTodo', {
            categoryId: tpl.categoryId,
            todoContent: tpl.taskContent,
            todoDescription: tpl.taskDescribe || '',
            todoDate: d.valueOf(),
            todoReminderTime: remind,
            todoReminderOffsets: Array.isArray(tpl.reminderOffsets) ? tpl.reminderOffsets : [],
            todoDifficultyLevel: tpl.difficulty || 0,
            repeatId,
            // Generated instances always start unchecked, matching the store's ensureNextRepeatInstance semantics
            todoSublist: (function(){ try { const list = JSON.parse(tpl.subtasks || 'null'); return Array.isArray(list) ? list.map(x => ({ ...x, checked: false })) : list } catch (e) { return null } })(),
            todoImage: tpl.image,
            fileList: tpl.files,
            addToTop: false
          })
          made++
        }
        this.$store.commit('ui/askRepeatEdit', null)
        this.$message.success(this.$t('statsD.RepeatModal.generated', { n: made }) + (truncated ? this.$t('statsD.RepeatModal.truncated', { n: this.maxRepeat }) : ''))
      } finally { this.generating = false }
    },
    close () { this.$store.commit('ui/askRepeatEdit', null) }
  },

}
</script>
<style>.form { max-width: 100%; }
@keyframes modal-pop { from { opacity: 0; transform: translateY(8px) scale(.96); } }
</style>
