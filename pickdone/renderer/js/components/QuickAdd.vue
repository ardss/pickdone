<template>

  <div class="qa-bar">
    <div class="qa-inputwrap">
      <input ref="inp" v-model="text" class="qa-input" :placeholder="$t('statsD.QuickAdd.placeholder')"
             :aria-label="$t('statsD.QuickAdd.ariaLabel')"
             @keyup.enter="e => { if (e.isComposing || e.keyCode === 229) return; onEnter() }"/>
      <transition name="fade">
        <span v-if="nlHasLabel()" class="qa-date-chip" role="button" tabindex="0"
              :aria-label="$t('statsD.QuickAdd.clearDateAria', { d: nlLabel() })" @click="clearDate"
              @keydown.enter.prevent="clearDate">
          <i class="ico" style="--ico:url('app://app/assets/img/calendar_month_black_24dp.svg');width:16px;height:16px"></i>{{nlLabel()}}<i class="close-x close-x--sm" style="margin-left:2px"></i>
        </span>
      </transition>
      <span class="qa-cal" :title="$t('statsD.QuickAdd.selectDate')">
        <span class="todo-input-add__calender"></span>
        <el-date-picker class="qa-cal-picker" size="small" value-format="x" type="date"
                        :aria-label="$t('statsD.QuickAdd.selectDate')"
                        :clearable="true" :model-value="effDate && effDate !== 0 ? effDate : null"
                        @update:model-value="onCalPick"/>
      </span>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Quick-add bar -- alignment reference:
 * Input box + a todo-options date option row expanded on focus (today/tomorrow/pick a date ▾/no date -> todo box) + NL date parsing
 * A calendar button always resides at the input's right edge (todo-input-add__calender, #0c8172)
 */
import { parseNaturalDate } from '../utils/nlDate.js'
import {dayjs, FMT } from '../utils/core.js'
import { resolveQuickAddDate } from '../utils/quickAddDate.js'

export default {
  name: 'QuickAdd',
  data () {
    return {
      text: '',
      // Single source of truth for the date: null = not manually set (falls back to NL parsing / default today), number = manually set, 0 = explicitly "no date"
      // ✕ clear sets it to 0; the manual value takes precedence over the parsed one, no need for mutual-exclusion patches like suppressParsed
      pickedDate: null as any
    }
  },
  watch: {
    // A manually picked date is sticky once set: editing the text does not destroy it (destroying on text change would silently drop the user's chosen date)
    text () { if (!this.text) this.pickedDate = null }
  },
  computed: {
    parsed () {
      const r = parseNaturalDate(this.text)
      return r && r.date ? r : null
    },
    // Decision semantics live in utils/quickAddDate.js (pure function, unit-testable); null = unspecified (the caller decides the default target)
    effDate () {
      if (this.pickedDate === 0) return 0
      return this.pickedDate || (this.parsed ? this.parsed.date.valueOf() : null)
    },
    // When creating on the todo box page, default to "no date" (goes to the todo box) -- the todo box is the home of undated tasks; defaulting to today would be counterintuitive; other pages keep the default of today
    inTodoBox () {
      return this.$route && this.$route.name === 'todo-list-todo-box'
    },
    // Category/project page context: created tasks should belong to the current list (categoryId), otherwise they land in the default category and are invisible on the current page
    routeCategoryId () {
      const name = this.$route && this.$route.name
      if (name === 'todo-list-category' || name === 'todo-list-project') {
        const id = Number(this.$route.params.id)
        return Number.isFinite(id) && id > 0 ? id : null
      }
      return null
    },
    // Tag page context: tags are embedded in the content (#tag); the tag text must be appended at creation for the task to appear on that tag page
    routeTag () {
      return this.$route && this.$route.name === 'todo-list-tag' ? String(this.$route.params.id || '') : ''
    }
  },
  mounted () {
    window.addEventListener('todo:focus-quickadd', this.focusInput)
  },
  beforeUnmount () {
    window.removeEventListener('todo:focus-quickadd', this.focusInput)
  },
  methods: {
    focusInput () { this.$refs.inp.focus() },
    clearDate () {
      this.pickedDate = 0 // explicitly "no date" (goes to the todo box); NL parsing no longer applies
    },
    // Right-edge calendar button: pops up the standard Element Plus calendar to pick a date; clearing = no date
    onCalPick (ts) {
      this.pickedDate = ts || null
    },
    nlHasLabel () {
      if (this.pickedDate === 0) return true
      if (this.pickedDate) return true
      return !!this.parsed
    },
    nlLabel () {
      if (this.pickedDate === 0) return this.$t('statsD.QuickAdd.noDate')
      if (this.pickedDate) return dayjs(this.pickedDate).format(FMT.cnDate)
      if (this.parsed) return this.parsed.label
      return ''
    },
    async onEnter () {
      if (this._submitting) return // pressing Enter repeatedly within the await window would create duplicate tasks
      const raw = this.text.trim()
      if (!raw) return
      this._submitting = true
      let content = raw
      if (this.parsed) content = this.parsed.restText || raw
      // Tag page context: tags are embedded in the content (#tag); appending it is required to land under the current tag (skip if the same tag already exists)
      const tag = this.routeTag
      if (tag && !content.includes('#' + tag)) content = content + ' #' + tag
      try {
      const payload: any = {
        todoContent: content,
        todoDescription: '',
        // When no date is specified: the todo box page defaults to "no date" (into the todo box), other pages default to today (project baseline semantics)
        todoDate: resolveQuickAddDate({ pickedDate: this.effDate, parsedTs: null, inTodoBox: this.inTodoBox, todayTs: dayjs().startOf('day').valueOf() }),
        todoReminderTime: 0,
        todoDifficultyLevel: 0,
        addToTop: false
      }
      // Category/project page context: belong to the current list, not the global default category (otherwise the current page cannot see the created task)
      if (this.routeCategoryId != null) payload.categoryId = this.routeCategoryId
      await this.$store.dispatch('todo/addTodo', payload)
      // Read the effective date before clearing (effDate is a computed property and becomes invalid once cleared)
      let d = this.effDate
      this.text = ''
      this.pickedDate = null
      // When created with a date, toast which day it landed on; when unspecified: the todo box page stays undated (toast says it went to the todo box), others default to today (consistent with addTodo semantics)
      if (d == null && !this.inTodoBox) d = dayjs().startOf('day').valueOf()
      const when = d && d !== 0 ? this.$t('statsD.QuickAdd.scheduledAt') + (dayjs(d).isSame(dayjs(), 'day') ? this.$t('statsD.QuickAdd.today') : dayjs(d).format(FMT.cnDate)) : this.$t('statsD.QuickAdd.movedToInbox')
      const msg = this.$t('statsD.QuickAdd.created', { c: content }) + when
      this.$message.success(msg)
      if (this.$announce) this.$announce(msg)
      this.$emit('created', { content, date: d })
      } finally { this._submitting = false }
    }
  },

}
</script>
