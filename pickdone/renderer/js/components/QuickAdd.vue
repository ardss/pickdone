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
  // pickedDate is intentionally NOT reset when text is cleared: the chip stays until the user
  // explicitly clears it via the chip ✕ (pickedDate = 0) or submits (onEnter resets both)
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
<style>
.qa-inputwrap {
  position: relative; flex: 1; display: flex; align-items: center;
  background: var(--gray-bg); border: 1px solid var(--line); border-radius: var(--radius-lg);
  transition: border-color .2s, box-shadow .2s;
}
.qa-inputwrap:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(15, 157, 143, .08); background: var(--panel, #fff); }
/* —— 6. 快捷添加输入条：设计稿 .todo-input-add__input[scoped]
      padding:10px 17px 字号12px lh17 底#f8f8f8 边1px #f3f3f3 圆角5px —— */
.qa-inputwrap {
  border-radius: var(--radius-sm);
  overflow: hidden;
  transition: border-color var(--dur-mid) cubic-bezier(.645,.045,.355,1);
}
.qa-inputwrap:focus-within { box-shadow: none; }
html[data-theme="dark"] .qa-inputwrap:focus-within { background: var(--active-bg); }

.qa-cal .todo-input-add__calender { position: static; width: 100%; height: 100%; }
/* ==================== 2. QuickAdd 日历按钮与日期 chip ==================== */
/* 输入框右侧常驻日历按钮：
   .todo-input-add__calender{
     position:absolute;top:0;right:0;bottom:0;display:flex;align-items:center;
     justify-content:center;padding:10px 12px;color:var(--brand-dark);...}
*/
.todo-input-add__calender {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  width: 40px; padding: 0; color: var(--brand-dark); font-weight: 500; font-size: var(--fs-sm);
  background: none; border: none; cursor: pointer;
  border-top-right-radius: 5px; border-bottom-right-radius: 5px;
}
/* 图标用本项目 assets 的 calendar_month_black_24dp，遮罩着色为 var(--brand-dark) */
.todo-input-add__calender::before {
  display: block; width: 16px; height: 16px; content: "";
  background-color: currentColor;
  -webkit-mask: url("app://app/assets/img/calendar_month_black_24dp.svg") no-repeat 50% / 16px 16px;
  mask: url("app://app/assets/img/calendar_month_black_24dp.svg") no-repeat 50% / 16px 16px;
}
.todo-input-add__calender:hover,
.todo-input-add__calender:active { background-color: #f3f3f3; }
/* Keyboard focus ring for the calendar trigger (was outline: none, which made focus invisible) */
.todo-input-add__calender:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.todo-input-add__calender img { width: 15px; height: 15px; }

/* 日期选择浮层覆盖在日历按钮上（透明触发层）——
   设计稿做法: .todo-options__item--datetime .mx-datepicker{
     position:absolute;top:0;right:0;bottom:0;left:0;width:100%;opacity:0} */
.qa-cal-picker {
  position: absolute !important; top: 0; right: 0; z-index: var(--z-row);
  width: 40px !important; max-width: 40px; height: 100%;
  opacity: 0; overflow: hidden;
}
/* ==================== 5. EditPanel 右侧编辑栏 ==================== */
/* 分类/日期 chip：设计稿 .todo-options__item[scoped]{padding:4px 12px;color:#595959;
   font-size: var(--fs-sm);line-height:17px;background:#f5f4f5;border-radius:12.5px}
   --active{color:#fff;background:var(--brand)}

/* 分组页头部「全部展开/折叠」文字按钮（最近待办等分组视图共用） */
.grp-toggle-btn {
  display: inline-flex; align-items: center; gap: var(--space-1);
  font-size: var(--fs-md); color: var(--text-3); cursor: pointer;
  transition: color var(--dur-fast);
}
/* ============ 侧边栏滚动条对齐设计稿 simplebar（6px 圆角细条） ============ */

/* ============ 快捷添加 todo-options 日期选项行（设计稿同类名） ============ */
.todo-options { display: flex; gap: var(--space-2); align-items: center; margin-top: 10px; flex-wrap: wrap; }
.todo-options__item {
  padding: 5px 16px; border-radius: 15px; background: var(--gray-bg); color: var(--text-2);
  font-size: var(--fs-sm); line-height: 17px; cursor: pointer; position: relative;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.todo-options__item:hover { background: var(--hover-bg); }
.todo-options__item:active { background: #e1e0e1; }
.todo-options__item--active { background: var(--brand); color: #fff; }
.todo-options__item--active:hover { background: #11a1a2; }
.qa-bar { position: relative; display: flex; align-items: flex-start; gap: 8px; }
/* 日历按钮壳：透明 el-date-picker 铺满按钮，点击即弹标准日历面板 */
.qa-cal { position: absolute; top: 0; right: 0; bottom: 0; width: 40px; z-index: 2; cursor: pointer; }
.qa-cal .qa-cal-picker.el-date-editor { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; }
.qa-cal .qa-cal-picker .el-input__inner { width: 100%; height: 100%; cursor: pointer; }
.qa-input { flex: 1; height: 46px; border: 0; background: none; padding: 0 16px; font-size: var(--fs-md); color: var(--text-1); border-radius: var(--radius-lg); }
.qa-input::placeholder { color: #8a9099; }
.qa-date-chip {
  display: inline-flex; align-items: center; gap: var(--space-1); margin-right: 12px;
  color: var(--brand); font-size: var(--fs-sm); cursor: pointer; white-space: nowrap;
}
.qa-date-chip img { width: 13px; height: 13px; }
.qa-dots { display: none; }
.qa-pop {
  position: absolute; top: 52px; left: 0; right: 40px; z-index: var(--z-list-pop);
  background: var(--panel, #fff); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; font-size: var(--fs-sm); color: var(--text-2);
}
.qa-row { display: flex; align-items: center; gap: 8px; }
/* 6. 快捷添加的日期 chip pop 出场（原为生硬 fade） */
.qa-date-chip { animation: qa-chip-pop .15s cubic-bezier(.2, .8, .2, 1); }
/* 「选择日期」按钮内嵌透明 el-date-picker（同 .qa-cal 手法），铺满按钮点击即弹 */
.todo-list .rc-pick{position:absolute;top:0;left:0;width:100%;height:100%;opacity:0;border:0;padding:0;background:none;cursor:pointer}
.qa-cal-picker .el-input__inner { height: 46px; line-height: 46px; cursor: default; }
/* chip 给右侧按钮留位；✕ 清除 */
.qa-date-chip { margin-right: 46px; }
.qa-chip-x {
  font-weight: 400; font-style: normal; font-size: var(--fs-xs); color: inherit;
  opacity: .55; margin-left: 2px; cursor: pointer;
}
.qa-chip-x:hover { opacity: 1; }
.qa-input {
  height: auto; min-height: 37px;
  padding: 10px 17px;
  font-weight: 400; font-size: var(--fs-sm); line-height: 17px; color: var(--text-1);
  border-radius: var(--radius-sm);
}
.page__header{position:relative;z-index:2;display:flex;flex-direction:column;gap:18px;padding:18px;box-shadow:0 2px 4px hsla(0,0%,91.4%,.5)}
.page__header--no-shadow{box-shadow:none}
.page__header--has-title-bar{padding-top:30px}
.page__top{display:flex;flex-shrink:0;gap:18px;align-items:center}
.page__main{flex:1;height:100%;overflow:auto}
.page__main--has-padding{padding:0 25px 25px}
.page__todo-list-multi-select{position:absolute;right:10px;bottom:10px;left:10px;z-index:1}
.page__todo-list-multi-select-placeholder{height:66px}
/* 视图根为 .page 时占满滚动区高度（避免 .main-scroll 无高度参照） */
.main-scroll>.page{min-height:100%}
/* ========================= 数据复盘（StatisticsView）========================= */
/* 结构（2026-08-29 对齐全应用）：.page__header(.title 页头) + .stat-subpage 阅读列。
   历史：本段原为构建产物逆向的 navbar/m-select 体系，页头统一重构时删除。 */
.stat-page .content{flex:1;overflow:auto;background:var(--bg)}
@keyframes qa-chip-pop { from { opacity: 0; transform: scale(.85); } }
</style>
