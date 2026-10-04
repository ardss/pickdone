<template>

  <transition name="slide-right" appear>
  <aside v-if="e" class="edit-panel" @click.stop>
    <div class="ep-inner">
        <div v-if="saveFailed" class="ep-save-failed" role="alert">{{ $t('statsJ.EditPanel.saveFailed') }}<span class="ep-save-retry" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.saveRetry')" @click="retrySave" @keydown.enter.prevent="retrySave">{{ $t('statsJ.EditPanel.saveRetry') }}</span></div>
        <!-- F3 (2026-09-20): a peer updated the open task while the panel holds UNSAVED user edits —
             never auto-overwrite user input; offer an explicit re-hydrate instead -->
        <div v-if="remoteStale" class="ep-remote-updated" role="status">
          <span>{{ $t('statsJ.EditPanel.remoteUpdated') }}</span>
          <span class="ep-remote-refresh" role="button" tabindex="0"
                :aria-label="$t('statsJ.EditPanel.remoteRefresh')"
                @click="refreshFromStore" @keydown.enter.prevent="refreshFromStore">{{ $t('statsJ.EditPanel.remoteRefresh') }}</span>
        </div>
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
        <div v-if="catOpen" v-click-outside="onCatOutside" class="ep-cat-pop" role="listbox">
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
        <ep-dependencies ref="depBlock" :task="e" @patch="patchPreds"/>
      </div>

      <ep-tags :tags="taskTags" @add="addTag" @remove="removeTag"/>

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

      <ep-reminders ref="remindBlock" :task="e" @commit="onRemindersCommit" @clear="onRemindersClear" @offsets="onRemindersOffsets"/>

      <div v-if="!inRecycle" class="ep-row ep-repeat-row" role="button" tabindex="0"
           :aria-label="isRepeat ? $t('statsJ.EditPanel.editRepeatRule') : $t('statsJ.EditPanel.setRepeat')"
           @click="askRepeatEdit" @keydown.enter.prevent="askRepeatEdit">
        <span class="ep-field-label ep-field-ico" :title="$t('statsE.TodoItem.repeatLabel')"><app-icon name="repeat" :size="13"/></span>
        <span class="ep-remind-label" :class="{'ep-remind-label--active': isRepeat}">{{ isRepeat ? $t('statsJ.EditPanel.repeatPrefix') + $t('statsJ.EditPanel.repeatN', { n: repeatCount == null ? '—' : repeatCount }) : $t('statsJ.EditPanel.setRepeat') }}</span>
        <span class="ml-auto"></span>
        <template v-if="isRepeat">
          <button class="ep-mini" @click.stop="askRepeatEdit">{{ $t('statsJ.EditPanel.ruleLabel') }}</button>
          <button class="ep-mini danger" @click.stop="askRepeatDelete">{{ $t('statsJ.EditPanel.deleteEllipsis') }}</button>
        </template>
      </div>

      <ep-subtasks :subs="subList" @add="addSub" @toggle="toggleSub" @remove="delSub" @move="moveSub" @rename="renameSub"/>

      <div class="ep-row ep-prio">
        <img class="ep-ico" src="app://app/assets/img/icon-tune.svg" style="opacity:.6">
        <span class="ep-diff-label">{{ $t('statsJ.EditPanel.priorityLabel') }}</span><span class="hint-q" role="img" :title="$t('statsJ.EditPanel.urgencyHint')" :aria-label="$t('statsJ.EditPanel.urgencyHint')">?</span>
        <span class="ep-diff-btns ep-prio-btns">
          <button v-for="pr in PRIOS" :key="pr.v" :class="['prio-'+pr.v, {on:((task&&task.priority)||0)===pr.v}]" @click="fieldPatch('priority', ((task&&task.priority)||0)===pr.v?0:pr.v)">{{ tt(pr.l) }}</button>
        </span>
      </div>
      <ep-tomato :estimate="tomatoEstimateN" :actual="tomatoActual" @est-delta="estDelta" @open="openAccount"/>

      <!-- Whole row clickable to summon the calendar (user-finalized: not just the right pill); the clear ✕ carries its own stop and is unaffected -->
      <div class="ep-row ep-deadline" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.setDeadline')"
           @click="openDeadlinePick" @keydown.enter.prevent="openDeadlinePick">
        <img class="ep-ico" src="app://app/assets/img/icon-clock.svg" style="opacity:.6">
        <span class="ep-remind-label" :class="{'ep-remind-label--active': !!(e&&e.deadlineTs)}">{{ e&&e.deadlineTs ? $t('statsJ.EditPanel.dueOn', { d: dayjs(e.deadlineTs).format(FMT.cnDate) }) : $t('statsJ.EditPanel.setDeadline') }}</span>
        <span class="ml-auto"></span>
        <!-- Right date pill demoted to a purely visual indicator (clicks land on the whole row); the hidden-selector calendar pop pattern is unchanged -->
        <span class="ep-deadline-pill"
              :class="{ 'ep-deadline-pill--set': !!(e&&e.deadlineTs) }">
          {{ e&&e.deadlineTs ? fmtMd(e.deadlineTs) : $t('statsJ.EditPanel.pickDueDate') }}
        </span>
        <!-- [D17-DOM4] ARIA button pattern on the deadline clear chip: Enter/Space both activate (had NO keydown at all) -->
        <b v-if="e&&e.deadlineTs" class="ep-remind-clear close-x" role="button" tabindex="0" :title="$t('statsJ.EditPanel.clearDueDate')" :aria-label="$t('statsJ.EditPanel.clearDueDate')" @click.stop="fieldPatch('deadlineTs',0)" @keydown="onDeadlineClearKey"></b>
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
        <!-- [maint-0925 A5] delete is a no-op on a recycle-state row and purge belongs to RecycleBinView — hide, same rule as the complete/repeat rows -->
        <span v-if="!inRecycle" class="ep-tool danger" role="button" tabindex="0" :title="$t('statsJ.EditPanel.deleteBtn')" :aria-label="$t('statsJ.EditPanel.deleteTask')" @click="delTask" @keydown.enter.prevent="delTask">
          <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
        </span>
      </div>
    </div>

    <div v-if="previewImg" ref="previewMask" tabindex="-1" class="img-preview-mask" role="dialog" aria-modal="true" :aria-label="$t('statsJ.EditPanel.imagePreview')" @click.self="previewImg=null" @keydown.esc="previewImg=null" @keydown.tab.prevent="$refs.previewMask.focus()">
      <!-- sec-synced-remote-img-beacon: previewImg is only minted from EpAttachments' gated 'preview'
           emit (local:// only) — the isRenderableAttachmentUrl check here is defensive so a stale or
           hostile value can never bind :src and turn the preview mask into a beacon. -->
      <img v-if="isRenderableAttachmentUrl(previewImg)" :src="previewImg">
      <span v-else role="img" :aria-label="previewImg"></span><button class="close-x" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click.stop="previewImg=null"></button>
    </div>
  </aside>
  </transition>
</template>

<script lang="ts">
/**
 * Right edit panel -- aligned with the right-sidebar reference: Category chips / complete + expand / title / description / date chips (today, tomorrow, pick a date, no date) / add reminder / subtasks (x, drag handle) / add subtask (n/20) / three difficulty levels / upload images / bottom tool row S4 split (2026-09-12): reminders/subtasks/attachments/dependencies views moved to ./edit-panel/Ep*.vue -- children only EMIT change events; this component owns the state (e/subList/imgList/fileList) and funnels every mutation through the unified queueSave pipeline (utils/editSave.js). The save pipeline is the global lifeline: it is the only place that dispatches todo/updateTodoFields for panel edits.
 */
import {dayjs, FMT, reportError } from '../utils/core.js'
import { dayShift } from '../utils/todayBounds.js'
import { getLocale } from '../i18n/index.js'
import { extractTags } from '../utils/search.js'
import { subsCompleteTarget, isRenderableAttachmentUrl } from '../utils/core.js'
import { deleteWithUndo, removeWithUndo } from '../utils/confirm.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { getEstimate, setEstimate, ensureEstimate } from '../utils/tomatoEstimate.js'
import { createSaveQueue } from '../utils/editSave.js'
import { attachmentUrlPresent } from '../utils/attachmentRefs.js'
import { contentFingerprint, shouldRefreshRemote, taskAbsentIn } from '../utils/editPanelRemoteSync.js'
import { buildEditSnapshot } from '../store/ui.js'
import { findTaskRowEl } from '../utils/todoRowEl.js'
import { $elOf } from '../utils/el.js'
import { roleButtonActivate } from '../utils/roleButtonKey.js' // [A9] Space+Enter button activation
import EpReminders from './edit-panel/EpReminders.vue'
import EpSubtasks from './edit-panel/EpSubtasks.vue'
import EpAttachments from './edit-panel/EpAttachments.vue'
import EpDependencies from './edit-panel/EpDependencies.vue'
import EpTomato from './edit-panel/EpTomato.vue'
import EpTags from './edit-panel/EpTags.vue'
import * as attachments from './edit-panel/attachments.js'
import * as repeat from './edit-panel/repeat.js'
import { catOutsideClose, FIELD_MAP } from './edit-panel/interactions.js'


// Priority has two tiers (user-finalized): high/low; connected with the quadrant's important — high⇔important=1, low⇔important=0 (see fieldPatch)
const PRIOS = [{ v: 3, l: 'statsJ.EditPanel.priorityHigh' }, { v: 1, l: 'statsJ.EditPanel.prioLow' }]

// [component-fixes] pure helper now lives in utils/attachmentRefs.js (imported below)

export default {
  name: 'EditPanel',
  components: { EpReminders, EpSubtasks, EpAttachments, EpDependencies, EpTomato, EpTags },
  data () {
    return {
      e: null as any,
      saving: false,
      saveFailed: false,
      catOpen: false,
      subList: [] as any,
      imgList: [] as any,
      fileList: [] as any,
      previewImg: null as any,
      repeatCount: 0,
      remoteStale: false,
      PRIOS
    }
  },
  created () {
    // Save pipeline (utils/editSave.js). boot() flips it live: the immediate watchers below fire BEFORE created(), and pre-boot flush calls must stay silent no-ops (same guard as the original `_dirtyFlags` initialization).
    this._save = createSaveQueue(this.$store, {
      getTaskId: () => this.e && this.e.taskId,
      // Dirty list-style fields are serialized lazily at drain time (callback-time values). Subtask rows carry a render-only `_key` (stable v-for key) — stripped here so it never leaks into the persisted subtasks JSON.
      dirtyPatchFor: (k) => ({
        subtasks: { subtasks: JSON.stringify(this.subList.map(({ _key, ...rest }) => rest)) },
        imgs: { image: JSON.stringify(this.imgList) },
        files: { files: JSON.stringify(this.fileList) },
        preds: { predecessors: this.e && this.e.predecessors }
      }[k]),
      onSaving: (v) => { this.saving = v },
      onDone: () => { this.saveFailed = false },
      onFail: () => { this.saveFailed = true }
    })
    this._save.boot()
    // Auto-increment sequence for stable subtask row keys (render-only, stripped at save time)
    this._subKeySeq = 0
  },
  computed: {
    task () { return this.$store.state.todo.todoList.find(t => t.taskId === (this.e && this.e.taskId)) || null },
    // Deps surface gate, same two-layer doctrine as the today deps view (TodayView seg button): the developer-mode master switch AND the module's own switch must both be on
    devMode () { const s = this.$store.state.settings; return !!s.developerMode && !!s.showDepsModule },
    /* Pomodoro estimate/actual (ported from the refactor branch): the estimate is stored in tomatoEstimate, the actual is accumulated by attributing pomodoro records */
    /* U8: lazy read-through (see TodoItem.tomatoEstimateN) — memoized per-id getMeta on first open. */
    tomatoEstimateN () { ensureEstimate(this.e && this.e.taskId); return getEstimate(this.e && this.e.taskId) },
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
      if (d === dayShift(this.today0, 1)) return this.tomorrowLabel
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
            // F-D5 (maint/dw 2026-09-23): opening via keyboard (Enter on a .td-item row) leaves
            // activeElement on the row — the BODY-only guard skipped focusing and keyboard/screen-
            // reader users got no "panel is open" feedback. Also take focus when activation came
            // from inside a todo row; plain mouse focus elsewhere is left untouched.
            const ae = document.activeElement
            const fromRow = !!ae && !!ae.closest && !!ae.closest('.td-item')
            if (t && (!ae || ae.tagName === 'BODY' || fromRow)) t.focus()
          })
        } else {
          // hydrate dedup (2026-09-25): forget the last hydration key on close so reopening the
          // SAME task re-hydrates from a fresh snapshot instead of being deduped into a no-op
          this._hydKey = null
        }
      }
    },
    // The task was fully deleted by another window/sync/auto-cleanup (in neither the active nor the recycle list): close the panel automatically. Otherwise it becomes a "zombie editor" -- displaying the hydrated snapshot while all saves are silently lost (updateTodoFields is a no-op for a nonexistent id)
    task (t) {
      // P1 (2026-10-01): a full reload (todosChanged → todo/init#setAllRows) transiently
      // evaluates `task` to null while the row array is swapped; the old immediate closeEdit
      // turned every edit made in that window (say, picking a deadline) into "task deleted by
      // another window" — panel slammed shut, picked value silently lost. Verify absence in the
      // post-reload lists instead of trusting the transient; a reappearing row cancels the close.
      if (t && this._closeVerifyTimer) { clearTimeout(this._closeVerifyTimer); this._closeVerifyTimer = null }
      if (!t && !this.inRecycle && this.$store.state.ui.rightSidebarTodoEdit.visible) {
        if (this._closeVerifyTimer) clearTimeout(this._closeVerifyTimer)
        this._closeVerifyTimer = setTimeout(() => {
          this._closeVerifyTimer = null
          const st = this.$store.state.ui.rightSidebarTodoEdit
          if (!st.visible || !this.e || st.taskId !== this.e.taskId) return
          if (!taskAbsentIn(this.$store.state.todo, this.e.taskId)) return // reload landed: row is back
          this.$store.commit('ui/closeEdit')
        }, 500)
      }
      // F3 (2026-09-20): inbound sync/CLI changed the open task while the panel is open. Without
      // this the next autosave clobbers the peer edit with the stale open-time snapshot.
      this.checkRemoteUpdate(t)
      // Y8 (sync-coverage-2): the repeat-group count stales while the panel is open — an inbound
      // round touching sibling instances changes the store row without re-hydration; piggyback the
      // existing remote-update watcher (throttled).
      if (t && this.e && this.isRepeat && t.repeatId === this.e.repeatId) {
        const now = Date.now()
        if (!this._rgRefreshAt || now - this._rgRefreshAt > 1500) {
          this._rgRefreshAt = now
          this.repeatGroupInfo()
        }
      }
    }
  },
  mounted () {

    // Review P2 (2026-09-22): expose the save queue's flush to the ui store — closeEditCleanup's
    // inline-create orphan cleanup awaits it instead of racing the 350ms debounce with a fixed sleep
    this._flushHook = () => this.flushSave()
    window.__editPanelFlushSave = this._flushHook
    // First open of the edit panel: spotlight tour for the attachment toolbar (in-context teaching)
    this.$nextTick(() => { import('../utils/onboardingTours.js').then(mod => mod.maybeRunTour('editpanel', 600)).catch(() => {}) })
    this._onKeydown = (e) => {
      if (e.key !== 'Escape') return
      if (this.catOpen) { this.catOpen = false; return }
      const rem = this.$refs.remindBlock
      if (rem && rem.remindOpen) { rem.remindOpen = false; return }
      const dep = this.$refs.depBlock
      if (dep && dep.depOpen) { dep.depOpen = false; return }
      if (this.previewImg) { this.previewImg = null; return }
      const ui = this.$store.state.ui
      // [editpanel-esc-ignores-context-menu fix] an open task context menu owns the Esc press
      // (it closes the menu); the edit sidebar behind it must not also close. Same whitelist
      // shape as the other overlays below.
      if (ui.contextMenu && ui.contextMenu.visible) return
      // [maint-0925 A2] showFilterModal joins the whitelist (hoisted out of FilterView local data): Esc over the filter modal no longer closes the edit sidebar
      if (ui.showSettingsModal || ui.showRepeatModalFor || ui.showFeedbackModal || ui.showFilterModal || ui.showRepeatDeleteConfirm || ui.accountTaskId || ui.tomatoAbandonVisible || ui.tomatoFocusRecordVisible || ui.tomatoRecordAddVisible) return
      const st = this.$store.state.ui.rightSidebarTodoEdit
      if (st && st.visible) {
        this.$store.dispatch('ui/closeEditCleanup') // D6-F1: empty inline-created task is cleaned up
        this.refocusRow(st.taskId) // [maint-0924 A7] Esc close must not drop focus to <body> (same rule as collapse())
      }
    }
    window.addEventListener('keydown', this._onKeydown)
    // Disable the browser's native spell check (English correction squiggles interfere with typing over Chinese content)
    this.$nextTick(() => {
      this.$el.querySelectorAll('textarea, input').forEach(el => el.setAttribute('spellcheck', 'false'))
    })
    // Dynamically created inputs (subtasks etc.) also get spell check disabled; named handler removed in beforeUnmount (listener accumulation when nodes are replaced after hydrate)
    this._onFocusin = e => {
      const t = e.target
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t.hasAttribute('spellcheck')) t.setAttribute('spellcheck', 'false')
    }
    this.$el.addEventListener('focusin', this._onFocusin)
    // The hidden date picker input stays out of the Tab focus chain (programmatic "pick a date" only)
    this.$nextTick(() => {
      const pickEl = $elOf(this.$refs.datePick)
      const inp = pickEl && pickEl.querySelector('input')
      if (inp) inp.setAttribute('tabindex', '-1')
    })
  },
  beforeUnmount () {
    window.removeEventListener('keydown', this._onKeydown)
    if (window.__editPanelFlushSave === this._flushHook) delete window.__editPanelFlushSave
    if (this.$el && this._onFocusin) this.$el.removeEventListener('focusin', this._onFocusin)
    // Esc 关闭路径不经 close():防抖回调会在卸载后写 this.saving,_sortable 也不会 destroy(2026-09-05 终审 P2)
    try { this.flushSave() } catch (e) { /* 卸载期落库失败不阻断卸载 */ }
    if (this._closeVerifyTimer) { clearTimeout(this._closeVerifyTimer); this._closeVerifyTimer = null }
    if (this._sortable) { try { this._sortable.destroy() } catch (err) { /* already destroyed */ } this._sortable = null }
  },
  methods: {
    // Locale-aware month/day label (same convention as CalendarView's fmtDate): the fixed 'M/D'
    // once showed numeric-only dates under the English UI, off-contract with the FMT format system
    fmtMd (ts) { return getLocale() === 'en-US' ? dayjs(ts).format('MMM D') : dayjs(ts).format(FMT.cnDate) },
    /* ===== Save pipeline wrappers (impl: utils/editSave.js) ===== */
    queueSave (patch) { if (this._save) this._save.queueSave(patch) },
    /** Immediately commit pending saves (must be called before switching tasks, so A's edits do not land on B).
     *  Review P1 (2026-09-22): the flush PROMISE is returned — ui/closeEditCleanup registers this method
     *  as window.__editPanelFlushSave and awaits it before the inline-created emptiness check; resolving
     *  undefined re-opened the 60ms race against the 350ms debounce (fast-typed title orphan-deleted). */
    flushSave () { return this._save ? this._save.flushSave() : undefined },
    retrySave () { this.saveFailed = false; this.flushSave() }, // D6-F9: banner Retry — onFail re-flags on failure
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
    hydrate (force) {
      const s = this.$store.state.ui.rightSidebarTodoEdit
      if (!s.visible || !s.taskId) return
      // P2 dedup (2026-09-25): the taskId and visible watchers are BOTH immediate, so a single
      // open used to run hydrate twice — double flushSave, double repeatGroupInfo DB query, double
      // initSubSortable. Same task + visible already hydrated → skip unless explicitly forced.
      const key = s.taskId + '|' + !!s.visible
      if (!force && this._hydKey === key) return
      this._hydKey = key
      this.flushSave()
      // P1 root fix (2026-10-01): rebuild the snapshot from the LIVE store row whenever it
      // exists. `s` is the open-time ui.rightSidebarTodoEdit snapshot — written once at open —
      // so the old hydrate re-adopted that frozen copy: a subtask/attachment added since open
      // was silently discarded on every pristine re-hydrate (echo reload / peer edit), a peer
      // rename could never appear, and the next save wrote the stale copy back over the store.
      // Only fall back to `s` when the row genuinely cannot be found (recycle-bin task).
      // (look the row up by s.taskId, NOT this.task — the computed still tracks the PREVIOUS
      // task while switching, and reading it here would hydrate B from A's row)
      const live = this.$store.state.todo.todoList.find(t => t.taskId === s.taskId) || null
      const src = live ? buildEditSnapshot(live) : s
      this.subList = JSON.parse(JSON.stringify(src.sublist))
      // Mint stable render keys for rows imported from the store (persisted subtasks carry no _key)
      for (const sub of this.subList) { if (sub && sub._key == null) sub._key = ++this._subKeySeq }
      this.imgList = JSON.parse(JSON.stringify(src.todoImageList))
      this.fileList = JSON.parse(JSON.stringify(src.fileList))
      const snap = JSON.parse(JSON.stringify(src))
      snap.visible = s.visible; snap.collapsed = s.collapsed; snap.taskId = s.taskId
      this.e = snap
      // F3: record the hydration baseline (live-row updateTime + core-field fingerprint) so
      // checkRemoteUpdate can tell inbound peer edits from the panel's own save echoes.
      // (renamed live->liveRow: `live` is taken above by the P1 live-row snapshot lookup —
      // duplicate declaration was a 500 on the vite SFC compile, dead-ending the whole dev host)
      const liveRow = this.task
      this._remoteUpdateTime = liveRow ? liveRow.updateTime : s.updateTime
      this._remoteFingerprint = contentFingerprint(this.e)
      this.remoteStale = false
      this.repeatGroupInfo()
      this.initSubSortable()
    },
    /** F3: the live todo-store row changed while the panel is open. Pristine panel (no unsaved
     *  user edits in the core fields) → silently re-hydrate from the store; panel holding user
     *  input → show the inline notice + manual refresh, never overwrite user text. */
    checkRemoteUpdate (row) {
      if (!this.e || !row || row.taskId !== this.e.taskId) return
      if (!this.$store.state.ui.rightSidebarTodoEdit.visible) return
      const verdict = shouldRefreshRemote({
        baseFingerprint: this._remoteFingerprint,
        baseUpdateTime: this._remoteUpdateTime,
        row
      })
      if (verdict === 'none') return
      if (contentFingerprint(this.e) === this._remoteFingerprint) {
        this.hydrate(true) // pristine: adopt the peer edit silently (forced — same-key dedup must not skip it)
      } else {
        this.remoteStale = true // user has unsaved edits: ask before overwriting
      }
    },
    /** F3: manual "刷新" from the remote-updated notice — the user chose to take the peer copy. */
    refreshFromStore () {
      this.remoteStale = false
      this.hydrate(true)
    },
    /* ===== Repeat: modals + group-count query (impl: edit-panel/repeat.js) ===== */
    async repeatGroupInfo () { return repeat.repeatGroupInfo(this) },
    close () {
      if (!this.autoSave) this.queueSave({})
      this.$store.dispatch('ui/closeEditCleanup') // D6-F1: cleanup-aware close
    },
    // Collapse is not close: the edit state is kept, collapsing into a thin strip on the right edge that can be expanded again
    collapse () {
      if (!this.autoSave) this.queueSave({})
      this.$store.dispatch('ui/collapseEditCleanup')
      // Hand focus back to the task row being edited (keyboard users would otherwise drop to <body>)
      this.refocusRow(this.e && this.e.taskId)
    },
    /** [maint-0924 A7] focus-return shared by collapse() and the Esc-close path: focus the edited
     * task row, falling back to the scroll container (focusable via tabindex=-1) */
    refocusRow (id) {
      this.$nextTick(() => {
        // P1 fix (2026-09-25): the row locator moved to utils/todoRowEl.js — the old fallback only
        // probed `el.__vue__` (Vue2-proprietary; this app is Vue3 createApp) and no `.td-item`
        // element carries data-id, so BOTH stages missed and Esc/collapse always dropped focus to
        // the scroll container. findTaskRowEl probes .td-item data-attributes plus BOTH Vue channels.
        const row = findTaskRowEl(id)
        if (row) { (row as HTMLElement).focus(); return }
        const list = document.querySelector<HTMLElement>('.main-scroll')
        if (list) {
          if (!list.hasAttribute('tabindex')) list.setAttribute('tabindex', '-1')
          list.focus()
        }
      })
    },
    /* [D17-DOM4] ARIA button pattern on the deadline clear chip: Space joins Enter, stopped so the
       surrounding reminder row never sees the key (net-zero line budget: shares fieldPatch above) */
    onDeadlineClearKey: roleButtonActivate(function () { this.fieldPatch('deadlineTs', 0) }, { stop: true }),
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
      else if (mode === 'tomorrow') this.applyDate(dayShift(this.today0, 1))
      else if (mode === 'none') this.applyDate(0)
      else if (mode === 'pick') {
        // focus() invokes the calendar panel (simulating a click on the 0-size hidden input is flaky), plus one extra click as a fallback
        const p = this.$refs.datePick
        if (!p) return
        if (p.focus) p.focus()
        const pickEl = $elOf(p)
        const inp = pickEl && pickEl.querySelector('input')
        if (inp) inp.click()
      }
    },
    /* Due-date pill → pop the calendar panel with a hidden selector (same proven path as setDate('pick')) */
    openDeadlinePick () {
      const p = this.$refs.deadlinePick
      if (!p) return
      if (p.focus) p.focus()
      const el = $elOf(p)
      const inp = el && el.querySelector('input')
      if (inp) inp.click()
    },
    applyDate (ts) {
      const oldDay = this.e.dateTs ? dayjs(this.e.dateTs).startOf('day') : null
      let remind = this.e.remindTs
      let offsetsCleared = false
      if (this.e.remindTs && ts) {
        const t = dayjs(this.e.remindTs)
        remind = dayjs(ts).hour(t.hour()).minute(t.minute()).valueOf()
      } else if (!ts) {
        remind = 0
        // [B13] offsets/extra die with the main reminder (same invariant as onRemindersClear):
        // zeroing the reminder while keeping reminderOffsets let stale offsets silently revive
        // the next time a reminder was set.
        offsetsCleared = true
      }
      // Multiple reminders: extra absolute reminders shift by the same number of days when the date changes (keeping their own time of day), otherwise they would all become past dates after a date change
      const extras = Array.isArray(this.e.reminderExtra) ? this.e.reminderExtra : []
      let next = extras
      if (extras.length && ts && oldDay) {
        const shift = dayjs(ts).startOf('day').diff(oldDay, 'day')
        if (shift) next = extras.map(x => dayjs(x).add(shift, 'day').valueOf())
      }
      if (offsetsCleared) next = []
      this.e.dateTs = ts || 0
      this.e.remindTs = remind
      this.e.reminderExtra = next
      if (offsetsCleared) this.e.reminderOffsets = []
      // [B4] the save patch carries the cleared arrays too so the store row cannot keep stale offsets
      // reminderOffsets rides in the literal so the queued patch type always carries it
      const patch = { todoTime: ts || 0, reminderTime: remind, reminderExtra: next, reminderOffsets: offsetsCleared ? [] : this.e.reminderOffsets }
      this.queueSave(patch)
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
        .then(() => this.hydrate(true))
    },
    /** Restore the currently edited task from the recycle bin (keeping the edited fields); after restore the banner disappears and the complete row returns */
    async restoreFromBin () {
      if (!this.e || !this.e.taskId) return
      // queueSave is a 350ms debounce timer (returns no promise); before restoring, synchronously flush unsaved dirty fields and clear the timer to prevent double writes
      this._save.clearTimer()
      const all: any = this._save.takeDirty(['subtasks', 'imgs', 'files'])
      try {
        // [restore single-path fix] this banner used to dispatch a bare updateTodoFields
        // {delete:false,status:'update'} — it left the stale deletedAt on the row, skipped the
        // one-shot planChips snapshot restore and skipped the B5 dangling-repeatId guard,
        // exactly the gaps RecycleBinView's restore() already fixed by going through the single
        // todo/restoreFromRecycle entry. Same entry here; the dirty-field flush rides the same
        // atomic restore patch via dayPatch (the action spreads it into the updateTodoFields
        // patch; it carries no date fields, so chip re-homing is a no-op).
        await this.$store.dispatch('todo/restoreFromRecycle', {
          taskId: this.e.taskId,
          repeatId: this.e.repeatId,
          dayPatch: all
        })
      } catch (e) {
        // Restore failed: keep the item in the bin and surface the error instead of a false-success toast
        this.$message.error(this.$t('statsC.RecycleBin.restoreFailedMsg') + (e && e.message ? e.message : e))
        return
      }
      this.$message.success(this.$t('statsJ.EditPanel.restoredMsg'))
      this.hydrate(true)
    },
    /* ===== Subtasks: EpSubtasks emits; subList + the toggle-complete linkage stay here ===== */
    addSub (text) {
      if (!text || !this.e) return
      this.subList.push({ text, checked: false, _key: ++this._subKeySeq })
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
        () => {
          // P2: locate by item reference — the captured index goes stale when another subtask is removed first (out-of-order undos)
          const at = this.subList.indexOf(sub)
          this.subList.splice(at < 0 ? this.subList.length : at, 1)
          this.markDirty('subtasks'); this.queueSave({})
        },
        () => {
          const at = this.subList.indexOf(sub)
          this.subList.splice(at < 0 ? this.subList.length : at, 0, sub)
          this.markDirty('subtasks'); this.queueSave({})
        })
    },
    moveSub (i, dir) {
      const j = i + dir
      if (j < 0 || j >= this.subList.length) return
      const tmp = this.subList[i]; this.subList[i] = this.subList[j]; this.subList[j] = tmp
      this.markDirty('subtasks'); this.queueSave({})
      // [maint-0925 A8] screen-reader feedback, same sentence as the row-level reorder (TodoItem.keyboardMove)
      this.$announce && this.$announce(this.$t(dir > 0 ? 'statsJ.TodoItem.moveDownAnnounce' : 'statsJ.TodoItem.moveUpAnnounce', { t: (this.subList[j] && this.subList[j].text) || '' }))
    },
    // [R2] subtask inline rename (EpSubtasks 'rename' emit): rewrite the row text and run it through
    // the same unified save pipeline as add/toggle/move
    renameSub (i, text) {
      const sub = this.subList[i]
      const t = (text || '').trim()
      if (!sub || !t || sub.text === t) return
      sub.text = t
      this.markDirty('subtasks'); this.queueSave({})
    },
    /* Actual = total of this task's focus records; click = open the ledger detail (add/remove/modify entries, totals reconcile automatically) */
    openAccount () {
      if (this.task) this.$store.commit('ui/openTaskAccount', this.task.taskId)
    },
    /* ===== Attachments: upload/paste/drop orchestration (impl: edit-panel/attachments.js).
       scrollImgsIntoView stays here — focus/scroll timing is the component's concern. ===== */
    pickFiles (kind) { return attachments.pickFiles(this, kind) },
    isRenderableAttachmentUrl,
    onDescPaste (e) { return attachments.onDescPaste(this, e) },
    onDescDrop (e) { return attachments.onDescDrop(this, e) },
    /* After paste/drop, scroll thumbnails into view for immediate "it landed" feedback */
    scrollImgsIntoView () {
      this.$nextTick(() => {
        const el = this.$el && this.$el.querySelector('.ep-imgs')
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    },
    uploadOne (kind, f) { return attachments.uploadOne(this, kind, f) },
    removeFile (arrName, idx) {
      const item = this[arrName][idx]
      if (!item) return
      // P1 fix (2026-09-25): physical disk deletion used to ride a fixed 5.5s setTimeout while the
      // undo toast's timer PAUSES ON HOVER — hover past 5.5s then clicking 撤销 revived the list
      // entry but the file was already gone. Deletion is now deferred to the toast's dismiss hook
      // (fires on every close path, after the hover-aware timer), guarded by an undone flag and the
      // existing store-row url re-check.
      let undone = false
      const deleteFromDisk = () => {
        if (undone || !item.url) return
        // Data-safety guard: re-check the latest task row in the store before touching the disk. If the JSON update never landed (save failed / panel unmounted mid-write), the row still references the url — deleting the file then would corrupt the task's attachments.
        const row = this.$store.state.todo.todoList.find(t => t.taskId === (this.e && this.e.taskId))
        if (attachmentUrlPresent(row, item.url)) return
        // .catch: delete-file now surfaces structured errors instead of swallowing them (2026-09-11); this call is a fire-and-forget sweep — a failure must not become an unhandled rejection.
        // [maint-0925 D] the old catch(() => {}) discarded the structured error entirely: log it via the
        // shared reportError path (main's contract expects the error to surface; no toast — the row
        // removal already committed, only the disk sweep can fail here).
        window.todoAPI.deleteFile(item.url).catch(err => reportError('delete-file:' + (item && item.url), err))
      }
      // Review-fix (2026-09-25): when the toast can't be shown (no $message / no Vue — removeWithUndo
      // early-returns BEFORE arming any dismissal), onDismiss would never fire and the disk file
      // would leak forever. Fall back to the old fixed-delay deletion (same store-row guard).
      if (!removeWithUndo(this,
        () => {
          const at = this[arrName].indexOf(item) // P2: indexOf — a captured idx goes stale when an earlier row is removed first (out-of-order undos)
          this[arrName].splice(at < 0 ? this[arrName].length : at, 1)
          this.markDirty(arrName === 'imgList' ? 'imgs' : 'files')
          this.queueSave({})
        },
        () => {
          undone = true
          const at = this[arrName].indexOf(item)
          this[arrName].splice(at < 0 ? this[arrName].length : at, 0, item)
          this.markDirty(arrName === 'imgList' ? 'imgs' : 'files')
          this.queueSave({})
        },
        { onDismiss: deleteFromDisk })) {
        setTimeout(deleteFromDisk, 5500)
      }
    },
    delTask () {
      // Recurring tasks share the context-menu semantics: ask the scope first (this instance only / the whole series)
      if (this.isRepeat && this.task) return this.askRepeatDelete()
      // Same semantics as the list/todo box/quadrant matrix: no confirmation dialog, 5s undo toast after delete (consistency consolidated 2026-08-31)
      deleteWithUndo(this, this.$store, this.task).then(ok => { if (ok) this.close() }).catch(() => {})
    },
    /* ===== Repeat (impl: edit-panel/repeat.js) ===== */
    askRepeatEdit () { return repeat.askRepeatEdit(this) },
    askRepeatDelete () { return repeat.askRepeatDelete(this) },
    // P2 fix (impl: edit-panel/interactions.js): header-row clicks are excluded from the
    // click-outside closure so the header's click toggle alone owns open/close (the pop used to
    // close on mousedown and re-open on the same row's click — it could never be dismissed)
    onCatOutside (e) { return catOutsideClose(this, e) },
    estDelta (d) { setEstimate(this.e && this.e.taskId, getEstimate(this.e && this.e.taskId) + d) },
    chipCat (c) { this.fieldPatch('categoryId', c.categoryId) }, // reserved: category quick chips
    pickCat (id) { this.fieldPatch('categoryId', id); this.catOpen = false },
    /* ===== Dependencies: EpDependencies emits the merged predecessors JSON; persistence stays here ===== */
    patchPreds (predecessorsJson) {
      this.e.predecessors = predecessorsJson
      this.markDirty('preds'); this.queueSave({})
    },
    tt (k) { const s = String(k || ''); return (s.startsWith('statsE.') || s.startsWith('statsJ.')) ? this.$t(s) : s },
    // EpTags emits a cleaned, deduped tag name; the title hash-token rewrite + persistence stay here
    addTag (name) {
      if (!this.e || !name) return
      const base = (this.e.title || '').replace(/\s+$/, '')
      // [maint-0925 A10] empty base produced a title with a leading space (' #name')
      this.fieldPatch('title', base ? base + ' #' + name : '#' + name)
    },
    removeTag (name) {
      // [maint-0925 A6] undo re-derives from the CURRENT title (the prevTitle snapshot clobbered edits made during the toast): re-insert at the original offset unless re-typed
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const tokenRe = new RegExp('\\s*#' + esc + '(?=[\\s#,，。.!?！？]|$)')
      const m = (this.e.title || '').match(new RegExp('#' + esc + '(?=[\\s#,，。.!?！？]|$)'))
      this._removedTagAt = m ? m.index : null
      removeWithUndo(this,
        () => this.fieldPatch('title', (this.e.title || '').replace(tokenRe, '')),
        () => {
          const cur = this.e ? (this.e.title || '') : ''
          if (new RegExp('(^|\\s)#' + esc + '(?=[\\s#,，。.!?！？]|$)').test(cur)) return // re-added during the toast: nothing to restore
          const at = Math.min(this._removedTagAt == null ? cur.length : this._removedTagAt, cur.length)
          const before = cur.slice(0, at).replace(/\s+$/, '')
          this.fieldPatch('title', (before ? before + ' ' : '') + '#' + name + cur.slice(before.length))
        })
    }
  },
}
</script>
<style>
/* Global (unscoped) styles extracted verbatim to edit-panel/editPanel.css (structure-size ratchet) */
@import './edit-panel/editPanel.css';
</style>
