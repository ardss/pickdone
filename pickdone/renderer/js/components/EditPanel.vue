<template>

  <transition name="slide-right" appear>
  <aside v-if="e" class="edit-panel" @click.stop>
    <div class="ep-inner">
        <div v-if="saveFailed" class="ep-save-failed" role="alert">{{ $t('statsJ.EditPanel.saveFailed') }}</div>
      <div class="ep-title-row">
        <el-input type="textarea" :autosize="{minRows:1,maxRows:4}" :placeholder="$t('statsJ.EditPanel.addTitlePlaceholder')"
                  :model-value="e.title" @input="v=>fieldPatch('title',v)" class="ep-title"/>
        <!-- Persistent equal-width placeholder (ghost): with v-if the title textarea's usable width would jump at the start/end of every autosave -->
        <span class="ep-saving" :class="{ghost: !saving}" aria-live="polite" :aria-hidden="!saving">…</span>
        <span class="ep-collapse-btn" :title="$t('statsJ.EditPanel.collapseEditor')" role="button" tabindex="0"
              :aria-label="$t('statsJ.EditPanel.collapseEditor')" @click="collapse" @keydown.enter.prevent="collapse">
          <svg viewBox="0 0 16 16"><path d="M6 3.5 L11 8 L6 12.5" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>

      <el-input type="textarea" :autosize="{minRows:3,maxRows:8}" :placeholder="$t('statsJ.EditPanel.descPlaceholder')"
                :model-value="e.desc" @input="v=>fieldPatch('desc',v)" class="ep-desc"
                @paste="onDescPaste" @dragover.prevent @drop.prevent="onDescDrop"/>
      <ep-attachments section="bar" :img-list="imgList" :file-list="fileList"
                      @pick="pickFiles" @preview="previewImg=$event" @remove="removeFile"/>

      <div class="ep-date-chips">
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===todayLabel}"
              @click="setDate('today')" @keydown.enter.prevent="setDate('today')"><app-icon name="sun" :size="12"/>{{ $t('statsJ.EditPanel.todayOption') }}</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===tomorrowLabel}"
              @click="setDate('tomorrow')" @keydown.enter.prevent="setDate('tomorrow')"><app-icon name="calendar" :size="12"/>{{ $t('statsJ.EditPanel.tomorrowOption') }}</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel}"
              @click="setDate('pick')" @keydown.enter.prevent="setDate('pick')"><app-icon name="calendar" :size="12"/>
          {{dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel ? dateChip : $t('statsJ.EditPanel.pickDate')}} ▾</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: !e.dateTs}"
              @click="setDate('none')" @keydown.enter.prevent="setDate('none')">{{ $t('statsJ.EditPanel.noDateOption') }}</span>
        <!-- The picker sits outside the chip, avoiding ARIA nesting of an input inside a button -->
        <el-date-picker ref="datePick" size="small" value-format="x" type="date"
                        style="width:0;height:0;border:0;padding:0;position:absolute;opacity:0" class="ep-date-pick"
                        :aria-label="$t('statsJ.EditPanel.pickDateAria')" popper-class="ep-date-popper"
                        :model-value="e.dateTs||null" @update:model-value="onPickDate"/>
      </div>

      <div class="ep-cat-wrap">
        <div class="ep-row ep-cat-row" role="button" tabindex="0" :aria-expanded="catOpen ? 'true' : 'false'"
             @click="catOpen=!catOpen" @keydown.enter.prevent="catOpen=!catOpen">
          <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.categoryLabel')"><app-icon name="tag" :size="13"/></span>
          <span v-if="curCat" class="ep-cat-dot" :style="{background: curCat.categoryColor}"></span>
          <span class="ep-cat-name" :class="{'is-placeholder': !curCat}">{{ curCat ? curCat.categoryName : $t('statsJ.EditPanel.uncategorized') }}</span>
          <span class="ml-auto"></span>
          <span class="ep-row-arrow" :class="{on: catOpen}">▾</span>
        </div>
        <div v-if="catOpen" v-click-outside="() => catOpen = false" class="ep-cat-pop" role="listbox">
          <div class="ep-cat-opt" role="option" :class="{on: !e.categoryId}" :aria-selected="(!e.categoryId)?'true':'false'"
               tabindex="0" @click="pickCat(0)" @keydown.enter.prevent="pickCat(0)">
            <span class="ep-cat-dot" style="background:var(--text-4)"></span>{{ $t('statsJ.EditPanel.uncategorizedOption') }}</div>
          <div v-for="c in cats" :key="c.categoryId" class="ep-cat-opt" role="option"
               :class="{on: e.categoryId===c.categoryId}" :aria-selected="(e.categoryId===c.categoryId)?'true':'false'"
               tabindex="0" @click="pickCat(c.categoryId)" @keydown.enter.prevent="pickCat(c.categoryId)">
            <span class="ep-cat-dot" :style="{background: c.categoryColor}"></span> {{ c.categoryName }}
          </div>
        </div>
      </div>

      <!-- Task dependencies (experimental; gated by devMode = developerMode && showDepsModule): predecessor multi-select, FS semantics -- task becomes ready only when all predecessors are done -->
      <div v-if="devMode" class="ep-cat-wrap">
        <ep-dependencies :task="e" @patch="patchPreds"/>
      </div>

      <div class="ep-row ep-tags-row">
        <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.tagsPlaceholder')"><b class="ep-hash">#</b></span>
        <span v-for="t in taskTags" :key="t" class="ep-tag-chip">
          #{{ t }}
          <span class="ep-tag-x close-x" role="button" tabindex="0" :title="$t('statsJ.EditPanel.removePrefix') + t" :aria-label="$t('statsJ.EditPanel.removeTag', { t: t })"
                @click.stop="removeTag(t)" @keydown.enter.prevent.stop="removeTag(t)"></span>
        </span>
        <input class="ep-tag-input" v-model="tagInput" :placeholder="$t('statsJ.EditPanel.addTagHint')" :aria-label="$t('statsJ.EditPanel.addTag')"
               @keydown.enter.prevent="addTag" @blur="addTag"/>
      </div>

      <div v-if="inRecycle" class="ep-recycle-banner">
        <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
        <span>{{ $t('statsJ.EditPanel.recycleBinEditTip') }}</span>
        <button class="mini" @click="restoreFromBin">{{ $t('statsJ.EditPanel.restoreBtn') }}</button>
      </div>

      <div v-if="!inRecycle" class="ep-row ep-done-row" role="checkbox" :aria-checked="(task&&task.complete)?'true':'false'" tabindex="0"
           @click="toggleComplete" @keydown.enter.prevent="toggleComplete">
        <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.doneBtn')"><app-icon name="check" :size="13"/></span>
        <span class="ep-done-label">{{ $t('statsJ.EditPanel.doneBtn') }}</span>
        <span class="ml-auto"></span>
        <span class="ep-sub-check" :class="{on: task&&task.complete}">{{ (task&&task.complete) ? '✓' : '' }}</span>
      </div>

      <ep-reminders :task="e" @commit="onRemindersCommit" @clear="onRemindersClear" @offsets="onRemindersOffsets"/>

      <div v-if="!inRecycle" class="ep-row ep-repeat-row" role="button" tabindex="0"
           :aria-label="isRepeat ? $t('statsJ.EditPanel.editRepeatRule') : $t('statsJ.EditPanel.setRepeat')"
           @click="askRepeatEdit" @keydown.enter.prevent="askRepeatEdit">
        <span class="ep-field-label ep-field-ico" :title="$t('statsE.TodoItem.repeatLabel')"><app-icon name="repeat" :size="13"/></span>
        <span class="ep-remind-label" :class="{'ep-remind-label--active': isRepeat}">{{ isRepeat ? $t('statsJ.EditPanel.repeatPrefix') + $t('statsJ.EditPanel.repeatN', { n: repeatCount }) : $t('statsJ.EditPanel.setRepeat') }}</span>
        <span class="ml-auto"></span>
        <template v-if="isRepeat">
          <button class="ep-mini" @click.stop="askRepeatEdit">{{ $t('statsJ.EditPanel.ruleLabel') }}</button>
          <button class="ep-mini danger" @click.stop="askRepeatDelete">{{ $t('statsJ.EditPanel.deleteEllipsis') }}</button>
        </template>
      </div>

      <ep-subtasks :subs="subList" @add="addSub" @toggle="toggleSub" @remove="delSub" @move="moveSub"/>

      <div class="ep-row ep-prio">
        <img class="ep-ico" src="app://app/assets/img/icon-tune.svg" style="opacity:.6">
        <span class="ep-diff-label">{{ $t('statsJ.EditPanel.priorityLabel') }}</span><span class="hint-q" :title="$t('statsJ.EditPanel.urgencyHint')">?</span>
        <span class="ep-diff-btns ep-prio-btns">
          <button v-for="pr in PRIOS" :key="pr.v" :class="['prio-'+pr.v, {on:((task&&task.priority)||0)===pr.v}]" @click="fieldPatch('priority', ((task&&task.priority)||0)===pr.v?0:pr.v)">{{ tt(pr.l) }}</button>
        </span>
      </div>
      <div class="ep-row ep-tomato-est">
        <img class="ep-ico" src="app://app/assets/img/icon-tomato-timer2.svg" style="opacity:.6">
        <span class="ep-diff-label">{{ $t('statsG.EpTomato.est') }}</span><span class="hint-q" :title="$t('statsG.EpTomato.estTip')">?</span>
        <!-- Single ledger: estimated is editable (− number +), actual is read-only (reconciled from focus records; corrections go via the context-menu focus entry) — the pomodoro icon scheme was rejected by the user (±1 per click was ambiguous), reverted to the number version -->
        <!-- Integrated ledger control (user-finalized 2026-09-03): estimate stepper segment + actual segment share one equal-height housing, whole housing highlights on selection, clicking the actual segment opens the ledger dialog -->
        <span class="ep-tom-account" :class="{gain: tomatoActual > 0}">
          <span class="ep-tom-seg ep-tom-seg--est">
            <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estDecrease')" @click.stop="estDelta(-1)">−</button>
            <span class="ep-tom-num">{{ tomatoEstimateN }}</span>
            <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estIncrease')" @click.stop="estDelta(1)">+</button>
            <img class="ep-tom-ico" src="app://app/assets/img/icon-tomato-timer2.svg" alt="">
          </span>
          <span class="ep-tom-seg ep-tom-seg--act" role="button" tabindex="0"
                :title="$t('statsG.EpTomato.actTip')" @click.stop="openAccount" @keydown.enter.prevent.stop="openAccount">{{ $t('statsG.EpTomato.act') }} <b>{{ tomatoActual }}</b></span>
        </span>
      </div>

      <!-- Whole row clickable to summon the calendar (user-finalized: not just the right pill); the clear ✕ carries its own stop and is unaffected -->
      <div class="ep-row ep-deadline" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.setDeadline')"
           @click="openDeadlinePick" @keydown.enter.prevent="openDeadlinePick">
        <img class="ep-ico" src="app://app/assets/img/icon-clock.svg" style="opacity:.6">
        <span class="ep-remind-label" :class="{'ep-remind-label--active': !!(e&&e.deadlineTs)}">{{ e&&e.deadlineTs ? $t('statsJ.EditPanel.dueOn', { d: dayjs(e.deadlineTs).format(FMT.cnDate) }) : $t('statsJ.EditPanel.setDeadline') }}</span>
        <span class="ml-auto"></span>
        <!-- Right date pill demoted to a purely visual indicator (clicks land on the whole row); the hidden-selector calendar pop pattern is unchanged -->
        <span class="ep-deadline-pill"
              :class="{ 'ep-deadline-pill--set': !!(e&&e.deadlineTs) }">
          {{ e&&e.deadlineTs ? dayjs(e.deadlineTs).format('M/D') : $t('statsJ.EditPanel.pickDueDate') }}
        </span>
        <b v-if="e&&e.deadlineTs" class="ep-remind-clear close-x" role="button" tabindex="0" :title="$t('statsJ.EditPanel.clearDueDate')" :aria-label="$t('statsJ.EditPanel.clearDueDate')" @click.stop="fieldPatch('deadlineTs',0)"></b>
        <el-date-picker ref="deadlinePick" size="small" value-format="x" type="date"
                        style="width:0;height:0;border:0;padding:0;position:absolute;opacity:0" class="ep-deadline-pick"
                        :aria-label="$t('statsJ.EditPanel.setDeadline')" popper-class="ep-date-popper"
                        :model-value="e&&e.deadlineTs||null" @update:model-value="ts=>fieldPatch('deadlineTs', ts||0)"/>
      </div>

      <ep-attachments :img-list="imgList" :file-list="fileList"
                      @preview="previewImg=$event" @remove="removeFile"/>

      <div class="ep-flex"></div>

      <div class="ep-tools">
        <span class="ml-auto"></span>
        <span class="ep-tool danger" role="button" tabindex="0" :title="$t('statsJ.EditPanel.deleteBtn')" :aria-label="$t('statsJ.EditPanel.deleteTask')" @click="delTask" @keydown.enter.prevent="delTask">
          <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
        </span>
      </div>
    </div>

    <div v-if="previewImg" ref="previewMask" tabindex="-1" class="img-preview-mask" role="dialog" aria-modal="true" :aria-label="$t('statsJ.EditPanel.imagePreview')" @click.self="previewImg=null" @keydown.esc="previewImg=null">
      <img :src="previewImg"><button class="close-x" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click.stop="previewImg=null"></button>
    </div>
  </aside>
  </transition>
</template>

<script lang="ts">
/**
 * Right edit panel -- aligned with the right-sidebar reference:
 * Category chips / complete + expand / title / description / date chips (today, tomorrow, pick a date, no date) /
 * add reminder / subtasks (x, drag handle) / add subtask (n/20) / three difficulty levels / upload images / bottom tool row
 *
 * S4 split (2026-09-12): reminders/subtasks/attachments/dependencies views moved to
 * ./edit-panel/Ep*.vue -- children only EMIT change events; this component owns the
 * state (e/subList/imgList/fileList) and funnels every mutation through the unified
 * queueSave pipeline (utils/editSave.js). The save pipeline is the global lifeline:
 * it is the only place that dispatches todo/updateTodoFields for panel edits.
 */
import {dayjs, DAY_MS, FMT } from '../utils/core.js'
import { extractTags } from '../utils/search.js'
import { subsCompleteTarget, reportError } from '../utils/core.js'
import { deleteWithUndo, removeWithUndo } from '../utils/confirm.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { getEstimate, setEstimate } from '../utils/tomatoEstimate.js'
import { createSaveQueue } from '../utils/editSave.js'
import EpReminders from './edit-panel/EpReminders.vue'
import EpSubtasks from './edit-panel/EpSubtasks.vue'
import EpAttachments from './edit-panel/EpAttachments.vue'
import EpDependencies from './edit-panel/EpDependencies.vue'

const FIELD_MAP = {
  title: 'taskContent',
  desc: 'taskDescribe',
  categoryId: 'categoryId',
  priority: 'priority',
  deadlineTs: 'deadlineTs'
}
// Priority has two tiers (user-finalized): high/low; connected with the quadrant's important — high⇔important=1, low⇔important=0 (see fieldPatch)
const PRIOS = [{ v: 3, l: 'statsJ.EditPanel.priorityHigh' }, { v: 1, l: 'statsJ.EditPanel.prioLow' }]

// [component-fixes] pure-start (extracted verbatim by tests/component-fixes-a11y.test.mjs)
/** True when the attachment url is still referenced by the task row's image/files JSON.
 *  Malformed JSON counts as present (fail-safe: never delete a disk file on a parse error). */
function attachmentUrlPresent (row, url) {
  if (!row || !url) return false
  for (const k of ['image', 'files']) {
    try {
      const a = JSON.parse(row[k] || '[]')
      if (Array.isArray(a) && a.some(x => x && x.url === url)) return true
    } catch (e) { return true }
  }
  return false
}
// [component-fixes] pure-end

export default {
  name: 'EditPanel',
  components: { EpReminders, EpSubtasks, EpAttachments, EpDependencies },
  data () {
    return {
      e: null as any,
      saving: false,
      saveFailed: false,
      catOpen: false,
      tagInput: '',
      subList: [] as any,
      imgList: [] as any,
      fileList: [] as any,
      previewImg: null as any,
      repeatCount: 0,
      PRIOS
    }
  },
  created () {
    // Save pipeline (utils/editSave.js). boot() flips it live: the immediate watchers below
    // fire BEFORE created(), and pre-boot flush calls must stay silent no-ops
    // (same guard as the original `_dirtyFlags` initialization).
    this._save = createSaveQueue(this.$store, {
      getTaskId: () => this.e && this.e.taskId,
      // Dirty list-style fields are serialized lazily at drain time (callback-time values)
      dirtyPatchFor: (k) => ({
        subtasks: { subtasks: JSON.stringify(this.subList) },
        imgs: { image: JSON.stringify(this.imgList) },
        files: { files: JSON.stringify(this.fileList) },
        preds: { predecessors: this.e && this.e.predecessors }
      }[k]),
      onSaving: (v) => { this.saving = v },
      onDone: () => { this.saveFailed = false },
      onFail: () => { this.saveFailed = true }
    })
    this._save.boot()
  },
  computed: {
    task () { return this.$store.state.todo.todoList.find(t => t.taskId === (this.e && this.e.taskId)) || null },
    // Deps surface gate, same two-layer doctrine as the today deps view (TodayView seg button):
    // the developer-mode master switch AND the module's own switch must both be on
    devMode () { const s = this.$store.state.settings; return !!s.developerMode && !!s.showDepsModule },
    /* Pomodoro estimate/actual (ported from the refactor branch): the estimate is stored in tomatoEstimate, the actual is accumulated by attributing pomodoro records */
    tomatoEstimateN () { return getEstimate(this.e && this.e.taskId) },
    tomatoActual () {
      const id = this.e && this.e.taskId
      if (!id) return 0
      // The original predicate r.focus!==false was a copy-paste bug (focus is the task name, always truthy = abandoned ones were counted too); use the store lookup uniformly (abandoned excluded)
      return this.$store.getters['tomato/actualCountByTask'].get(id) || 0
    },
    // Recycle bin task: task cannot be found in the non-deleted list, so fall back to the recycle list to detect it (hide the "complete" row, show the restore banner)
    inRecycle () {
      if (!this.e || !this.e.taskId) return false
      if (this.task) return false
      return this.$store.state.todo.recycleList.some(t => t.taskId === this.e.taskId)
    },
    cats () { return this.$store.getters['category/sortedAll'] },
    curCat () { return this.cats.find(c => c.categoryId === (this.e && this.e.categoryId)) || null },
    // Tags = virtual derivation from #xxx in the content (a cross-cutting multi-select dimension); editing rewrites the hash tokens in the title text
    taskTags () { return this.e ? extractTags(this.e.title) : [] },
    autoSave () { return this.$store.state.settings.isTodoEditModalCloseAutoSave },
    isRepeat () { return !!(this.e && this.e.repeatId) },
    today0 () { return this.$store.state.todo.todayTimestamp },
    todayLabel () { return this.$t('statsJ.EditPanel.today') },
    tomorrowLabel () { return this.$t('statsJ.EditPanel.tomorrow') },
    dateChip () {
      if (!this.e) return ''
      if (!this.e.dateTs) return ''
      const d = dayjs(this.e.dateTs).startOf('day').valueOf()
      if (d === this.today0) return this.todayLabel
      if (d === this.today0 + DAY_MS) return this.tomorrowLabel
      return dayjs(this.e.dateTs).format(FMT.cnDate)
    }
  },
  watch: {
    previewImg (v) { if (v) this.$nextTick(() => { const el = this.$refs.previewMask; if (el) el.focus() }) },
    '$store.state.ui.rightSidebarTodoEdit.taskId': { immediate: true, handler () { this.hydrate() } },
    '$store.state.ui.rightSidebarTodoEdit.visible': {
      immediate: true,
      handler (v) {
        if (v) {
          this.hydrate()
          this.$nextTick(() => {
            const t = this.$el && this.$el.querySelector('.ep-title textarea')
            if (t && document.activeElement && document.activeElement.tagName === 'BODY') t.focus()
          })
        }
      }
    },
    // The task was fully deleted by another window/sync/auto-cleanup (in neither the active nor the recycle list): close the panel automatically.
    // Otherwise it becomes a "zombie editor" -- displaying the hydrated snapshot while all saves are silently lost (updateTodoFields is a no-op for a nonexistent id)
    task (t) {
      if (!t && !this.inRecycle && this.$store.state.ui.rightSidebarTodoEdit.visible) {
        this.$store.commit('ui/closeEdit')
      }
    }
  },
  mounted () {

    // First open of the edit panel: spotlight tour for the attachment toolbar (in-context teaching)
    this.$nextTick(() => { import('../utils/onboardingTours.js').then(mod => mod.maybeRunTour('editpanel', 600)).catch(() => {}) })
    // Esc closes the topmost overlay: image preview first, then the edit panel itself
    this._onKeydown = (e) => {
      if (e.key !== 'Escape') return
      if (this.previewImg) { this.previewImg = null; return }
      // When an upper modal (settings/recurring rule/feedback dialog) is open, Esc belongs to it; do not close the edit panel through the wall
      const ui = this.$store.state.ui
      if (ui.showSettingsModal || ui.showRepeatModalFor || ui.showFeedbackModal ||
          ui.showRepeatDeleteConfirm || ui.accountTaskId || ui.tomatoAbandonVisible || ui.tomatoFocusRecordVisible) return
      const st = this.$store.state.ui.rightSidebarTodoEdit
      if (st && st.visible) this.$store.commit('ui/closeEdit')
    }
    window.addEventListener('keydown', this._onKeydown)
    // Disable the browser's native spell check (English correction squiggles interfere with typing over Chinese content)
    this.$nextTick(() => {
      this.$el.querySelectorAll('textarea, input').forEach(el => el.setAttribute('spellcheck', 'false'))
    })
    // Inputs created dynamically later (subtasks etc.) get spell check disabled on focus too
    // Named handler: must be removed in beforeUnmount (listener accumulation when nodes are replaced after hydrate)
    this._onFocusin = e => {
      const t = e.target
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.hasAttribute('spellcheck')) t.setAttribute('spellcheck', 'false')
    }
    this.$el.addEventListener('focusin', this._onFocusin)
    // The hidden date picker input stays out of the Tab focus chain (invoked programmatically only by the "pick a date" chip)
    this.$nextTick(() => {
      // Under Element Plus, $refs.datePick.$el may be a comment/text node (no querySelector); defensively type-check
      const pickEl = this.$refs.datePick && this.$refs.datePick.$el
      const inp = pickEl && typeof pickEl.querySelector === 'function' ? pickEl.querySelector('input') : (pickEl && pickEl.parentElement ? pickEl.parentElement.querySelector('input') : null)
      if (inp) inp.setAttribute('tabindex', '-1')
    })
  },
  beforeUnmount () {
    window.removeEventListener('keydown', this._onKeydown)
    if (this.$el && this._onFocusin) this.$el.removeEventListener('focusin', this._onFocusin)
    // Esc 关闭路径不经 close():防抖回调会在卸载后写 this.saving,_sortable 也不会 destroy(2026-09-05 终审 P2)
    try { this.flushSave() } catch (e) { /* 卸载期落库失败不阻断卸载 */ }
    if (this._sortable) { try { this._sortable.destroy() } catch (err) { /* already destroyed */ } this._sortable = null }
  },
  methods: {
    /* ===== Save pipeline wrappers (implementation: utils/editSave.js) ===== */
    queueSave (patch) { if (this._save) this._save.queueSave(patch) },
    /** Immediately commit pending saves (must be called before switching tasks, so A's edits do not land on B) */
    flushSave () { if (this._save) this._save.flushSave() },
    markDirty (k) { if (this._save) this._save.markDirty(k) },
    /** Subtask drag sorting (sortablejs library; Up/Down buttons kept as a keyboard-accessible fallback).
        The panel body is under v-if="e", so the nodes do not exist at mounted time -- called after hydrate; old instances become invalid when nodes are replaced, destroy before rebuilding */
    initSubSortable () {
      if (this._sortable) { try { this._sortable.destroy() } catch (err) { /* already destroyed with the node */ } this._sortable = null }
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('.ep-subs')
        if (!el || !window.Sortable) return
        this._sortable = window.Sortable.create(el, {
          handle: '.ep-sub-drag',
          animation: 150,
          onEnd: (evt) => {
            const { oldIndex, newIndex } = evt
            if (oldIndex === newIndex || oldIndex == null || newIndex == null) return
            const item = this.subList.splice(oldIndex, 1)[0]
            this.subList.splice(newIndex, 0, item)
            this.markDirty('subtasks')
            this.queueSave({})
          }
        })
      })
    },
    hydrate () {
      const s = this.$store.state.ui.rightSidebarTodoEdit
      if (!s.visible || !s.taskId) return
      this.flushSave()
      this.subList = JSON.parse(JSON.stringify(s.sublist))
      this.imgList = JSON.parse(JSON.stringify(s.todoImageList))
      this.fileList = JSON.parse(JSON.stringify(s.fileList))
      this.e = JSON.parse(JSON.stringify(s))
      this.repeatGroupInfo()
      this.initSubSortable()
    },
    async repeatGroupInfo () {
      if (!this.e || !this.e.repeatId) { this.repeatCount = 0; return }
      try {
        const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId: this.e.repeatId })
        this.repeatCount = rows.length
      } catch (err) { /* ignored */ }
    },
    close () {
      if (!this.autoSave) this.queueSave({})
      this.$store.commit('ui/closeEdit')
    },
    // Collapse is not close: the edit state is kept, collapsing into a thin strip on the right edge that can be expanded again
    collapse () {
      if (!this.autoSave) this.queueSave({})
      this.$store.commit('ui/collapseEdit')
    },
    fieldPatch (key, val) {
      this.e[key] = val
      const patch: any = {}
      patch[FIELD_MAP[key]] = val
      // Connect the ledgers (user-finalized): priority high⇔important quadrant, low/none⇔non-important — the quadrant and the list share a single importance ledger
      if (key === 'priority') {
        const imp = val === 3 ? 1 : 0
        this.e.important = imp
        patch.important = imp
      }
      this.queueSave(patch)
    },
    setDate (mode) {
      if (mode === 'today') this.applyDate(this.today0)
      else if (mode === 'tomorrow') this.applyDate(this.today0 + DAY_MS)
      else if (mode === 'none') this.applyDate(0)
      else if (mode === 'pick') {
        // focus() invokes the calendar panel (simulating a click on the 0-size hidden input is flaky), plus one extra click as a fallback
        const p = this.$refs.datePick
        if (!p) return
        if (p.focus) p.focus()
        const inp = p.$el && p.$el.querySelector('input')
        if (inp) inp.click()
      }
    },
    /* Due-date pill → pop the calendar panel with a hidden selector (same proven path as setDate('pick')) */
    openDeadlinePick () {
      const p = this.$refs.deadlinePick
      if (!p) return
      if (p.focus) p.focus()
      // $el may be a comment/text node (no querySelector); defensively take the parent element's input — same pitfall as mounted's datePick
      const el = p.$el
      const inp = el && typeof el.querySelector === 'function' ? el.querySelector('input') : (el && el.parentElement ? el.parentElement.querySelector('input') : null)
      if (inp) inp.click()
    },
    applyDate (ts) {
      const oldDay = this.e.dateTs ? dayjs(this.e.dateTs).startOf('day') : null
      let remind = this.e.remindTs
      if (this.e.remindTs && ts) {
        const t = dayjs(this.e.remindTs)
        remind = dayjs(ts).hour(t.hour()).minute(t.minute()).valueOf()
      } else if (!ts) remind = 0
      // Multiple reminders: extra absolute reminders shift by the same number of days when the date changes (keeping their own time of day), otherwise they would all become past dates after a date change
      const extras = Array.isArray(this.e.reminderExtra) ? this.e.reminderExtra : []
      let next = extras
      if (extras.length && ts && oldDay) {
        const shift = dayjs(ts).startOf('day').diff(oldDay, 'day')
        if (shift) next = extras.map(x => dayjs(x).add(shift, 'day').valueOf())
      }
      this.e.dateTs = ts || 0
      this.e.remindTs = remind
      this.e.reminderExtra = next
      this.queueSave({ todoTime: ts || 0, reminderTime: remind, reminderExtra: next })
    },
    onPickDate (ts) { this.applyDate(ts || 0) },
    /* ===== Reminders: EpReminders emits; the task snapshot + persistence stay here ===== */
    onRemindersCommit (mainTs, extras) {
      if (!this.e) return
      const mainChanged = mainTs !== this.e.remindTs
      this.e.remindTs = mainTs
      this.e.reminderExtra = extras
      if (mainChanged && mainTs < Date.now()) this.$message.warning(this.$t('statsJ.EditPanel.reminderPastTip'))
      if (!this.e.dateTs) this.e.dateTs = dayjs(mainTs).startOf('day').valueOf()
      this.queueSave({ reminderTime: this.e.remindTs, reminderExtra: this.e.reminderExtra, todoTime: this.e.dateTs })
    },
    onRemindersClear () {
      if (!this.e) return
      this.e.remindTs = 0
      this.e.reminderExtra = []
      this.e.reminderOffsets = [] // offsets are anchored to the main reminder; clearing the main reminder must clear them too, otherwise stale offsets silently revive when reminders are re-set
      this.queueSave({ reminderTime: 0, reminderExtra: [], reminderOffsets: [] })
    },
    onRemindersOffsets (sorted) {
      if (!this.e) return
      this.e.reminderOffsets = sorted
      this.queueSave({ reminderOffsets: sorted })
    },
    toggleComplete () {
      // Same feedback semantics as checking in the list: completing shows a "completed + undo" toast, un-completing is only announced
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: this.task, announce: this.$announce })
        .then(() => this.hydrate())
    },
    /** Restore the currently edited task from the recycle bin (keeping the edited fields); after restore the banner disappears and the complete row returns */
    async restoreFromBin () {
      if (!this.e || !this.e.taskId) return
      // queueSave is a 350ms debounce timer (returns no promise); before restoring, synchronously flush unsaved dirty fields and clear the timer to prevent double writes
      this._save.clearTimer()
      const all: any = this._save.takeDirty(['subtasks', 'imgs', 'files'])
      all.delete = false
      all.status = 'update'
      await this.$store.dispatch('todo/updateTodoFields', { taskId: this.e.taskId, patch: all })
      this.$message.success(this.$t('statsJ.EditPanel.restoredMsg'))
      this.hydrate()
    },
    /* ===== Subtasks: EpSubtasks emits; subList + the toggle-complete linkage stay here ===== */
    addSub (text) {
      if (!text || !this.e) return
      this.subList.push({ text, checked: false })
      this.markDirty('subtasks'); this.queueSave({})
    },
    toggleSub (s) {
      s.checked = !s.checked; this.markDirty('subtasks'); this.queueSave({})
      // Subtask <-> parent linkage (consistent with the list page's TodoItem behavior)
      if (this.task) {
        const target = subsCompleteTarget(this.subList, this.task.complete)
        if (target !== null) this.toggleComplete()
      }
    },
    delSub (i) {
      const sub = this.subList[i]
      removeWithUndo(this,
        () => { this.subList.splice(i, 1); this.markDirty('subtasks'); this.queueSave({}) },
        () => { this.subList.splice(i, 0, sub); this.markDirty('subtasks'); this.queueSave({}) })
    },
    moveSub (i, dir) {
      const j = i + dir
      if (j < 0 || j >= this.subList.length) return
      const tmp = this.subList[i]; this.subList[i] = this.subList[j]; this.subList[j] = tmp
      this.markDirty('subtasks'); this.queueSave({})
    },
    /* Actual = total of this task's focus records; click = open the ledger detail (add/remove/modify entries, totals reconcile automatically) */
    openAccount () {
      if (this.task) this.$store.commit('ui/openTaskAccount', this.task.taskId)
    },
    pickFiles (kind) {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      if (kind === 'img') input.accept = 'image/*'
      input.onchange = () => { for (const f of input.files) this.uploadOne(kind, f) }
      input.click()
    },
    async onDescPaste (e) {
      const items = e.clipboardData ? e.clipboardData.items : []
      // The same clipboard image often carries multiple format entries (png/jpeg/bmp coexist); accepting all would upload duplicate image tiles; take only the first usable bitmap, png preferred
      const imgItems = items.filter(i => i.type.startsWith('image/'))
      if (!imgItems.length) return
      e.preventDefault()
      const pick = imgItems.find(i => i.type === 'image/png') || imgItems[0]
      const f = pick.getAsFile()
      if (f) await this.uploadOne('img', new File([f], f.name || 'clipboard.' + (pick.type.split('/')[1] || 'png'), { type: pick.type }))
      this.scrollImgsIntoView()
    },
    /* After paste/drop, scroll thumbnails into view for immediate "it landed" feedback */
    scrollImgsIntoView () {
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('.ep-imgs')
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    },
    async onDescDrop (e) {
      const files = e.dataTransfer ? e.dataTransfer.files : []
      for (const f of files) {
        if (f.type.startsWith('image/')) {
          await this.uploadOne('img', f)
          this.scrollImgsIntoView()
        }
      }
    },
    async uploadOne (kind, f) {
      try {
        await this._uploadOne(kind, f)
      } catch (err) { reportError('upload:' + f.name, err); this.$message.error(this.$t('statsJ.EditPanel.uploadFailedMsg') + f.name) }
    },
    async _uploadOne (kind, f) {
      const buf = new Uint8Array(await f.arrayBuffer())
      let binary = ''
      for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      const res = await window.todoAPI.uploadAttachment({ taskId: this.e.taskId, name: f.name, dataBase64: btoa(binary), type: f.type })
      const item = { url: res.url, name: f.name, size: res.size }
      if (kind === 'img') { this.imgList.push(item); this.markDirty('imgs') } else { this.fileList.push(item); this.markDirty('files') }
      this.queueSave({})
    },
    removeFile (arrName, idx) {
      const item = this[arrName][idx]
      if (!item) return
      let diskTimer = null
      removeWithUndo(this,
        () => {
          this[arrName].splice(idx, 1)
          this.markDirty(arrName === 'imgList' ? 'imgs' : 'files')
          this.queueSave({})
          // Delay disk file deletion until after the undo window: an accidental delete can be reverted losslessly within 5 seconds
          diskTimer = setTimeout(() => {
            if (!item.url) return
            // Data-safety guard: re-check the latest task row in the store before touching the disk.
            // If the JSON update never landed (save failed / panel unmounted mid-write), the row still
            // references the url — deleting the file then would corrupt the task's attachments.
            const row = this.$store.state.todo.todoList.find(t => t.taskId === (this.e && this.e.taskId))
            if (attachmentUrlPresent(row, item.url)) return
            // .catch: delete-file now surfaces structured errors instead of swallowing them (2026-09-11);
            // this call is a fire-and-forget sweep — a failure must not become an unhandled rejection
            window.todoAPI.deleteFile(item.url).catch(() => {})
          }, 5500)
        },
        () => {
          clearTimeout(diskTimer)
          this[arrName].splice(idx, 0, item)
          this.markDirty(arrName === 'imgList' ? 'imgs' : 'files')
          this.queueSave({})
        })
    },
    delTask () {
      // Recurring tasks share the context-menu semantics: ask the scope first (this instance only / the whole series)
      if (this.isRepeat && this.task) return this.askRepeatDelete()
      // Same semantics as the list/todo box/quadrant matrix: no confirmation dialog, 5s undo toast after delete (consistency consolidated 2026-08-31)
      deleteWithUndo(this, this.$store, this.task).then(ok => { if (ok) this.close() }).catch(() => {})
    },
    askRepeatEdit () { this.$store.commit('ui/askRepeatEdit', this.e.taskId) },
    askRepeatDelete () { this.$store.commit('ui/askRepeatDelete', this.e.taskId) },
    estDelta (d) { setEstimate(this.e && this.e.taskId, getEstimate(this.e && this.e.taskId) + d) },
    chipCat (c) { this.fieldPatch('categoryId', c.categoryId) }, // reserved: category quick chips
    pickCat (id) { this.fieldPatch('categoryId', id); this.catOpen = false },
    /* ===== Dependencies: EpDependencies emits the merged predecessors JSON; persistence stays here ===== */
    patchPreds (predecessorsJson) {
      this.e.predecessors = predecessorsJson
      this.markDirty('preds'); this.queueSave({})
    },
    tt (k) { const s = String(k || ''); return (s.startsWith('statsE.') || s.startsWith('statsJ.')) ? this.$t(s) : s },
    addTag () {
      const name = (this.tagInput || '').trim().replace(/^#+/, '')
      this.tagInput = ''
      if (!name || this.taskTags.includes(name)) return
      const base = (this.e.title || '').replace(/\s+$/, '')
      this.fieldPatch('title', base + ' #' + name)
    },
    removeTag (name) {
      const prevTitle = this.e.title || ''
      removeWithUndo(this,
        () => {
          const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp('\\s*#' + esc + '(?=[\\s#,，。.!?！？]|$)')
          this.fieldPatch('title', prevTitle.replace(re, ''))
        },
        () => this.fieldPatch('title', prevTitle))
    }
  },

}
</script>
<style>
.ep-inner { flex: 1; display: flex; flex-direction: column; padding: var(--space-4) var(--space-5) 14px; overflow-y: auto; }
/* 字段小图标统一 16px 列宽居中，与下方 .ep-row 的 16px 图标（x=+2）纵向对齐 */
.ep-cats .ep-field-label { width: 16px; justify-content: center; flex-shrink: 0; }
.ep-field-label { font-size: var(--fs-sm); color: var(--text-3); flex-shrink: 0; }
/* 编辑栏收起按钮（2026-08-28 定稿移到标题行右侧）：chevron 指向收起方向 */
/* 自动保存中指示（编辑面板标题行） */
.ep-saving { flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-3); margin-right: 6px; }
/* 保存失败横幅 */
.ep-save-failed { flex-shrink: 0; margin: 0 0 8px; padding: 6px 12px; font-size: var(--fs-sm);
  color: var(--danger); background: rgba(245, 108, 108, .1); border: 1px solid rgba(245, 108, 108, .35); border-radius: var(--radius-md); }
.ep-collapse-btn {
  flex-shrink: 0; width: 24px; height: 24px; margin-top: var(--space-2); margin-left: var(--space-1);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--text-3); border-radius: var(--radius-md);
}
.ep-collapse-btn svg { width: 14px; height: 14px; }
.ep-collapse-btn:hover { color: var(--brand); background: var(--hover-bg); }
.ep-inner { padding-right: var(--space-5); }
/* 「完成」行：与分类/标签行同款图标列对齐，右侧圆圈勾选呼应子任务勾选样式 */
.ep-done-row .ep-done-label { font-size: var(--fs-md); color: var(--text-2); }
.ep-done-row .ep-field-label { color: var(--text-3); }
/* 回收站任务编辑横幅：黄底提示 + 恢复按钮（完成行在该态隐藏） */
.ep-recycle-banner {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 8px 12px; margin-bottom: 10px;
  border-radius: var(--radius-md); font-size: var(--fs-sm); color: #8a6116;
  background: #fdf6ec; border: 1px solid #f5dab1;
}
.ep-recycle-banner img { width: 14px; height: 14px; opacity: .7; flex-shrink: 0; }
.ep-recycle-banner .mini { margin-left: auto; flex-shrink: 0; }
/* 编辑栏收起后的展开钮：在页头右缘（原右缘 28px 细条 ep-rail 已废除，2026-08-30 用户定稿顶栏面板开关范式） */
.ep-expand { cursor: pointer; }
/* hover/active 用品牌色（style-3 像素补丁已在 2026-09 组件吸收重构中退役） */
.ep-chip {
  padding: 4px 12px; border-radius: var(--radius-xl); background: var(--gray-bg); font-size: var(--fs-sm);
  color: var(--text-2); cursor: pointer; transition: all var(--dur-fast);
}
.ep-chip:hover { color: var(--brand); }
.ep-chip.on { background: var(--brand); color: #fff; }
.ep-done-chk { margin-left: auto; }
.ep-done-chk .el-checkbox__input.is-checked .el-checkbox__inner,
.ep-done-chk .el-checkbox__inner { border-radius: 50%; }
/* ---- 分类/标签行式控件（2026-08-28 重构：弃 el-select 方框，统一"图标+文字+箭头"行语言） ---- */
.ep-field-ico { width: 16px; justify-content: center; }
.ep-cat-wrap { position: relative; }
.ep-cat-row .ep-cat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ep-cat-row .ep-cat-name { font-size: var(--fs-md); color: var(--text-2); }
.ep-cat-row .ep-cat-name.is-placeholder { color: var(--text-3); }
.ep-row-arrow { color: var(--text-3); font-size: var(--fs-xs); transition: transform var(--dur-fast); padding-right: 2px; }
.ep-row-arrow.on { transform: rotate(180deg); }
.ep-cat-pop {
  position: absolute; top: 100%; left: 2px; right: 2px; z-index: calc(var(--z-pop) + 20); margin-top: var(--space-1);
  background: var(--panel, #fff); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  padding: 6px; max-height: 220px; overflow-y: auto;
}
.ep-cat-opt {
  display: flex; align-items: center; gap: var(--space-2); height: 32px; padding: 0 8px;
  border-radius: var(--radius-md); font-size: var(--fs-md); color: var(--text-1); cursor: pointer;
}
.ep-cat-opt:hover { background: var(--gray-bg); }
.ep-cat-opt.on { color: var(--brand); font-weight: 600; }
.ep-cat-opt .ep-cat-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ep-hash { font-weight: 700; font-size: var(--fs-md); color: var(--text-3); }
.ep-tag-chip {
  display: inline-flex; align-items: center; gap: var(--space-1);
  background: var(--gray-bg); border-radius: var(--radius-lg); padding: 2px 9px;
  font-size: var(--fs-sm); color: var(--text-2);
}
.ep-tag-x { color: var(--text-3); cursor: pointer; font-size: var(--fs-xs); }
/* 行内小操作 hover 显现（删除交互统一规范）：误触面大的 chip 内 X 不常驻 */
.ep-tag-chip .ep-tag-x { opacity: 0; transition: opacity var(--dur-fast); }
.ep-tag-chip:hover .ep-tag-x, .ep-tag-chip:focus-within .ep-tag-x, .ep-tag-x:focus-visible { opacity: 1; }
.ep-tag-x:hover { color: var(--danger); }
.ep-tag-input {
  flex: 1; min-width: 110px; border: 0; background: none; outline: none;
  font-size: var(--fs-md); color: var(--text-1); font-family: inherit;
}
.ep-tag-input::placeholder { color: #8a9099; }
.ep-title textarea { font-size: var(--fs-lg); font-weight: 600; color: var(--text-1); border: 0 !important; padding: 10px 0 2px !important; resize: none; }
/* Element Plus 输入框边框走 box-shadow + 自带圆角/背景，这里全部抹平回到 element-ui 时代的裸文本域观感 */
.ep-title .el-textarea__inner,
.ep-desc .el-textarea__inner {
  box-shadow: none !important;
  background: transparent !important;
  border-radius: 0 !important;
  font-family: inherit;
}
.ep-title .el-textarea__inner:focus,
.ep-desc .el-textarea__inner:focus { box-shadow: none !important; }
/* 编辑面板标题的 el-input wrapper 不画框（裸标题观感） */
.ep-title .el-input__wrapper {
  box-shadow: none !important;
  background: transparent !important;
  border-radius: 0 !important;
}
/* 标题 + 完成勾选同行：勾选固定右侧显著位置，标题占满剩余宽度 */
.ep-title-row { display: flex; align-items: flex-start; }
.ep-title-row .ep-title { flex: 1; min-width: 0; }
.ep-title-row .ep-done-chk { flex-shrink: 0; margin: 10px 0 0 8px; }
.ep-desc textarea { font-size: var(--fs-md); color: var(--text-2); border: 0 !important; padding: 4px 0 !important; resize: none; }
.ep-desc .el-textarea__inner { padding: 4px 0 !important; }
.ep-date-chip {
  display: inline-flex; align-items: center; gap: var(--space-1);
  padding: var(--space-1) 12px; border-radius: 15px; background: var(--gray-bg); font-size: var(--fs-sm);
  color: var(--text-2); cursor: pointer; position: relative; transition: all var(--dur-fast);
}
.ep-date-chip .app-icon { opacity: 1; color: var(--text-3); }
/* 未选中：灰色图标 */
.ep-date-chip:hover { color: var(--brand); }
.ep-date-chip:hover .app-icon { color: var(--brand); }
.ep-date-chip.on { background: var(--brand); color: #fff; }
.ep-date-chip.on .app-icon { color: #fff; }
/* 选中：白色图标 */
.ep-date-chip.on .app-icon { opacity: 1; }
.ep-field-label { color: var(--text-3); display: inline-flex; align-items: center; }
.ep-row {
  display: flex; align-items: center; gap: 10px; padding: 12px 2px;
  font-size: var(--fs-md); color: var(--text-2); cursor: pointer; border-bottom: 1px solid #f0f0f0;
}
.ep-row:hover { color: var(--brand); }
.ep-ico { width: 16px; height: 16px; opacity: .7; }
/* 子任务勾选圈样式留在父层：「完成」行的圆圈勾选复用同一外观（.ep-sub-check 双消费方） */
.ep-sub-check {
  width: 15px; height: 15px; border-radius: 50%; border: 1.5px solid var(--text-4); flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: var(--fs-2xs); cursor: pointer;
}
.ep-sub-check.on { background: var(--brand); border-color: var(--brand); }
.ep-diff { flex-wrap: wrap; }
.ep-diff-label { color: var(--text-2); }
.ep-diff-btns { display: flex; gap: 0; margin-left: auto; }
.ep-diff-btns button {
  padding: var(--space-1) 12px; font-size: var(--fs-sm); color: var(--text-2); background: var(--gray-bg);
  border-right: 1px solid #fff;
}
.ep-diff-btns button:first-child { border-radius: var(--radius-sm) 0 0 4px; }
/* 番茄账目行(2026-09-03用户定稿一体化):预期步进段+实际段同舱胶囊,两段等高同底,
   整舱选中高亮(边框品牌色+浅底);实际段可点开账目弹窗,有归账时数字品牌色 */
.ep-tom-account {
  margin-left: auto; display: inline-flex; align-items: stretch;
  border: 1px solid var(--line); border-radius: var(--radius-pill); background: var(--gray-bg);
  overflow: hidden; transition: border-color var(--dur-fast), background-color var(--dur-fast), box-shadow var(--dur-fast);
}
.ep-tom-account:hover, .ep-tom-account:focus-within {
  border-color: var(--brand); background: var(--brand-light); box-shadow: 0 0 0 2px var(--brand-light);
}
.ep-tom-seg { display: inline-flex; align-items: center; height: 26px; }
.ep-tom-seg--est { gap: 5px; padding: 0 4px 0 6px; }
.ep-tom-seg--act {
  gap: var(--space-1); padding: 0 12px; cursor: pointer; border-left: 1px solid var(--line);
  font-size: var(--fs-sm); color: var(--text-3); font-variant-numeric: tabular-nums;
  transition: background-color var(--dur-fast), color var(--dur-fast);
}
.ep-tom-seg--act:hover { background: var(--brand-light); color: var(--text-1); }
.ep-tom-seg--act:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.ep-tom-step {
  width: 22px; height: 22px; border: none; border-radius: var(--radius-sm); background: transparent;
  color: var(--text-1); font-size: var(--fs-md); line-height: 1; cursor: pointer; transition: background-color var(--dur-fast), color var(--dur-fast);
}
.ep-tom-step:hover { background: var(--panel, #fff); color: var(--brand); }
.ep-tom-num { display: inline-flex; align-items: center; min-width: 16px; justify-content: center; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text-1); }
/* 数字旁小番茄=单位标记(纯指示不可点):「预计 [− 3 + 🍅]」读作3个番茄;svg资产(内联currentColor方案在主题链上渲染发黑已弃) */
.ep-tom-ico { width: 13px; height: 13px; opacity: .6; }
.ep-tom-seg--act b { font-weight: 600; color: var(--text-2); }
.ep-tom-account.gain .ep-tom-seg--act b { color: var(--brand); }
.ep-diff-btns button:last-child { border-radius: 0 4px 4px 0; }
.ep-diff-btns button.on { background: var(--brand); color: #fff; }
.ep-flex { flex: 1; min-height: 20px; }
.ep-repeat { background: var(--brand-light); border-radius: var(--radius-md); padding: 8px 12px; font-size: var(--fs-sm); color: var(--brand); display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-2); }
.ep-mini { border: 1px solid var(--line); background: var(--panel, #fff); border-radius: var(--radius-sm); padding: 2px 8px; font-size: var(--fs-xs); }
.ep-mini.danger { color: var(--danger); }
.ep-tools {
  display: flex; align-items: center; gap: 18px; padding: 12px 2px 2px;
  border-top: 1px solid var(--line);
}
.ep-tool { cursor: pointer; font-size: 16px; opacity: .75; display: inline-flex; }
.ep-tool:hover { opacity: 1; }
.ep-tool img { width: 16px; height: 16px; }
.ep-tool.hash { font-weight: 700; }
.ep-tool.danger:hover { opacity: 1; }
.ep-tool.danger img { filter: invert(56%) sepia(87%) saturate(2449%) hue-rotate(318deg); }
.mini.danger:hover, .ep-mini.danger:hover, .danger-btn:hover { color: var(--danger-strong); border-color: var(--danger); }
/* danger-btn 并入同一 hover(双轨合一) */

/* —— 编辑面板 a11y 补丁：键盘焦点可见 / 伪可点击收敛 —— */
/* 隐藏清除/删除 ✕ 仅 hover 显现，键盘聚焦时必须可见（选择器横跨父子组件块，统一留父层——全局样式仍命中子组件 DOM） */
.ep-remind-clear:focus-visible, .ep-sub-x:focus-visible, .ep-sub-move i:focus-visible { opacity: 1; }
/* 键盘焦点环：行/chip/选项/工具统一品牌色描边 */
.ep-inner .ep-row:focus-visible, .ep-inner .ep-date-chip:focus-visible, .ep-inner .ep-cat-opt:focus-visible,
.ep-inner .ep-tool:focus-visible, .ep-inner .ep-tag-x:focus-visible, .ep-inner .ep-sub-x:focus-visible,
.ep-inner .ep-collapse-btn:focus-visible, .ep-inner .ep-remind-main:focus-visible {
  outline: 2px solid var(--brand); outline-offset: -2px; border-radius: var(--radius-sm);
}
/* 工作量行整行不可点：只有三档按钮可点 */
.ep-diff { cursor: default; }
.ep-diff:hover { color: inherit; }
.ep-diff-btns button { cursor: pointer; }
/* 提醒清除叉/提醒标签基础态：提醒行(EpReminders)、重复行、截止行三方共用，留父层 */
.ep-remind-clear {
  font-weight: 400; color: var(--text-4); cursor: pointer; font-size: var(--fs-md);
  padding: 0 4px; opacity: 0; transition: opacity var(--dur-mid);
}
.ep-remind-clear:hover { color: var(--text-3); }
/* 提醒行 hover 联动样式在 EpReminders.vue（.ep-remind 行本体随迁） */
.ep-remind-label { color: var(--text-3); transition: color var(--dur-mid); }
.ep-remind-label--active { color: var(--brand-dark); }
/* 截止日期右侧日期药丸：占位/已设日期，点击经隐藏选择器弹日历 */
.ep-deadline .ep-deadline-pill { flex-shrink: 0; cursor: pointer; font-size: var(--fs-sm); line-height: 1; padding: 4px 10px; border-radius: var(--radius-pill); color: var(--text-3); background: var(--panel, #fff); box-shadow: 0 0 0 1px var(--line, #e7e9ee) inset; font-variant-numeric: tabular-nums; }
.ep-deadline .ep-deadline-pill:hover { color: var(--brand); box-shadow: 0 0 0 1px var(--brand) inset; }
.ep-deadline .ep-deadline-pill--set { color: var(--brand); font-weight: 600; }
.ep-deadline .ep-deadline-pill:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
/* ===== ghost 占位范式:状态切换的按钮常驻等宽(visibility),消除行内宽度抖动(与日期条今天钮同源) ===== */
.btn-tomato.ghost, .pd-day-deck__tomato.ghost, .ep-saving.ghost { visibility: hidden; pointer-events: none; }
html[data-theme="dark"] .ep-title textarea, html[data-theme="dark"] .ep-desc textarea { color: var(--text-1) !important; }
html[data-theme="dark"] .ep-chip { background: var(--gray-bg); color: var(--text-2); }
html[data-theme="dark"] .ep-chip.on { background: var(--brand); color: #fff; }
html[data-theme="dark"] .ep-date-chip { background: var(--gray-bg); color: var(--text-2); }
html[data-theme="dark"] .ep-date-chip.on { background: var(--brand); color: #fff; }
html[data-theme="dark"] .ep-row { color: var(--text-2); border-bottom-color: var(--gray-bg); }
html[data-theme="dark"] .ep-recycle-banner { background: #2e2a1e; border-color: #4a3f24; color: #d8b36a; }
/* 编辑面板标题/描述：裸文本域观感（EP box-shadow 边框抹平，深色透出面板底色） */
html[data-theme="dark"] .ep-title .el-textarea__inner,
html[data-theme="dark"] .ep-desc .el-textarea__inner {
  background: transparent !important; box-shadow: none !important; border-radius: 0 !important;
}
html[data-theme="dark"] .ep-cat-pop { background: var(--gray-bg); }
html[data-theme="dark"] .ep-cat-opt:hover { background: var(--hover-bg); }
html[data-theme="dark"] .ep-diff-btns button { border-right-color: var(--panel); }
html[data-theme="dark"] .ep-mini { background: var(--gray-bg); border-color: var(--line-strong); color: var(--text-2); }
html[data-theme="dark"] .mini.danger:hover, html[data-theme="dark"] .ep-mini.danger:hover { color: #f3837a; border-color: #ef655a; }
/* 编辑面板小控件深色补漏（✕/拖拽柄的浅色硬编码 #767980 在暗底过暗；选择器横跨父子块，留父层且后于子块注入保证覆盖） */
html[data-theme="dark"] .ep-tag-x, html[data-theme="dark"] .ep-sub-x,
html[data-theme="dark"] .ep-sub-drag, html[data-theme="dark"] .ep-remind-clear { color: var(--text-3); }
html[data-theme="dark"] .ep-chip:hover, html[data-theme="dark"] .ep-date-chip:hover { background-color: var(--hover-bg); }
html[data-theme="dark"] .ep-chip:active, html[data-theme="dark"] .ep-date-chip:active { background-color: var(--line-strong); }
.row-btn:hover{color:var(--brand-hover)}
.row-btn:active{color:var(--brand-active)}
.row-btn.danger{color:var(--danger)}
.row-btn.danger:hover{color:var(--danger-strong)}
.ep-cats { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; padding-left: 2px; }
.ep-tags-row { flex-wrap: wrap; row-gap: var(--space-1); border-bottom: 1px solid #f0f0f0; }
.ep-date-chips { position: relative; display: flex; gap: 6px; flex-wrap: nowrap; margin: 10px 0 4px; }
/* —— 5. 右编辑栏：设计稿 .right-sidebar[scoped]{min-width:335px;border-left:#f3f3f3} —— */
/* 右侧编辑栏（right-sidebar）：布局+覆盖层模式合一(此前散在 SideNav 两处+此处三条,含一个 !important 对轰)
   覆盖层模式(设计稿行为:滑出覆盖内容,不推挤布局);收起把手以本面板为定位锚点 */
.edit-panel {
  position: fixed;
  right: 0; top: 25px; bottom: 0; z-index: var(--z-panel);
  width: var(--panel-w); min-width: 335px; flex-shrink: 0;
  background: var(--panel, #fff);
  border-left: 1px solid var(--line);
  display: flex; flex-direction: column;
  box-shadow: -6px 0 20px rgba(0,0,0,.08);
}
/* 「添加提醒」行：设计稿 .picker__text{color:#9b9b9b;font-size: var(--fs-md)}
   --active{color:var(--brand-dark)}

/* 过滤器：侧边栏空态 + 视图头条件摘要 */
.sn-filter-empty { font-size: var(--fs-xs); color: var(--text-3); /* text-4 不满足对比度(a11y axe color-contrast) */ padding: 4px 12px 6px 22px; }
/* 统一关闭钮:定位壳(尺寸保持 28px 命中区,加载序在 base 后故压过 .close-x 的 18px),
   叉形/hover(danger 高亮)/按压反馈全部来自统一 .close-x 体系——组件里必须写 class="modal__close close-x",
   此处不再自造 ::after 叉与自有 hover */
.modal__close {
  position: absolute; top: 12px; right: 12px;
  width: 28px; height: 28px; border: 0; padding: 0; appearance: none; -webkit-appearance: none; border-radius: var(--radius-md);
  background: transparent; cursor: pointer; z-index: var(--z-row);
}
/* 编辑面板内容滑入：选中待办后右栏内容 fade + 右侧 14px 滑入（ep-inner 为 v-if 挂载） */
.ep-inner { animation: ep-slide-in .2s cubic-bezier(.2, .8, .2, 1) both; }
/* 编辑面板字段行 hover 微高亮（原来只有文字变色，缺面感） */
.ep-row { border-radius: var(--radius-md); transition: background var(--dur-fast), color var(--dur-fast); }
.ep-row:hover { background: var(--hover-bg); }
/* 编辑面板分类下拉出现动画（v-if 挂载即播） */
.ep-cat-pop { animation: ep-cat-pop .15s cubic-bezier(.2, .8, .2, 1); transform-origin: top center; }
/* 编辑栏：优先级按钮（沿用工作量按钮风格，选中按级别着色） */
.ep-prio-btns button.on.prio-1 { background: #5aa9e6; border-color: #5aa9e6; color: #fff; }
.ep-prio-btns button.on.prio-2 { background: #f2a63b; border-color: #f2a63b; color: #fff; }
.ep-prio-btns button.on.prio-3 { background: var(--danger); border-color: var(--danger); color: #fff; }
/* 按钮体系 token 统一（btn-mini-tokens）：.mini / .ep-mini / .row-btn 共用圆角/边框/悬停变量 */
.mini, .ep-mini, .row-btn { transition: color var(--dur-fast), border-color var(--dur-fast), background-color var(--dur-fast); }
.ep-mini:hover { border-color: var(--btn-hover-brand); color: var(--btn-hover-brand); }
/* 设计稿注释尾(开头行在早年迁移中被误删,恢复语法平衡) */
.ep-chip, .ep-date-chip {
  padding: 4px 12px; color: var(--text-2); font-size: var(--fs-sm); line-height: 17px;
  background-color: var(--gray-bg); border-radius: var(--radius-pill); transition: all var(--dur-mid);
}
.ep-chip:hover, .ep-date-chip:hover { color: var(--text-2); background-color: var(--hover-bg); }
.ep-chip:active, .ep-date-chip:active { color: var(--text-2); background-color: var(--active-bg); }
.ep-chip.on, .ep-date-chip.on { color: #fff; background-color: var(--brand); }
.ep-chip.on:hover, .ep-date-chip.on:hover { color: #fff; background-color: var(--brand); }
.ep-chip.on:active, .ep-date-chip.on:active { color: #fff; background-color: var(--brand); }
/* 日期 chips 单行排布：收紧水平内边距、禁止换行，选中具体日期超长时截断 */
.ep-date-chips .ep-date-chip { padding: 4px 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes ep-slide-in { from { opacity: 0; transform: translateX(14px); } }
@keyframes ep-cat-pop { from { opacity: 0; transform: scaleY(.96) translateY(-3px); } }
@media (max-width: 1080px) {
  .edit-panel { position: absolute; right: 0; top: 0; bottom: 0; z-index: var(--z-panel); box-shadow: -8px 0 24px rgba(0,0,0,.08); }
}
</style>
