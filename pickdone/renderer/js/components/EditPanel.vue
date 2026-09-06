<template>

  <transition name="slide-right" appear>
  <aside v-if="e" class="edit-panel" @click.stop>
    <div class="ep-inner">
        <div v-if="saveFailed" class="ep-save-failed" role="alert">{{ $t('statsE.EditPanel.saveFailed') }}</div>
      <div class="ep-title-row">
        <el-input type="textarea" :autosize="{minRows:1,maxRows:4}" :placeholder="$t('statsE.EditPanel.addTitlePlaceholder')"
                  :model-value="e.title" @input="v=>fieldPatch('title',v)" class="ep-title"/>
        <!-- Persistent equal-width placeholder (ghost): with v-if the title textarea's usable width would jump at the start/end of every autosave -->
        <span class="ep-saving" :class="{ghost: !saving}" aria-live="polite" :aria-hidden="!saving">…</span>
        <span class="ep-collapse-btn" :title="$t('statsE.EditPanel.collapseEditor')" role="button" tabindex="0"
              :aria-label="$t('statsE.EditPanel.collapseEditor')" @click="collapse" @keydown.enter.prevent="collapse">
          <svg viewBox="0 0 16 16"><path d="M6 3.5 L11 8 L6 12.5" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>

      <el-input type="textarea" :autosize="{minRows:3,maxRows:8}" :placeholder="$t('statsE.EditPanel.descPlaceholder')"
                :model-value="e.desc" @input="v=>fieldPatch('desc',v)" class="ep-desc"
                @paste="onDescPaste" @dragover.prevent @drop.prevent="onDescDrop"/>
      <!-- Content toolbar: image/attachment entries unified on the description area (the standalone "upload image" row was merged in, Option B) -->
      <div class="ep-attach-bar">
        <span class="ep-attach-btn" role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.imagesLabel')"
              @click="pickFiles('img')" @keydown.enter.prevent="pickFiles('img')">
          <img class="ep-ico" src="app://app/assets/img/icon-pic.svg">{{ $t('statsE.EditPanel.imagesLabel') }}<b v-if="imgList.length" class="ep-attach-n">{{ imgList.length }}</b>
        </span>
        <span class="ep-attach-btn" role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.attachmentsLabel')"
              @click="pickFiles('file')" @keydown.enter.prevent="pickFiles('file')">
          <app-icon name="file" :size="12"/>{{ $t('statsE.EditPanel.attachmentsLabel') }}<b v-if="fileList.length" class="ep-attach-n">{{ fileList.length }}</b>
        </span>
      </div>

      <div class="ep-date-chips">
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===todayLabel}"
              @click="setDate('today')" @keydown.enter.prevent="setDate('today')"><app-icon name="sun" :size="12"/>{{ $t('statsE.EditPanel.todayOption') }}</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===tomorrowLabel}"
              @click="setDate('tomorrow')" @keydown.enter.prevent="setDate('tomorrow')"><app-icon name="calendar" :size="12"/>{{ $t('statsE.EditPanel.tomorrowOption') }}</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel}"
              @click="setDate('pick')" @keydown.enter.prevent="setDate('pick')"><app-icon name="calendar" :size="12"/>
          {{dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel ? dateChip : $t('statsJ.EditPanel.pickDate')}} ▾</span>
        <span class="ep-date-chip" role="button" tabindex="0" :class="{on: !e.dateTs}"
              @click="setDate('none')" @keydown.enter.prevent="setDate('none')">{{ $t('statsE.EditPanel.noDateOption') }}</span>
        <!-- The picker sits outside the chip, avoiding ARIA nesting of an input inside a button -->
        <el-date-picker ref="datePick" size="small" value-format="x" type="date"
                        style="width:0;height:0;border:0;padding:0;position:absolute;opacity:0" class="ep-date-pick"
                        :aria-label="$t('statsE.EditPanel.pickDate')" popper-class="ep-date-popper"
                        :model-value="e.dateTs||null" @update:model-value="onPickDate"/>
      </div>

      <div class="ep-cat-wrap">
        <div class="ep-row ep-cat-row" role="button" tabindex="0" :aria-expanded="catOpen ? 'true' : 'false'"
             @click="catOpen=!catOpen" @keydown.enter.prevent="catOpen=!catOpen">
          <span class="ep-field-label ep-field-ico" :title="$t('statsE.EditPanel.categoryLabel')"><app-icon name="tag" :size="13"/></span>
          <span v-if="curCat" class="ep-cat-dot" :style="{background: curCat.categoryColor}"></span>
          <span class="ep-cat-name" :class="{'is-placeholder': !curCat}">{{ curCat ? curCat.categoryName : $t('statsE.EditPanel.uncategorized') }}</span>
          <span class="ml-auto"></span>
          <span class="ep-row-arrow" :class="{on: catOpen}">▾</span>
        </div>
        <div v-if="catOpen" v-click-outside="() => catOpen = false" class="ep-cat-pop" role="listbox">
          <div class="ep-cat-opt" role="option" :class="{on: !e.categoryId}" :aria-selected="(!e.categoryId)?'true':'false'"
               tabindex="0" @click="pickCat(0)" @keydown.enter.prevent="pickCat(0)">
            <span class="ep-cat-dot" style="background:var(--text-4)"></span>{{ $t('statsE.EditPanel.uncategorizedOption') }}</div>
          <div v-for="c in cats" :key="c.categoryId" class="ep-cat-opt" role="option"
               :class="{on: e.categoryId===c.categoryId}" :aria-selected="(e.categoryId===c.categoryId)?'true':'false'"
               tabindex="0" @click="pickCat(c.categoryId)" @keydown.enter.prevent="pickCat(c.categoryId)">
            <span class="ep-cat-dot" :style="{background: c.categoryColor}"></span> {{ c.categoryName }}
          </div>
        </div>
      </div>

      <!-- 任务依赖(实验性,developerMode 门控):前置任务多选,FS 语义——前置全部完成本任务才 ready -->
      <div v-if="devMode" class="ep-cat-wrap">
        <div class="ep-row ep-cat-row" role="button" tabindex="0" :aria-expanded="depOpen ? 'true' : 'false'"
             @click="depOpen=!depOpen" @keydown.enter.prevent="depOpen=!depOpen">
          <span class="ep-field-label ep-field-ico" :title="$t('statsE.EditPanel.depsLabel')"><app-icon name="link" :size="13"/></span>
          <span class="ep-cat-name is-placeholder">$t('statsE.EditPanel.depsN', { n: depPreds.length })</span>
          <span class="ml-auto"></span>
          <span class="ep-row-arrow" :class="{on: depOpen}">▾</span>
        </div>
        <div v-if="depOpen" v-click-outside="() => depOpen = false" class="ep-cat-pop" role="listbox">
          <div v-for="(name, i) in depPredNames" :key="depPreds[i]" class="ep-cat-opt" role="option">
            <span class="ep-cat-dot" style="background:var(--brand)"></span> {{ name }}
            <span class="ml-auto"></span>
            <button class="close-x" :aria-label="$t('statsE.EditPanel.depsRemove')" @click.stop="rmPred(depPreds[i])"></button>
          </div>
          <div v-for="c in depCandidates" :key="c.taskId" class="ep-cat-opt" role="option"
               tabindex="0" @click="addPred(c.taskId)" @keydown.enter.prevent="addPred(c.taskId)">
            <span class="ep-cat-dot" style="background:var(--text-4)"></span> + {{ c.taskContent }}
          </div>
        </div>
      </div>

      <div class="ep-row ep-tags-row">
        <span class="ep-field-label ep-field-ico" :title="$t('statsE.EditPanel.tagsPlaceholder')"><b class="ep-hash">#</b></span>
        <span v-for="t in taskTags" :key="t" class="ep-tag-chip">
          #{{ t }}
          <span class="ep-tag-x close-x" role="button" tabindex="0" :title="$t('statsE.EditPanel.removePrefix') + t" :aria-label="$t('statsJ.EditPanel.removeTag', { t: t })"
                @click.stop="removeTag(t)" @keydown.enter.prevent.stop="removeTag(t)"></span>
        </span>
        <input class="ep-tag-input" v-model="tagInput" :placeholder="$t('statsE.EditPanel.addTagHint')" :aria-label="$t('statsE.EditPanel.addTag')"
               @keydown.enter.prevent="addTag" @blur="addTag"/>
      </div>

      <div v-if="inRecycle" class="ep-recycle-banner">
        <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
        <span>{{ $t('statsE.EditPanel.recycleBinEditTip') }}</span>
        <button class="mini" @click="restoreFromBin">{{ $t('statsE.EditPanel.restoreBtn') }}</button>
      </div>

      <div v-if="!inRecycle" class="ep-row ep-done-row" role="checkbox" :aria-checked="(task&&task.complete)?'true':'false'" tabindex="0"
           @click="toggleComplete" @keydown.enter.prevent="toggleComplete">
        <span class="ep-field-label ep-field-ico" :title="$t('statsE.EditPanel.doneBtn')"><app-icon name="check" :size="13"/></span>
        <span class="ep-done-label">{{ $t('statsE.EditPanel.doneBtn') }}</span>
        <span class="ml-auto"></span>
        <span class="ep-sub-check" :class="{on: task&&task.complete}">{{ (task&&task.complete) ? '✓' : '' }}</span>
      </div>

      <div class="ep-row ep-remind" @click="toggleRemind">
        <span class="ep-remind-main" role="button" tabindex="0" :aria-expanded="remindOpen ? 'true' : 'false'"
              @click.stop="toggleRemind" @keydown.enter.prevent="toggleRemind">
          <img class="ep-ico" src="app://app/assets/img/icon-clock.svg">
          <span class="ep-remind-label" :class="{'ep-remind-label--active': e.remindTs>0}">{{e.remindTs? remindMainLabel : $t('statsJ.EditPanel.addReminder')}}</span>
        </span>
        <span class="ml-auto"></span>
        <transition name="fade">
          <b v-if="e.remindTs>0" class="ep-remind-clear close-x close-x--sm" :title="$t('statsE.EditPanel.clearReminder')" role="button" tabindex="0"
             :aria-label="$t('statsE.EditPanel.clearReminder')" @click.stop="clearRemind" @keydown.enter.prevent.stop="clearRemind"></b>
        </transition>
      </div>
      <transition name="collapse">
        <div v-show="remindOpen" class="ep-remind-pop" @click.stop>
          <div v-for="(r, i) in remindRows" :key="i" class="ep-remind-line">
            <el-date-picker size="small" value-format="x" type="date" :placeholder="$t('statsE.EditPanel.dateLabel')"
                            v-model="r.date" @update:model-value="commitReminders" style="width:118px"/>
            <el-time-picker size="small" value-format="HH:mm" format="HH:mm" :placeholder="$t('statsE.EditPanel.timeLabel')"
                            v-model="r.time" @update:model-value="commitReminders" style="width:90px"/>
            <span v-if="i === 0" class="ep-remind-line-tag">{{ $t('statsJ.EditPanel.remindMain') }}</span>
            <b v-else class="ep-remind-line-x close-x close-x--sm" role="button" tabindex="0"
               :aria-label="$t('statsE.EditPanel.clearReminder')" @click.stop="removeRemindRow(i)"
               @keydown.enter.prevent.stop="removeRemindRow(i)"></b>
          </div>
          <div class="ep-remind-add" role="button" tabindex="0" :aria-label="$t('statsJ.EditPanel.addReminder')"
               @click="addRemindRow" @keydown.enter.prevent="addRemindRow">
            <span class="ep-remind-add-plus">+</span>{{ $t('statsJ.EditPanel.addReminder') }}
          </div>
          <div v-if="e.remindTs>0" class="ep-remind-offsets">
            <span class="ep-remind-offsets-label" :title="$t('statsJ.EditPanel.remindOffsetsHint')">{{ $t('statsJ.EditPanel.remindAlso') }}</span>
            <button v-for="p in offsetPresetsList()" :key="p.v" type="button" class="ep-offset-chip"
                    :class="{on: e.reminderOffsets.includes(p.v)}" role="switch"
                    :aria-checked="e.reminderOffsets.includes(p.v) ? 'true' : 'false'"
                    @click="toggleOffset(p.v)">{{ p.l }}</button>
          </div>
        </div>
      </transition>

      <div v-if="!inRecycle" class="ep-row ep-repeat-row" role="button" tabindex="0"
           :aria-label="isRepeat ? $t('statsE.EditPanel.editRepeatRule') : $t('statsJ.EditPanel.setRepeat')"
           @click="askRepeatEdit" @keydown.enter.prevent="askRepeatEdit">
        <span class="ep-field-label ep-field-ico" :title="$t('statsE.TodoItem.repeatLabel')"><app-icon name="repeat" :size="13"/></span>
        <span class="ep-remind-label" :class="{'ep-remind-label--active': isRepeat}">{{ isRepeat ? $t('statsE.EditPanel.repeatPrefix') + $t('statsJ.EditPanel.repeatN', { n: repeatCount }) : $t('statsJ.EditPanel.setRepeat') }}</span>
        <span class="ml-auto"></span>
        <template v-if="isRepeat">
          <button class="ep-mini" @click.stop="askRepeatEdit">{{ $t('statsE.EditPanel.ruleLabel') }}</button>
          <button class="ep-mini danger" @click.stop="askRepeatDelete">{{ $t('statsE.EditPanel.deleteEllipsis') }}</button>
        </template>
      </div>

      <div class="ep-subs" ref="subList">
        <div v-for="(s,i) in subList" :key="i" class="ep-sub">
          <span class="ep-sub-check" :class="{on:s.checked}" role="checkbox" :aria-checked="s.checked ? 'true' : 'false'"
                tabindex="0" @click.stop="toggleSub(s)" @keydown.enter.prevent.stop="toggleSub(s)">{{ s.checked ? '✓' : '' }}</span>
          <span class="ep-sub-text" :class="{strike:s.checked}">{{s.text}}</span>
          <b class="ep-sub-x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.deleteSubtask')"
             @click.stop="delSub(i)" @keydown.enter.prevent.stop="delSub(i)"></b>
          <b class="ep-sub-drag">≡</b>
          <span class="ep-sub-move">
            <i role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.moveSubtaskUp')" @click.stop="moveSub(i,-1)" @keydown.enter.prevent.stop="moveSub(i,-1)">↑</i><i role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.moveSubtaskDown')" @click.stop="moveSub(i,1)" @keydown.enter.prevent.stop="moveSub(i,1)">↓</i>
          </span>
        </div>
        <div class="ep-row ep-addsub">
          <img class="ep-ico" src="app://app/assets/img/icon-sublist.svg">
          <input v-model="newSub" :placeholder="$t('statsE.EditPanel.addSubtaskAria')+subDoneText" :aria-label="$t('statsE.EditPanel.addSubtask')" @keyup.enter="addSub" class="ep-addsub-input"/>
        </div>
      </div>

      <div class="ep-row ep-prio">
        <img class="ep-ico" src="app://app/assets/img/icon-tune.svg" style="opacity:.6">
        <span class="ep-diff-label">{{ $t('statsE.EditPanel.priorityLabel') }}</span><span class="hint-q" :title="$t('statsE.EditPanel.urgencyHint')">?</span>
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
            <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estTip')" @click.stop="estDelta(-1)">−</button>
            <span class="ep-tom-num">{{ tomatoEstimateN }}</span>
            <button class="ep-tom-step" :aria-label="$t('statsG.EpTomato.estTip')" @click.stop="estDelta(1)">+</button>
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
          {{ e&&e.deadlineTs ? dayjs(e.deadlineTs).format('M/D') : $t('statsE.EditPanel.pickDueDate') }}
        </span>
        <b v-if="e&&e.deadlineTs" class="ep-remind-clear close-x" role="button" tabindex="0" :title="$t('statsE.EditPanel.clearDueDate')" @click.stop="fieldPatch('deadlineTs',0)"></b>
        <el-date-picker ref="deadlinePick" size="small" value-format="x" type="date"
                        style="width:0;height:0;border:0;padding:0;position:absolute;opacity:0" class="ep-deadline-pick"
                        :aria-label="$t('statsJ.EditPanel.setDeadline')" popper-class="ep-date-popper"
                        :model-value="e&&e.deadlineTs||null" @update:model-value="ts=>fieldPatch('deadlineTs', ts||0)"/>
      </div>

      <div class="ep-imgs" v-if="imgList.length">
        <div v-for="(im,i) in imgList" :key="i" class="ep-img-cell">
          <button type="button" class="ep-img-btn" :aria-label="$t('statsE.EditPanel.zoomImage') + (Number(i)+1)" @click="previewImg=im.url">
            <img :src="im.url" alt="" loading="lazy" @error="onImgErr($event)">
          </button>
          <b class="x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.removeImage')" @click.stop="removeFile('imgList',i)" @keydown.enter.prevent.stop="removeFile('imgList',i)"></b>
        </div>
      </div>
      <div v-for="(f,i) in fileList" :key="'f'+i" class="ep-file">
        <app-icon name="file" :size="12" style="opacity:.6"/> {{f.name}} <a role="button" tabindex="0" @click.prevent.stop="openFileUrl(f)" @keydown.enter.prevent.stop="openFileUrl(f)">{{ $t('statsE.EditPanel.openBtn') }}</a> <b class="x close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsE.EditPanel.removeFile')" @click.stop="removeFile('fileList',i)" @keydown.enter.prevent.stop="removeFile('fileList',i)"></b>
      </div>

      <div class="ep-flex"></div>

      <div class="ep-tools">
        <span class="ml-auto"></span>
        <span class="ep-tool danger" role="button" tabindex="0" :title="$t('statsE.EditPanel.deleteBtn')" :aria-label="$t('statsE.EditPanel.deleteTask')" @click="delTask" @keydown.enter.prevent="delTask">
          <i class="ico" style="--ico:url('app://app/assets/img/delete_black_48dp.svg');width:16px;height:16px"></i>
        </span>
      </div>
    </div>

    <div v-if="previewImg" ref="previewMask" tabindex="-1" class="img-preview-mask" role="dialog" aria-modal="true" :aria-label="$t('statsE.EditPanel.imagePreview')" @click.self="previewImg=null" @keydown.esc="previewImg=null">
      <img :src="previewImg"><button class="close-x" :aria-label="$t('statsE.EditPanel.removeImage')" @click.stop="previewImg=null"></button>
    </div>
  </aside>
  </transition>
</template>

<script lang="ts">
/**
 * Right edit panel -- aligned with the right-sidebar reference:
 * Category chips / complete + expand / title / description / date chips (today, tomorrow, pick a date, no date) /
 * add reminder / subtasks (x, drag handle) / add subtask (n/20) / three difficulty levels / upload images / bottom tool row
 */
import {dayjs, DAY_MS, FMT } from '../utils/core.js'
import { extractTags } from '../utils/search.js'
import { subsCompleteTarget, reportError } from '../utils/core.js'
import { deleteWithUndo, removeWithUndo } from '../utils/confirm.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { getEstimate, setEstimate } from '../utils/tomatoEstimate.js'

const FIELD_MAP = {
  title: 'taskContent',
  desc: 'taskDescribe',
  categoryId: 'categoryId',
  priority: 'priority',
  deadlineTs: 'deadlineTs'
}
// Priority has two tiers (user-finalized): high/low; connected with the quadrant's important — high⇔important=1, low⇔important=0 (see fieldPatch)
const PRIOS = [{ v: 3, l: 'statsE.EditPanel.priorityHigh' }, { v: 1, l: 'statsJ.EditPanel.prioLow' }]

export default {
  name: 'EditPanel',
  data () {
    return {
      e: null as any,
      saving: false,
      saveFailed: false,
      catOpen: false,
      depOpen: false,
      tagInput: '',
      newSub: '',
      subList: [] as any,
      imgList: [] as any,
      fileList: [] as any,
      previewImg: null as any,
      repeatCount: 0,
      remindOpen: false,
      remindRows: [], // Multiple reminder row model [{date: ts|null, time: 'HH:mm'}]; row 0 = main reminder
      PRIOS
    }
  },
  created () { this._dirtyFlags = {} },
  computed: {
    task () { return this.$store.state.todo.todoList.find(t => t.taskId === (this.e && this.e.taskId)) || null },
    devMode () { return !!this.$store.state.settings.developerMode },
    depPreds () { // parse predecessors of the task under edit
      try { const a = JSON.parse((this.e && this.e.predecessors) || '[]'); return Array.isArray(a) ? a.filter(Boolean) : [] } catch { return [] }
    },
    depPredNames () {
      const byId = {}
      for (const t of this.$store.state.todo.todoList) byId[t.taskId] = t
      return this.depPreds.map(id => (byId[id] && (byId[id].taskContent || byId[id].taskId)) || id)
    },
    depCandidates () { // undone tasks (excl. self & existing preds), first 8 by recency
      const have = new Set(this.depPreds)
      const self = this.e && this.e.taskId
      return this.$store.state.todo.todoList
        .filter(t => !t.delete && !t.complete && t.taskId !== self && !have.has(t.taskId) && t.taskContent)
        .slice(0, 8)
    },
    /* Pomodoro estimate/actual (ported from the refactor branch): the estimate is stored in tomatoEstimate, the actual is accumulated by attributing pomodoro records */
    tomatoEstimateN () { return getEstimate(this.e && this.e.taskId) },
    tomatoActual () {
      const id = this.e && this.e.taskId
      if (!id) return 0
      // The original predicate r.focus!==false was a copy-paste bug (focus is the task name, always truthy = abandoned ones were counted too); use the store lookup uniformly (abandoned excluded)
      return this.$store.getters['tomato/actualCountByTask'].get(id) || 0
    },
    // Recycle bin task: task cannot be found in the non-deleted list, so fall back to the recycle list to detect it (hide the "complete" row, show the restore banner)
    /** Main reminder row summary: first reminder time + total reminder count (with multiple reminders), so the result is visible on one line */
    remindMainLabel () {
      const base = dayjs(this.e.remindTs).format(FMT.cnDate + ' ' + FMT.time)
      const n = 1 + (Array.isArray(this.e.reminderExtra) ? this.e.reminderExtra.length : 0)
      return n > 1 ? base + ' · ' + this.$t('statsJ.EditPanel.remindTotal', { n }) : base
    },
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
    },
    subDoneText () {
      const d = this.subList.filter(s => s.checked).length
      return this.subList.length ? `(${d}/${this.subList.length})` : ''
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
      if (ui.showSettingsModal || ui.showRepeatModalFor || ui.showFeedbackModal) return
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
    tt (k) { const s = String(k || ''); return (s.startsWith('statsE.') || s.startsWith('statsJ.')) ? this.$t(s) : s },
    onImgErr (e) { (e.target as HTMLElement).classList.add('ep-img-broken') },
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
    /** Immediately commit pending saves (must be called before switching tasks, so A's edits do not land on B) */
    flushSave () {
      if (!this._dirtyFlags) return // the immediate watcher fires before created; the dirty flags are not yet initialized
      clearTimeout(this._t)
      const e = this.e
      if (!e || !e.taskId) return
      const all: any = {}
      if (this._dirtyFlags.subtasks) all.subtasks = JSON.stringify(this.subList)
      if (this._dirtyFlags.imgs) all.image = JSON.stringify(this.imgList)
      if (this._dirtyFlags.files) all.files = JSON.stringify(this.fileList)
      if (this._dirtyFlags.preds) all.predecessors = this.e.predecessors
      this._dirtyFlags = {}
      if (Object.keys(all).length) {
        this.$store.dispatch('todo/updateTodoFields', { taskId: e.taskId, patch: all }).catch(() => {})
      }
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
    /* ===== Reminders: multiple reminder row list (row 0 = main reminder; date + time on one row, + to keep adding) ===== */
    toggleRemind () {
      if (!this.e) return
      if (this.remindOpen) { this.remindOpen = false; return }
      const day0 = this.e.dateTs || this.today0
      const toRow = ts => {
        const d = dayjs(ts)
        return { date: d.startOf('day').valueOf(), time: d.format(FMT.time) }
      }
      const rows = []
      if (this.e.remindTs) rows.push(toRow(this.e.remindTs))
      for (const ts of (Array.isArray(this.e.reminderExtra) ? this.e.reminderExtra : [])) rows.push(toRow(ts))
      if (!rows.length) rows.push({ date: day0 || null, time: '09:00' })
      this.remindRows = rows
      this.remindOpen = true
    },
    addRemindRow () {
      // New rows default to the task's date (empty if undated); the time is staggered 30 minutes after the previous row to avoid collisions
      const last = this.remindRows[this.remindRows.length - 1]
      const [h, m] = String((last && last.time) || '09:00').split(':').map(Number)
      const nm = (h * 60 + m + 30) % 1440
      this.remindRows.push({ date: (last && last.date) || (this.e.dateTs || null), time: String(Math.floor(nm / 60)).padStart(2, '0') + ':' + String(nm % 60).padStart(2, '0') })
    },
    removeRemindRow (i) {
      const row = this.remindRows[i]
      removeWithUndo(this,
        () => {
          this.remindRows.splice(i, 1)
          if (!this.remindRows.length) { this.clearRemind(); return }
          this.commitReminders()
        },
        () => { this.remindRows.splice(i, 0, row); this.commitReminders() })
    },
    commitReminders () {
      if (!this.e) return
      const list = []
      for (const r of this.remindRows) {
        const baseDay = r.date || this.e.dateTs || this.today0
        if (!baseDay) continue
        const [h, m] = String(r.time || '09:00').split(':').map(Number)
        list.push(dayjs(baseDay).hour(h || 0).minute(m || 0).second(0).millisecond(0).valueOf())
      }
      if (!list.length) { this.clearRemind(); return }
      list.sort((a, b) => a - b)
      const mainChanged = list[0] !== this.e.remindTs
      this.e.remindTs = list[0]
      this.e.reminderExtra = list.slice(1)
      if (mainChanged && list[0] < Date.now()) this.$message.warning(this.$t('statsE.EditPanel.reminderPastTip'))
      if (!this.e.dateTs) this.e.dateTs = dayjs(list[0]).startOf('day').valueOf()
      this.queueSave({ reminderTime: this.e.remindTs, reminderExtra: this.e.reminderExtra, todoTime: this.e.dateTs })
    },
    clearRemind () {
      if (!this.e) return
      this.e.remindTs = 0
      this.e.reminderExtra = []
      this.e.reminderOffsets = [] // offsets are anchored to the main reminder; clearing the main reminder must clear them too, otherwise stale offsets silently revive when reminders are re-set
      this.remindOpen = false
      this.queueSave({ reminderTime: 0, reminderExtra: [], reminderOffsets: [] })
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
      if (!this.e) return
      const cur = Array.isArray(this.e.reminderOffsets) ? this.e.reminderOffsets.slice() : []
      const i = cur.indexOf(v)
      if (i >= 0) cur.splice(i, 1)
      else cur.push(v)
      // Sort offsets ascending and deduplicate, keeping the persisted form stable (scheduler and display share one source)
      const sorted = [...new Set(cur)].sort((a: any, b: any) => a - b)
      this.e.reminderOffsets = sorted
      this.queueSave({ reminderOffsets: sorted })
    },
    queueSave (patch) {
      clearTimeout(this._t)
      // Race protection: capture a snapshot of the task id at enqueue time; the callback commits to the task "at enqueue time" --
      // otherwise switching tasks within 350ms would write A's edits onto B (hydrate replaces this.e wholesale)
      const taskId = this.e && this.e.taskId
      this._t = setTimeout(async () => {
        if (!taskId) return
        this.saving = true
        try {
          const all = Object.assign({}, patch)
          if (this._dirtyFlags.subtasks) all.subtasks = JSON.stringify(this.subList)
          if (this._dirtyFlags.imgs) all.image = JSON.stringify(this.imgList)
          if (this._dirtyFlags.files) all.files = JSON.stringify(this.fileList)
          if (this._dirtyFlags.preds) all.predecessors = this.e.predecessors
          this._dirtyFlags = {}
          if (Object.keys(all).length) {
            await this.$store.dispatch('todo/updateTodoFields', { taskId, patch: all })
          }
          this.saveFailed = false
        } catch (e) {
          this.saveFailed = true
        } finally { this.saving = false }
      }, 350)
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
      clearTimeout(this._t)
      const all: any = {}
      if (this._dirtyFlags.subtasks) all.subtasks = JSON.stringify(this.subList)
      if (this._dirtyFlags.imgs) all.image = JSON.stringify(this.imgList)
      if (this._dirtyFlags.files) all.files = JSON.stringify(this.fileList)
      this._dirtyFlags = {}
      all.delete = false
      all.status = 'update'
      await this.$store.dispatch('todo/updateTodoFields', { taskId: this.e.taskId, patch: all })
      this.$message.success(this.$t('statsE.EditPanel.restoredMsg'))
      this.hydrate()
    },
    addSub () {
      const text = this.newSub.trim()
      if (!text || !this.e) return
      this.subList.push({ text, checked: false })
      this.newSub = ''
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
      } catch (err) { reportError('upload:' + f.name, err); this.$message.error(this.$t('statsE.EditPanel.uploadFailedMsg') + f.name) }
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
          diskTimer = setTimeout(() => { if (item.url) window.todoAPI.deleteFile(item.url) }, 5500)
        },
        () => {
          clearTimeout(diskTimer)
          this[arrName].splice(idx, 0, item)
          this.markDirty(arrName === 'imgList' ? 'imgs' : 'files')
          this.queueSave({})
        })
    },
    openFileUrl (f) { window.todoAPI.openFile(f.url) },
    markDirty (k) { this._dirtyFlags[k] = 1 },
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
    addPred (id) {
      if (!id || this.depPreds.includes(id)) return
      this.e.predecessors = JSON.stringify(this.depPreds.concat(id))
      this.depOpen = false
      this.markDirty('preds'); this.queueSave({})
    },
    rmPred (id) {
      this.e.predecessors = JSON.stringify(this.depPreds.filter(x => x !== id))
      this.markDirty('preds'); this.queueSave({})
    },
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
