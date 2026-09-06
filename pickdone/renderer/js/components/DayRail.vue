<template>

  <aside class="day-rail" :class="{ collapsed: railCollapsed }" :style="{ width: railCollapsed ? '48px' : '236px', padding: railCollapsed ? '26px 4px 10px' : '14px 12px 16px' }" :aria-label="$t('statsG.DayRail.label')" :title="railCollapsed ? $t('statsG.DayRail.label') : ''"
         v-bind="railCollapsed ? { role: 'button', tabindex: 0, 'aria-label': $t('statsG.DayRail.foldAria') } : {}"
         @click="onRailClick" @keydown.enter.prevent="railCollapsed && toggleRail()">
    <!-- Collapsed = whole rail is the expand button. Expanded = clicking blank areas (padding/slot gaps/hour labels)
         also collapses, so the gesture is symmetric; clicks on interactive content (fact segments, plan chips,
         entry card, the fact axis itself, controls) pass through untouched. While a pomodoro is running the
         rail never collapses on blank clicks (user-finalized 2026-09-06: the running block must stay visible). -->
    <!-- Collapse action = the whole header block is clickable + hover highlight (aligned with the sidebar brand-row approach, user-finalized); « is only a visual indicator -->
    <div class="dr-head" role="button" tabindex="0" :aria-expanded="!railCollapsed"
         :aria-label="$t('statsG.DayRail.foldAria')" @click.stop="toggleRail" @keydown.enter.prevent="toggleRail">
      <div class="dr-head__text">
        <b>{{ headLabel }}</b>
        <span>{{ $t('statsG.DayRail.hint') }}</span>
      </div>
      <i class="dr-fold-ico" aria-hidden="true"><app-icon name="chevron-left" :size="14"/></i>
    </div>
    <!-- Collapsed state = full-day miniature bar: same railSegs data, read-only display (click the whole bar to expand; pointer-events already disabled) -->
    <div v-if="railCollapsed" class="dr-mini" aria-hidden="true">
      <div class="dr-mini-rail">
        <i v-for="(s, si) in railSegs" :key="'m'+si" class="dr-seg" :style="s.style" :title="s.tip"></i>
      </div>
      <i v-for="t in miniTicks" :key="'t'+t.h" class="dr-mini-t" :style="{ top: t.top }">{{ t.h < 10 ? '0' + t.h : t.h }}</i>
      <i v-if="isViewingToday" class="dr-mini-now" :style="{ top: nowTopPct }"></i>
    </div>
    <div class="dr-track">
      <!-- Continuous fact axis: a single rail spans 0-24h, focus blocks are positioned by their real proportion of the day's minutes (user-finalized: replaces the per-slot broken bars) -->
      <div class="dr-rail" role="region" :aria-label="$t('statsG.DayRail.focus')" :title="$t('statsG.DayRail.createHint')"
           @click="openCreateAt($event)" @contextmenu.prevent="openCreateAt($event)">
        <i v-for="(s, si) in railSegs" :key="s.tomatoId || si" class="dr-seg" role="button" tabindex="0"
           :style="s.style" :title="s.tip" :aria-label="s.tip"
           @click.stop="openEntry(s)" @keydown.enter.prevent="openEntry(s)"
           @contextmenu.prevent.stop="openEntry(s)"
           @mouseenter="hoverTask(s.taskId)" @mouseleave="unhoverTask"
           @dragover.prevent.stop="onSegDragOver(s, $event)" @dragleave.stop="onSegDragLeave(s)"
           @drop.stop="onSegDrop(s, $event)" @dblclick.stop
           :class="{ 'pd-is-over': dragOverSeg === s.tomatoId, 'pd-is-dim': hoverTaskId && s.taskId !== hoverTaskId }"></i>
      </div>
      <!-- Entry card: unified correction panel for fact entries (start-end/duration/status/attachment/delete) -->
      <div v-if="entryDraft" class="dr-card" :style="{ top: cardTop }" @dblclick.stop @contextmenu.prevent.stop>
        <button class="close-x close-x--sm dr-card-x" :aria-label="$t('statsG.DayRail.cardEdit')" @click="entryDraft = null"></button>
        <b>{{ entryDraft.create ? $t('statsG.DayRail.cardCreate') : $t('statsG.DayRail.cardEdit') }}</b>
        <div class="dr-card-row"><span>{{ $t('statsG.DayRail.cardStart') }}</span>
          <el-time-picker size="small" format="HH:mm" :model-value="minToDate(entryDraft.startMin)"
                          :clearable="false" @update:model-value="v => { entryDraft.startMin = dateToMin(v) }"/></div>
        <div class="dr-card-row"><span>{{ $t('statsG.DayRail.cardFocusMin') }}</span>
          <el-input-number size="small" :model-value="entryDraft.dur" :min="1" :max="720" :step="5" controls-position="right"
                           @update:model-value="v => { entryDraft.dur = v }"/></div>
        <div v-if="entryDraft.succeed" class="dr-card-row"><span>{{ $t('statsG.DayRail.cardRestMin') }}</span>
          <el-input-number size="small" :model-value="entryDraft.rest" :min="0" :max="120" :step="5" controls-position="right"
                           @update:model-value="v => { entryDraft.rest = v }"/></div>
        <div class="dr-card-row"><span>{{ $t('statsG.DayRail.cardStatus') }}</span>
          <el-switch size="small" :model-value="entryDraft.succeed" @change="v => { entryDraft.succeed = v }"/>
          <em>{{ entryDraft.succeed ? $t('statsG.DayRail.cardSucceed') : $t('statsG.DayRail.cardGiveUp') }}</em></div>
        <div class="dr-card-row"><span>{{ $t('statsG.DayRail.cardTask') }}</span>
          <el-select size="small" :model-value="entryDraft.taskId || ''" clearable :placeholder="$t('statsG.DayRail.freeFocus')" @change="v => { entryDraft.taskId = v || '' }">
            <el-option v-for="t in taskOptions" :key="t.taskId" :label="t.taskContent" :value="t.taskId"/>
          </el-select></div>
        <div v-if="entryDraft.create" class="dr-card-hint">{{ $t('statsG.DayRail.cardPurpose') }}</div>
        <div class="dr-card-btns">
          <button class="dr-card-save" @click="saveEntry">{{ $t('statsG.DayRail.cardSave') }}</button>
          <button v-if="!entryDraft.create" class="dr-card-del" @click="deleteEntry">{{ $t('statsG.DayRail.cardDelete') }}</button>
        </div>
      </div>
      <div v-for="h in hours" :key="h" class="dr-slot" :data-vrange="h * 60 + ':60'"
           :class="{now:isNow(h), over:dragOverHour===h, plan:planHours.has(h)}"
           @dragover.prevent="onDragOver(h,$event)" @dragleave="onDragLeave(h)" @drop="onDrop(h,$event)">
        <i class="dr-h" :class="{ 'dr-h--now': isNow(h) }">{{ hourLabel(h) }}</i>
        <div class="dr-cells">
          <div v-for="p in (plansByHour[h]||[])" :key="'p-'+p.planId" class="dr-plan" draggable="true"
               :class="{'pd-is-active': isActivePlan(p), 'pd-is-dim': hoverTaskId && p.taskId !== hoverTaskId, 'pd-is-done': p.done }"
               :title="$t('statsG.DayRail.planTip')"
               @dragstart="onChipDragStart($event,p)" @dragend="onChipDragEnd" @dragover.prevent.stop="onDragOver(h,$event)"
               @drop.stop="onChipDrop(h,$event)"
               @contextmenu="taskContextMenu(p, $event)"
               @mouseenter="hoverTask(p.taskId)" @mouseleave="unhoverTask">
            <span class="dr-plan-chk" role="checkbox" :aria-checked="p.done ? 'true' : 'false'" :aria-label="$t('statsE.TodoItem.markComplete')"
                  tabindex="0" :class="{ done: p.done }" @click.stop="planDone(p)" @keydown.enter.prevent.stop="planDone(p)"></span>
            <!-- Exact minutes are already expressed by the hour slot's ticks; no repeated time inside the block (redundant info, user-finalized); with multiple instances per task the badge = the Nth estimated pomodoro -->
            <span class="dr-plan-name" role="button" tabindex="0"
                  :aria-label="$t('statsE.TodoItem.openEditor')" @click.stop="openTask(p)" @keydown.enter.prevent.stop="openTask(p)">{{ p.name }}<i v-if="p.count > 1" class="dr-plan-seq">{{ $t('statsG.DayRail.planSeq', { n: p.idx + 1 }) }}</i></span>
            <button class="dr-plan-tom" :class="{'pd-is-active': isActivePlan(p)}"
                    :title="$t('statsE.TodoItem.togglePomodoroFocus')" :aria-label="$t('statsE.TodoItem.togglePomodoroFocus')" @click.stop="planTomato(p)">
              <i class="ico" style="--ico:url('app://app/assets/img/icon-tomato-timer2.svg');width:12px;height:12px"></i>
            </button>
            <button class="dr-plan-x close-x close-x--sm" :aria-label="$t('statsG.DayRail.remove')" @click.stop="removePlan(p)"></button>
          </div>
        </div>
      </div>
      <!-- 24:00 closing tick: only display, to make the day visually complete; 24:00 already belongs to the next day, no drag/drop accepted -->
      <div class="dr-slot dr-slot--end" aria-hidden="true" data-vrange="1440:1">
        <i class="dr-h">24:00</i>
        <div class="dr-cells"></div>
      </div>
    </div>
  </aside>
</template>

<script lang="ts">
/** Today time rail (V2 timeline-style today page) -- left column vertical hour track:
 *  (1) Completed pomodoros/breaks land on the rail at their real times (data = tomato store records)
 *  (2) Pre-planning: dragging a todo from the right list onto the rail = "planned for around this time"; temporary, draggable to adjust, deletable
 *  Plan data lives in SQLite plan_chips rows (2026-09-03 root fix), all writes via utils/dayPlans.js atomic ops; bucketed by date, pruned outside [-7d,+31d] */
import { FMT, dayjs } from '../utils/core.js'
import { toggleCompleteWithUndo } from '../utils/completeAction.js'
import { taskContextMenu } from '../utils/taskMenu.js'
import * as dayPlans from '../utils/dayPlans.js'
const DAY_START_H = 0
const DAY_END_H = 23

/* Stable per-instance id: selection/drag-move/delete all anchor to that specific chip, not the taskId */
function planUid () { return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }

/* mm validity: a time string starting with a two-digit 00-23 hour (e.g. "15:00"/"09:30"); invalid entries are dropped outright to keep ghost data from persisting forever */
function validPlanMm (mm) { return typeof mm === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(mm) }

/* Three-generation format migration: string (one task one slot) → string array → instance objects {mm,id}; both restore paths (LS and DB meta) must go through here */
function migratePlansShape (d) {
  if (!d || typeof d !== 'object') return {}
  for (const day of Object.values(d)) {
    if (!day || typeof day !== 'object') continue
    for (const k of Object.keys(day)) {
      if (typeof day[k] === 'string') day[k] = [day[k]]
      if (Array.isArray(day[k])) {
        day[k] = day[k]
          .map(e => {
            const mm = typeof e === 'string' ? e : (e && e.mm)
            if (!validPlanMm(mm)) return null
            return { mm, id: (e && typeof e === 'object' && e.id) || planUid() }
          })
          .filter(Boolean)
      } else delete day[k]
    }
  }
  return d
}

/* V1 today page styles (time rail / row layout) -- injected inline, can be moved back to a css file later */
const V1_CSS = `
.today-v1 .today-body { display: flex; gap: 20px; align-items: flex-start; }
/* Main column stretch fills the column height: only then does the empty-day placeholder text have a "remaining empty area" to center in (style-3's min-height centering chain depends on this height) */
.today-v1 .today-main { flex: 1; min-width: 0; align-self: stretch; display: flex; flex-direction: column; }
.today-v1 .today-body .day-rail { width: 236px; flex-shrink: 0; position: sticky; top: 0; height: calc(100vh - 120px); display: flex; flex-direction: column; overflow-y: auto; transition: width .2s cubic-bezier(.2,.8,.2,1); }
/* Collapsed state = the whole rail is the expand button: no separate expand button; hover uses an outer edge line + a slight background tint to hint clickability */
.today-v1 .today-body .day-rail.collapsed { cursor: pointer; transition: border-color .15s, background .15s; }
.today-v1 .today-body .day-rail.collapsed:hover { border-color: var(--brand, #0f9d8f); background: var(--hover-bg, #fbfbfb); }
.day-rail.collapsed .dr-head, .day-rail.collapsed .dr-plan, .day-rail.collapsed .dr-blk, .day-rail.collapsed .dr-rail { display: none; }
.day-rail.collapsed .dr-track { flex: 0 0 auto; }
.day-rail.collapsed .dr-slot { min-height: 18px; padding: 1px 0; justify-content: center; flex: 0 0 auto; }
.day-rail.collapsed .dr-h { font-size: 8.5px; letter-spacing: -0.2px; pointer-events: none; }
.today-v1 .today-body .today-list { flex: 1; min-width: 0; }
/* —— Collapsed state = full-day miniature bar (design-final option 1): no shrunken 24-hour numbers; instead a focus-facts bar + current-time line + 5 reference ticks —— */
.today-v1 .today-body .day-rail.collapsed .dr-track { display: none; }
.day-rail.collapsed .dr-mini { display: block; cursor: pointer; }
.dr-mini { position: relative; flex: 1 1 auto; min-height: 480px; display: none; pointer-events: none; }
.dr-mini-rail { position: absolute; left: 24px; right: 8px; top: 0; bottom: 0; border-radius: 5px; background: var(--gray-bg, #f8f8f8); }
.dr-mini .dr-seg { min-height: 2px; }
/* Reference ticks: only 00/06/12/18/24 are labeled; other times are read against the current-time line and focus segments */
.dr-mini-t { position: absolute; left: 0; width: 17px; text-align: right; font-style: normal; font-size: 8.5px; line-height: 1; color: var(--text-3, #6d7278); font-variant-numeric: tabular-nums; transform: translateY(-50%); }
.dr-mini-now { position: absolute; left: 22px; right: 6px; height: 2px; border-radius: 1px; background: var(--brand, #0f9d8f); transform: translateY(-1px); box-shadow: 0 0 0 2px var(--panel, #fff); }
.day-rail { background: var(--panel, #fff); border: 1px solid var(--line, #f3f3f3); border-radius: var(--radius-lg, 10px); padding: 14px 12px 16px; }
.day-rail .dr-head { display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px 10px; border-bottom: 1px solid var(--line, #f3f3f3); flex-shrink: 0; cursor: pointer; border-radius: var(--radius-md, 8px); transition: background .15s; }
.day-rail.collapsed .dr-head:hover { background: var(--hover-bg, #fbfbfb); }
.day-rail .dr-head:focus-visible { outline: 2px solid var(--brand, #0f9d8f); outline-offset: -2px; }
.day-rail .dr-head__text { flex: 1; min-width: 0; }
.day-rail .dr-fold-ico { flex-shrink: 0; margin-top: 1px; color: var(--text-3, #6d7278); transition: color .15s; }
.day-rail.collapsed .dr-head:hover .dr-fold-ico { color: var(--brand, #0f9d8f); }
.day-rail .dr-head b { font-size: 13.5px; display: block; }
.day-rail .dr-head span { font-size: 11px; color: var(--text-3, #6d7278); line-height: 1.5; display: block; margin-top: 2px; }
/* Elastic timeline: with empty/few schedule entries the 24 slots split evenly to fill the available height; with many entries slots grow with content and scroll past one screen */
.day-rail .dr-track { flex: 1 1 auto; min-height: 480px; display: flex; flex-direction: column; }
/* Continuous fact axis: a single rail spans 0-24h, focus blocks are positioned by their real proportion of the day's minutes; hour rows give way on the left for the axis width */
.day-rail .dr-track { position: relative; }
.day-rail .dr-rail { position: absolute; left: 0; top: 0; bottom: 0; width: 10px; border-radius: 5px; background: var(--gray-bg, #f8f8f8); z-index: 1; }
.day-rail .dr-seg { position: absolute; left: 0; right: 0; background: var(--brand, #0f9d8f); min-height: 3px; cursor: pointer; z-index: 1; }
.day-rail .dr-seg:hover { filter: brightness(1.12); }
.day-rail .dr-seg.pd-is-dim { opacity: .3; }
/* Hovering a dragged task over a record segment: bold outline hints that dropping here re-corrects the link */
.day-rail .dr-seg.pd-is-over { outline: 2px solid var(--brand); outline-offset: 1px; filter: brightness(1.12); }
/* Fact lane reserved area: left padding = rail width 10px + 8px gap; planned content never intrudes into the fact track's territory */
.day-rail .dr-slot { display: flex; gap: 8px; align-items: flex-start; padding: 1px 0 1px 18px; min-height: 20px; flex: 1 0 auto; border-radius: 7px; }
/* Current-hour whole-block highlight (user-finalized: row-level; second round: whole block gets a plain weak background, drop the left bar — the bar made the highlight read as two elements; dashed form abandoned, dashes already belong to the drop-target language) */
.day-rail .dr-slot.now { background: color-mix(in srgb, var(--brand, #0f9d8f) 8%, transparent); }
.day-rail .dr-slot.over { outline: 1.5px dashed var(--brand); outline-offset: -1.5px; background: var(--brand-light, #e2f4f1); }
.day-rail .dr-h { width: 34px; text-align: right; font-style: normal; font-size: 11.5px; color: var(--text-3, #6d7278); font-variant-numeric: tabular-nums; line-height: 18px; flex-shrink: 0; }
.day-rail .dr-h--now { color: var(--brand-text, #0a6f62); font-weight: 600; }
.day-rail .dr-cells { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* Plan-A shell language unification: plan chips drop the dashed border (no dashed-container language anywhere in the project); switched to solid pastel pills = same language as the date/difficulty pills on the right */
.day-rail .dr-plan { display: flex; align-items: center; gap: 6px; font-size: 10.5px; border: 1px solid transparent; background: color-mix(in srgb, var(--brand, #0f9d8f) 10%, transparent); color: var(--brand-text, #0a6f62); border-radius: 6px; padding: 2px 6px; cursor: grab; }
.day-rail .dr-plan-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Multi-instance badge: the Nth estimated pomodoro (one task can have multiple chips) */
.day-rail .dr-plan-seq { font-style: normal; margin-left: 4px; flex-shrink: 0; font-size: 9.5px; font-weight: 600; }
.day-rail .dr-plan-x { margin-left: auto; } /* Visuals (X shape/hover danger) are owned by the unified close-x system */
.day-rail .dr-plan-chk { width: 12px; height: 12px; flex-shrink: 0; border: 1.5px solid currentColor; border-radius: 50%; background: transparent; cursor: pointer; padding: 0; position: relative; opacity: .8; }
.day-rail .dr-plan-chk:hover { opacity: 1; background: var(--hover-bg, rgba(255,255,255,.35)); }
.day-rail .dr-plan-tom { border: 0; background: none; color: inherit; cursor: pointer; display: inline-flex; padding: 1px; border-radius: 4px; opacity: .75; }
.day-rail .dr-plan-tom:hover, .day-rail .dr-plan-tom.pd-is-active { opacity: 1; background: color-mix(in srgb, var(--brand, #0f9d8f) 16%, transparent); }
/* Selected state (2026-09-02 second-round final): dropped solid brand teal + white text (white text clashed on dark backgrounds / white-block hover overlay was incoherent),
   switched to the pill's own language: "brand outline + 18% tint + bold" — same color family as the normal state with just more intensity, works in both light and dark themes */
.day-rail .dr-plan.pd-is-active { background: color-mix(in srgb, var(--brand, #0f9d8f) 18%, transparent); color: var(--brand-text, #0a6f62); border: 1px solid var(--brand, #0f9d8f); font-weight: 600; }
.day-rail .dr-plan.pd-is-dim { opacity: .35; }
/* Completed scheduling: filled check + strikethrough name; the block stays draggable — a plan's completion is a receipt, not a reason to delete (user-finalized) */
.day-rail .dr-plan.pd-is-done { opacity: .72; }
.day-rail .dr-plan .dr-plan-chk.done { background: var(--brand, #0f9d8f); opacity: 1; }
.day-rail .dr-plan.pd-is-done .dr-plan-name { text-decoration: line-through; }
.day-rail .dr-plan .dr-plan-name { cursor: pointer; }
.day-rail .td-tomcount, .td-tomcount { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--danger-strong, #d9534f); background: var(--danger-soft, #fef0f0); border-radius: 6px; padding: 1.5px 7px; font-variant-numeric: tabular-nums; }
/* Today capacity band: day = a budget sheet — denominator = total estimated tomatoes for today's + overdue incomplete, numerator = invested today */
/* Tomato ledger: progress pips (invested = solid brand color) + numeric ledger 2/4 — list item = unit of outcome, tomato = currency of work (design-final) */
.td-tom-pips { display: inline-flex; gap: 2px; align-items: center; }
.td-tom-pips i { width: 5px; height: 5px; border-radius: 50%; background: var(--line, #f3f3f3); }
.td-tom-pips i.done { background: var(--brand, #0f9d8f); }
.td-tom-n { font-weight: 600; }
/* Entry card: unified correction panel for fact entries (single-click block / double-click or right-click empty rail to summon), minute-level editing */
.day-rail .dr-card-hint { font-size: 10.5px; color: var(--text-4, #c0c4cc); line-height: 1.5; }
.day-rail .dr-card { position: absolute; left: 18px; right: 6px; z-index: 30; background: var(--panel, #fff); border: 1px solid var(--line, #f3f3f3); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; font-size: 11px; }
.day-rail .dr-card > b { font-size: 12px; padding-right: 18px; }
.day-rail .dr-card-x { position: absolute; top: 8px; right: 8px; }
.day-rail .dr-card-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.day-rail .dr-card-row > span { width: 60px; flex-shrink: 0; color: var(--text-2, #606266); font-size: 11px; }
.day-rail .dr-card-row .el-time-picker, .day-rail .dr-card-row .el-input-number, .day-rail .dr-card-row .el-select { flex: 1; min-width: 0; }
.day-rail .dr-card-row em { font-style: normal; color: var(--text-3, #6d7278); }
.day-rail .dr-card-btns { display: flex; gap: 8px; margin-top: 2px; }
.day-rail .dr-card-btns button { flex: 1; border: 0; border-radius: 6px; padding: 4px 0; font: inherit; cursor: pointer; }
.day-rail .dr-card-save { background: var(--brand, #0f9d8f); color: var(--brand-contrast, #fff); }
.day-rail .dr-card-save:hover { filter: brightness(1.1); }
.day-rail .dr-card-del { background: var(--danger-soft, #fef0f0); color: var(--danger-strong, #d9534f); }
.day-rail .dr-card-del:hover { background: var(--danger-strong, #d9534f); color: var(--brand-contrast, #fff); }
/* Cross-highlight: list row of the task hovered on the fact lane (brand left accent, same visual family as seg outline) */
.today-v1 .td-item.pd-hoverlink { box-shadow: inset 3px 0 0 var(--brand, #0f9d8f); background: var(--hover-bg, #fbfbfb); }
.today-v1 .pd-task-item { padding-top: 9px; padding-bottom: 9px; }
.today-v1 .pd-task-item .td-check { border-radius: 50%; width: 19px; height: 19px; }
.today-v1 .pd-task-item .pd-task-title { font-size: 14.5px; }
`;
function injectV1Style () {
  if (document.getElementById('today-v1-style')) return
  const el = document.createElement('style')
  el.id = 'today-v1-style'
  el.textContent = V1_CSS
  document.head.appendChild(el)
}

export default {
  name: 'DayRail',
  data: () => ({ plans: {}, dragOverHour: -1, dragOverSeg: null, axisPx: null, entryDraft: null, activePlanId: null, nowH: new Date().getHours(), nowTs: Date.now(), railCollapsed: localStorage.getItem('dayRailCollapsed') === '1' }),
  async mounted () {
    injectV1Style()
    // Storage-layer root fix (2026-09-03): chips = SQLite plan_chips rows, reads = planAll atomic read, writes = atomic ops (see dayPlans.js).
    // Mounted load with backoff retry (the bridge/library may not be ready at startup); the LS snapshot is a one-time fallback import only and never participates afterward.
    for (let i = 0; i < 6; i++) {
      if (this.$.isUnmounted) return // 卸载守卫:Vue3 普通卸载不清空 $el,$el===null 恒不触发;$.isUnmounted 在 unmount 时同步置真(复核 P1)
      try {
        await dayPlans.importLegacyOnce()
        this.plans = migratePlansShape(await dayPlans.allPlans())
        break
      } catch (e) {
        await new Promise(r => setTimeout(r, 400 * (i + 1)))
      }
    }
    // Crossing midnight: the tick refreshes both the hour highlight and the "today" key -- today is a plain non-reactive function,
    // without going through the tick the whole rail would freeze on the previous day's bucket after midnight
    this._tick = setInterval(() => {
      this.nowH = new Date().getHours()
      this.nowTs = Date.now()
    }, 60000)
    // Measure the rail height: CSS constants (100vh-N) cannot cover the real height taken by the app shell + page header,
    // any hardcoded constant overflows on one side; use the scroll container's clientHeight; sticky top stays 0 so the pinned position equals the flow position (a nonzero threshold made the rail jump on view switches)
    this.fitRail()
    this._fitTimer = setInterval(() => { this.fitRail(); this.measureAxis() }, 2000)
    window.addEventListener('resize', this._onResize = () => { this.fitRail(); this.measureAxis() })
    this.$nextTick(() => this.measureAxis())
    // Cross-component linkage: store (schedule/calendar/edit panel) reschedules/removes/deletes a task → dayPlans.js broadcast → timeline reloads in real time
    window.addEventListener('day-plans-changed', this._onPlansChanged = async () => {
      try { this.plans = migratePlansShape(await dayPlans.allPlans()) } catch { /* Keep current state */ }
    })
    // Cross-window: chips written by other windows/CLI come via the main process todos-changed broadcast
    if (window.todoAPI.onTodosChanged) {
      this._offTodosChanged = window.todoAPI.onTodosChanged(() => { try { this._onPlansChanged() } catch {} })
    }
    // Expired day-bucket cleanup (db atomic op, idempotent): [-7d,+31d] window; planning the future is a finalized feature, so only expired buckets are pruned, never future ones
    setTimeout(() => { try { this.prune() } catch {} }, 5000)
    // 渐进折叠(2026-09-03 用户定稿): minWidth 放开到 750 的代价——窗口 <1140 时自动折叠抽屉
    // (日期条视图切换行单行需要 614px,抽屉展开时最坏组合 1140 才放得下);加宽回 ≥1140 恢复进入前的偏好。
    // 侧栏 <920 有自己的折叠断点,两级递进:先折抽屉、再折侧栏。手动收起的(_railAutoFolded=false)加宽后不弹开。
    this._railNarrowMql = window.matchMedia('(max-width: 1139px)')
    this._onRailNarrow = e => {
      if (e.matches) {
        if (!this.railCollapsed) { this._railAutoFolded = true; this.setRailCollapsed(true) }
      } else if (this._railAutoFolded && this.railCollapsed) {
        this._railAutoFolded = false
        this.setRailCollapsed(false)
      }
    }
    if (this._railNarrowMql.matches && !this.railCollapsed) { this._railAutoFolded = true; this.setRailCollapsed(true) }
    if (this._railNarrowMql.addEventListener) this._railNarrowMql.addEventListener('change', this._onRailNarrow)
    else this._railNarrowMql.addListener(this._onRailNarrow)
  },
  beforeUnmount () {
    clearInterval(this._tick)
    clearInterval(this._fitTimer)
    window.removeEventListener('resize', this._onResize)
    window.removeEventListener('day-plans-changed', this._onPlansChanged)
    if (this._offTodosChanged) this._offTodosChanged()
    if (this._railNarrowMql) {
      if (this._railNarrowMql.removeEventListener) this._railNarrowMql.removeEventListener('change', this._onRailNarrow)
      else this._railNarrowMql.removeListener(this._onRailNarrow)
    }
    // On unmount the pointer will never produce another mouseleave:hover highlight write to the global store; without clearing it would pollute unrelated task rows in the next view
    this.$store.commit('ui/setHoverTask', '')
  },
  computed: {
    /* Type-level bridge for the dr-rail :style binding; wraps the same value the template previously passed */
    hours () {
      const list = []
      for (let h = DAY_START_H; h <= DAY_END_H; h++) list.push(h)
      return list
    },
    /* Follow the right column's date strip (user-finalized): the time rail shows the selected day, not just today — can review history / plan the future */
    selTs () { return this.$store.state.ui.daySelectedTs || +dayjs().startOf('day') },
    isViewingToday () { return this.selTs === +dayjs().startOf('day') },
    headLabel () {
      if (this.isViewingToday) return this.$t('statsA.core.today')
      const d = dayjs(this.selTs)
      if (this.selTs === +dayjs().subtract(1, 'day').startOf('day')) return this.$t('statsA.core.yesterday')
      if (this.selTs === +dayjs().add(1, 'day').startOf('day')) return this.$t('statsA.core.tomorrow')
      return this.$t('statsA.core.calMd', { m: d.month() + 1, d: d.date(), w: this.$t('statsA.core.weekOf', { w: this.$t('statsA.core.wd' + d.day()) }) })
    },
    today () { void this.nowTs; void this.selTs; return dayjs(this.selTs).format(FMT.date) },
    hoverTaskId () { return this.$store.state.ui.hoverTaskId },
    /* Entry card's owning-task candidates: today's (including due-today) incomplete first */
    cardTop () {
      if (!this.entryDraft) return '0%'
      return (Math.max(2, Math.min(68, this.entryDraft.startMin / 1440 * 100))) + '%'
    },
    taskOptions () {
      const today = this.today
      const cands = this.$store.state.todo.todoList.filter(t => {
        if (t.delete) return false
        return t.dayStart === today || (t.todoTime ? dayjs(t.todoTime).format(FMT.date) === today : false)
      })
      const rank = t => (t.complete ? 1 : 0)
      return cands.sort((a, b) => rank(a) - rank(b))
    },
    /* Fact layer (energy bar): today's focus records -> sliced by hour, positioned precisely to the minute with percentages within a segment.
       Separated from the plan layer on the right: records are read-only (hover for details / click to jump to the task), plans are draggable and deletable */
    railSegs () {
      /* Focus fact blocks are positioned on the whole continuous axis: top/height = the real proportion of the day's 1440 minutes (25 minutes is 25/1440, undistorted by slot compression) */
      const segs = []
      const base = this.selTs
      // 按专注体时间段与当天 1440 分钟窗口求交集取数(2026-09-04 二轮深审 P1:dateKey 已统一=endTime 所在日,
      // 跨午夜记录(23:50-00:15)的 dateKey 属次日,按 dateKey 桶取数会让它从当天 rail 凭空消失、在次日 rail 顶部显示成错误时长残段)
      const dayStart = Number(this.selTs) || 0
      const dayEnd = dayStart + 1440 * 60000
      for (const r of (this.$store.state.tomato.tomatoRecordList || [])) {
        const rend = Number(r.endTime) || 0
        const rdur = Number(r.focusDuration || 0)
        if (!rend || !rdur) continue
        const rstart = rend - rdur * 60000
        if (rstart >= dayEnd || rend <= dayStart) continue
        // Unattached focuses are also facts and must go on the rail (user feedback: chain visibility); tips show the free-focus placeholder
        const end = Number(r.endTime) || 0
        const dur = Number(r.focusDuration || 0)
        // Tomato atomic block: success = full focus + rest duration (standard 25+5=30); give-up has no rest, only the actual focus segment is drawn
        const abandoned = r.succeed === false
        const rest = abandoned ? 0 : Number(r.restDuration || 0)
        const startTs = end - dur * 60000
        const blockEndTs = end + rest * 60000
        const task = r.focusTaskId && this.taskById.get(r.focusTaskId)
        // Semantic colors: give-up = danger color; category color takes priority, brand teal when uncategorized (sense of harvest); gray is reserved for free focus unlinked from tasks
        const segColor = abandoned
          ? 'var(--danger-strong, #d9534f)'
          : (task ? ((task.categoryId && this.catColorById.get(task.categoryId)) || 'var(--brand, #0f9d8f)') : 'var(--text-4, #c0c4cc)')
        const tip = this.$t('statsG.DayRail.focus') + ' ' + dayjs(startTs).format('HH:mm') + ' – ' + dayjs(blockEndTs).format('HH:mm') + (task ? ' · ' + task.taskContent : ' · ' + this.$t('statsG.DayRail.freeFocus')) + (abandoned ? ' · ' + this.$t('statsG.DayRail.giveUpTag') : '') + (r.manual ? ' · ' + this.$t('statsG.DayRail.manualTag') : '')
        const startMin = (startTs - base) / 60000
        const endMin = (blockEndTs - base) / 60000
        const from = Math.max(0, Math.min(startMin, 1440))
        const to = Math.max(0, Math.min(endMin, 1440))
        if (to <= from) continue
        if (!this.axisPx) {
          // Collapsed mini rail = whole-day proportional container, positioned by 1440-minute percentages (expanded state not yet measured on first frame stays empty awaiting re-measure)
          if (this.railCollapsed) {
            segs.push({
              style: { top: (from / 1440 * 100) + '%', height: Math.max(0.2, (to - from) / 1440 * 100) + '%', background: segColor },
              tip, taskId: r.focusTaskId, tomatoId: r.tomatoId
            })
          }
          return segs // Expanded state not yet measured; re-rendered by the watcher/timer after measurement
        }
        const yFrom = this.segY(from)
        const yTo = this.segY(to)
        segs.push({
          style: { top: yFrom + 'px', height: Math.max(3, yTo - yFrom) + 'px', background: segColor },
          tip, taskId: r.focusTaskId, tomatoId: r.tomatoId
        })
      }
      return segs
    },
    /* Today's plans -> bucketed by hour [{taskId, mm, planId, idx, count, name, done}]; multiple instances per task = multiple estimated pomodoros */
    plansByHour () {
      const map = {}
      const day = this.plans[this.today] || {}
      for (const [taskId, arr] of Object.entries(day)) {
        const list = Array.isArray(arr) ? arr : []
        const t = this.$store.state.todo.todoList.find(x => x.taskId === taskId)
        list.forEach((e, idx) => {
          const h = parseInt(String(e.mm).split(':')[0], 10)
          if (isNaN(h)) return
          if (!map[h]) map[h] = []
          map[h].push({ taskId, mm: e.mm, planId: e.id, idx, count: list.length, name: t ? t.taskContent : taskId, done: !!(t && t.complete) })
        })
      }
      return map
    },
    planHours () {
      const set = new Set()
      for (const h of Object.keys(this.plansByHour)) set.add(Number(h))
      return set
    },
    /* Category color quick lookup: used to color record segments by their task's category */
    catColorById () {
      const cats = this.$store.state.category.list || []
      return new Map(cats.map(c => [c.categoryId, c.categoryColor]))
    },
    /* Reference ticks (00/06/12/18/24) of the collapsed mini rail + current-time position percentage */
    miniTicks () { return [0, 6, 12, 18, 24].map(h => ({ h, top: h / 24 * 100 + '%' })) },
    nowTopPct () { void this.nowTs; return this.nowMinutes() / 1440 * 100 + '%' },
    taskById () {
      const m = new Map()
      for (const t of this.$store.state.todo.todoList) m.set(t.taskId, t)
      return m
    }
  },
  watch: {
    /* Row height changes as plans are added/removed: re-measure once the DOM settles */
    plansByHour: { handler () { this.$nextTick(() => this.measureAxis()) }, deep: true }
  },
  methods: {
    taskContextMenu (t, e) { taskContextMenu(this, t, e, { move: false, tomato: false }) },
    /* Cross-highlight: hovering a fact block or a plan chip highlights everything of that task (list rows react via ui.hoverTaskId) */
    hoverTask (id) { this.$store.commit('ui/setHoverTask', id) },
    unhoverTask () { this.$store.commit('ui/setHoverTask', '') },
    /* Measured axis: row heights are uneven due to plan content/min-height; segment pixels interpolate from the actually rendered rows (data-vrange = the row's virtual minute range); fitRail timer + plansByHour watcher keep it fresh */
    measureAxis () {
      if (!this.$el) return
      // Collapsed state: don't measure and clear stale values: the mini rail (dr-mini) is a whole-day proportional container; reusing expanded-state pixel positioning would misalign and never self-correct while collapsed
      if (this.railCollapsed) { this.axisPx = null; return }
      const map = []
      this.$el.querySelectorAll('[data-vrange]').forEach(el => {
        const parts = el.dataset.vrange.split(':')
        const v0 = Number(parts[0]); const vLen = Number(parts[1])
        map.push({ v0, v1: v0 + vLen, y0: el.offsetTop, y1: el.offsetTop + el.offsetHeight })
      })
      if (map.length) this.axisPx = map
    },
    segY (min) {
      const v = Math.max(0, Math.min(1440, min))
      for (const m of (this.axisPx || [])) {
        if (v >= m.v0 && v <= m.v1) return m.y0 + (m.v1 > m.v0 ? (v - m.v0) / (m.v1 - m.v0) : 0) * (m.y1 - m.y0)
      }
      return 0
    },
    hourLabel (h) { return String(h).padStart(2, '0') + ':00' },
    toggleRail () {
      this.setRailCollapsed(!this.railCollapsed)
    },
    /** 展开态点空白处收起:命中任何交互内容(事实段/计划芯片/编辑卡/事实轴/控件/头部)都不算空白 */
    onRailClick (e) {
      if (this.railCollapsed) { this.toggleRail(); return }
      if (e.target.closest('.dr-seg, .dr-card, .dr-plan, .dr-plan-chk, .dr-plan-name, .dr-plan-tom, .dr-rail, .dr-head, button, input, select, textarea, a, [role="button"]')) return
      if (this.$store.state.tomato.status === 'startTomatoTime') return // 番茄运行中不收起(保持当前专注块可见)
      this.setRailCollapsed(true)
    },
    setRailCollapsed (v) {
      this.railCollapsed = v
      try { localStorage.setItem('dayRailCollapsed', v ? '1' : '0') } catch (e) { /* ignore on quota exceeded */ }
      // The inline height takes precedence over the CSS collapsed height:auto, so it must be re-measured on toggle (both directions)
      // measureAxis runs in the same pass: at the instant of expanding, axisPx still holds the pre-collapse old value (or null); without re-measuring, fact segments misalign / flash empty for up to 2 seconds
      this.$nextTick(() => { this.fitRail(); this.measureAxis() })
    },
    /* Measure the rail height: CSS constants (100vh-N) cannot cover the real height taken by the app shell + page header; use the scroll container's actual height (collapsed state included: the mini rail stretches with flex) */
    fitRail () {
      const rail = this.$el
      if (!rail) return
      const sc = rail.closest('.main-scroll') || rail.parentElement
      const h = sc.clientHeight - 8
      if (h > 200) rail.style.height = h + 'px'
    },
    isNow (h) { return this.isViewingToday && h === this.nowH },
    onDragOver (h, e) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      this.dragOverHour = h
    },
    onDragLeave (h) { if (this.dragOverHour === h) this.dragOverHour = -1 },
    /* List row dragged in -> lands on the hour of the drop point; dragging the same task in again = append one more estimated pomodoro instance (one task can have multiple chips) */
    onDrop (h, e) {
      e.preventDefault()
      this.dragOverHour = -1
      const taskId = e.dataTransfer.getData('text/plain')
      if (!taskId) return
      const t = this.taskById.get(taskId)
      if (!t) return
      const day = this.plans[this.today] || (this.plans[this.today] = {})
      const mm = this.hourLabel(h).slice(0, 2) + ':00'
      const move = this._dragPlan
      this._dragPlan = null
      // On write failure (lock screen/library busy), read back with the library as source of truth, eliminating drift between optimistic UI and the library (async errors can't be caught by sync try/catch)
      const resync = () => this._onPlansChanged()
      if (move && move.taskId === taskId && Array.isArray(day[taskId])) {
        day[taskId].splice(move.idx, 1, { mm, id: move.planId }) /* In-rail chip drag = move that instance (id unchanged) */
        dayPlans.updateChip(move.planId, this.today, mm).catch(resync)
      } else if (Array.isArray(day[taskId])) {
        const id = planUid()
        day[taskId].push({ mm, id }) /* Second drop = append */
        dayPlans.addChips([{ taskId, day: this.today, mm, id }]).catch(resync)
      } else {
        const id = planUid()
        day[taskId] = [{ mm, id }]
        dayPlans.addChips([{ taskId, day: this.today, mm, id }]).catch(resync)
      }
    },
    /* Drag within the rail to reschedule (instance-level: carries idx so drop moves instead of appending) */
    onChipDragStart (e, p) {
      this._dragPlan = p
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', p.taskId)
    },
    onChipDrop (h, e) {
      e.stopPropagation()
      /* The dragged item's identity is whatever _dragPlan recorded at drag start (chips record it; list rows dragged in are null = create new);
         dropping onto an existing chip only determines the time — never mistake the dropped-on chip for the dragged item (otherwise same-task in-place replacement = looks like nothing was added) */
      this.onDrop(h, e)
    },
    onChipDragEnd () { this._dragPlan = null },
    removePlan (p) {
      const day = this.plans[this.today]
      if (day && Array.isArray(day[p.taskId])) {
        const i = day[p.taskId].findIndex(e => e.id === p.planId) // Delete by planId (idx may have drifted due to async reloads)
        if (i >= 0) day[p.taskId].splice(i, 1)
        if (!day[p.taskId].length) delete day[p.taskId]
        dayPlans.removeChips([p.planId]).catch(() => this._onPlansChanged())
      }
    },
    /* Consistent plan-chip interactions: check to complete (reusing the undo chain) / select to start (tomato attach) / click the name to open the edit panel */
    planDone (p) {
      const t = this.taskById.get(p.taskId)
      if (!t) { this.removePlan(p); return }
      // After completion the plan stays on the rail (completed style, still draggable) — it's the receipt that "a user-planned task was completed"; it shouldn't vanish (user-finalized)
      toggleCompleteWithUndo({ store: this.$store, message: this.$message, todo: t, announce: this.$announce })
    },
    /* Selection anchored to a specific instance: focus started from this chip lights up this one; when attach came from elsewhere (e.g. a list row), fall back to lighting the first one */
    isActivePlan (p) {
      const at = this.$store.state.tomato.attachTodo
      if (!at || at.taskId !== p.taskId) return false
      const ids = (this.plans[this.today][p.taskId] || []).map(x => x.id)
      if (this.activePlanId && ids.includes(this.activePlanId)) return p.planId === this.activePlanId
      return p.idx === 0
    },
    planTomato (p) {
      const st = this.$store.state.tomato
      const detaching = st.attachTodo && st.attachTodo.taskId === p.taskId && this.isActivePlan(p)
      this.activePlanId = detaching ? null : p.planId
      this.$store.dispatch('tomato/attach', detaching ? null : p.taskId)
    },
    openTask (p) {
      const t = this.taskById.get(p.taskId)
      if (t) this.$store.commit('ui/openEdit', t)
    },
    /* Record segment click/right-click = change the linked task: the menu lists today's tasks (current link pinned and checked), rather than opening the task editor */
    changeLinkedTask (s, e) {
      if (e && e.preventDefault) e.preventDefault()
      const items = []
      const cur = s.taskId && this.taskById.get(s.taskId)
      const today = this.today
      const cands = this.$store.state.todo.todoList.filter(t => {
        if (t.delete) return false
        return t.taskId === s.taskId || t.dayStart === today || (t.todoTime ? dayjs(t.todoTime).format(FMT.date) === today : false)
      })
      // Incomplete first, the rest in stable list order; the currently linked task is kept in the list regardless
      const rank = t => (t.complete ? 1 : 0)
      cands.sort((a, b) => rank(a) - rank(b))
      if (cur && !cands.some(t => t.taskId === cur.taskId)) cands.unshift(cur)
      const MENU_CAP = 12
      for (const t of cands.slice(0, MENU_CAP)) {
        const isCur = t.taskId === s.taskId
        items.push({
          icon: isCur ? 'check' : 'timer',
          label: (t.taskContent || this.$t('statsE.TodayView.untitled')) + (isCur ? ' · ' + this.$t('statsG.DayRail.curLink') : ''),
          fn: () => {
            this.$store.commit('tomato/updateRecordTask', { tomatoId: s.tomatoId, focusTaskId: isCur ? s.taskId : t.taskId })
            // Menu commit shares the seg-drop feedback (silent before; consolidated 2026-09-01)
            if (!isCur) this.$message.success(this.$t('statsG.DayRail.relinked', { n: t.taskContent || this.$t('statsE.TodayView.untitled') }))
          }
        })
      }
      if (s.taskId) {
        items.push({ sep: true })
        items.push({
          icon: 'x', danger: true,
          label: this.$t('statsG.DayRail.unlink'),
          fn: () => {
            this.$store.commit('tomato/updateRecordTask', { tomatoId: s.tomatoId, focusTaskId: null })
            this.$message.success(this.$t('statsG.DayRail.unlinkedToast'))
          }
        })
      }
      if (!items.length) return
      this.$store.commit('ui/openMenu', { x: e.clientX + 2, y: e.clientY + 2, items })
    },
    /* Entry card unified entry: single-click block = edit; double-click/right-click empty rail = backfill at this moment; start/end precise to the minute, no more snapping to whole hours */
    minToHHmm (m) { const v = Math.max(0, Math.min(1439, Math.round(m))); return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0') },
    minToDate (m) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setMinutes(Math.max(0, Math.min(1439, Math.round(m)))); return d },
    dateToMin (d) { if (!(d instanceof Date)) return 0; return d.getHours() * 60 + d.getMinutes() },
    hhmmToMin (v) { const p = String(v || '').split(':'); const m = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); return Math.max(0, Math.min(1439, m)) },
    railMinuteFromEvent (e) {
      const rail = this.$el.querySelector('.dr-rail')
      const r = rail.getBoundingClientRect()
      return Math.round(Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * 1439)
    },
    openEntry (s) {
      const rec = (this.$store.state.tomato.tomatoRecordList || []).find(r => r && r.tomatoId === s.tomatoId)
      if (!rec) return
      const dur = Number(rec.focusDuration || 0)
      const startMin = ((Number(rec.endTime) - dur * 60000) - this.selTs) / 60000
      this.entryDraft = {
        create: false, tomatoId: rec.tomatoId,
        startMin: Math.max(0, Math.min(1439, Math.round(startMin))),
        dur, rest: Number(rec.restDuration || 0),
        succeed: rec.succeed !== false, taskId: rec.focusTaskId || '', manual: !!rec.manual
      }
    },
    openCreateAt (e) {
      if (e && e.stopPropagation) e.stopPropagation()
      // Start = click position (minute-level); only today is subject to the "can't backfill into the future" constraint; historical dates allow backfilling at any time
      let startMin = this.railMinuteFromEvent(e)
      if (this.isViewingToday && startMin > this.nowMinutes() - 1) startMin = Math.max(0, this.nowMinutes() - 30)
      this.entryDraft = { create: true, tomatoId: null, startMin, dur: 25, rest: 5, succeed: true, taskId: '', manual: true }
    },
    nowMinutes () { const n = new Date(); return n.getHours() * 60 + n.getMinutes() },
    saveEntry () {
      const d = this.entryDraft
      if (!d) return
      const base = this.selTs
      const startTs = base + d.startMin * 60000
      const endTs = startTs + Math.max(1, d.dur) * 60000
      if (d.create) {
        this.$store.commit('tomato/addRecord', {
          // 随机尾:同分钟同时长补两条(合法场景)不再被幂等去重静默吞(与 TaskAccountModal 同款修复,dateKey 由 update/append 层按 endTime 重导)
          tomatoId: 'tmt_m_' + startTs + '_' + d.dur + '_' + Math.random().toString(36).slice(2, 7), endTime: endTs,
          dateKey: dayjs(startTs).format(FMT.date),
          focus: '', focusTaskId: d.taskId || null, focusDuration: d.dur,
          rest: d.succeed ? d.rest : 0, restDuration: d.succeed ? d.rest : 0,
          succeed: d.succeed, status: 'local', manual: true
        })
        this.$message.success(this.$t('statsG.DayRail.cardCreated'))
      } else {
        this.$store.commit('tomato/updateRecord', { tomatoId: d.tomatoId, patch: { endTime: endTs, focusDuration: d.dur, restDuration: d.succeed ? d.rest : 0, succeed: d.succeed } })
        this.$store.commit('tomato/updateRecordTask', { tomatoId: d.tomatoId, focusTaskId: d.taskId || null })
        this.$message.success(this.$t('statsG.DayRail.cardSaved'))
      }
      this.entryDraft = null
    },
    deleteEntry () {
      const d = this.entryDraft
      if (!d || d.create) return
      this.$confirm(this.$t('statsG.DayRail.cardDeleteConfirm'), this.$t('statsG.DayRail.cardDelete'), { type: 'warning' })
        .then(() => {
          if (this.$.isUnmounted) return // View switched and unmounted while the dialog was pending: after confirm, no longer delete the record in a context we've left
          this.$store.commit('tomato/removeRecord', d.tomatoId)
          this.$message.success(this.$t('statsG.DayRail.cardDeleted'))
          this.entryDraft = null
        }).catch(() => {})
    },
    /* Dropping a task onto a record segment = correct that focus record's linked task (time/duration untouched) */
    onSegDragOver (s, e) {
      e.dataTransfer.dropEffect = 'move'
      this.dragOverSeg = s.tomatoId
    },
    onSegDragLeave (s) { if (this.dragOverSeg === s.tomatoId) this.dragOverSeg = -1 },
    onSegDrop (s, e) {
      this.dragOverSeg = -1
      const taskId = e.dataTransfer.getData('text/plain')
      const t = taskId && this.taskById.get(taskId)
      if (!t) return
      this.$store.commit('tomato/updateRecordTask', { tomatoId: s.tomatoId, focusTaskId: taskId })
      this.$message.success(this.$t('statsG.DayRail.relinked', { n: t.taskContent || this.$t('statsE.TodayView.untitled') }))
    },
    prune () {
      // Keep plan buckets in the window [today-7d, today+31d]: planning the future is a finalized feature; only prune expired, never delete future
      const keep = new Set()
      const dayjs = window.dayjs
      for (let i = -31; i <= 7; i++) keep.add(dayjs().subtract(i, 'day').format(FMT.date))
      let dirty = false
      for (const k of Object.keys(this.plans)) {
        if (!keep.has(k)) { delete this.plans[k]; dirty = true }
      }
      if (dirty) { try { dayPlans.pruneDays([...keep]) } catch {} }
    }
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* ============ 今日待办日期速选条（设计稿 todo-date-selector） ============ */
/* 方案A(用户定稿):日期条通栏,右端挂视图切换(pd-view-seg 走 #append 插槽) */
.today-v1 .day-strip { width: 100%; }
.today-v1 .day-strip .pd-view-seg { margin-left: auto; }
/* 窄窗(<920)下日期条内容超出行宽,允许换行让视图切换器落到第二行,否则第三个切换钮被主列右缘裁掉一半,真实点击落不进去(隔离冒烟实例 820px 宽实测) */
.today-v1 .day-strip { flex-wrap: wrap; row-gap: 6px; }
/* cal-today-btn 不入 ghost 范式:置灰/隐藏两版用户都读成"没有按钮",终版=恒常显(今天在视图时点击为无害no-op) */

/* ===== 今日页空态居中:无安排的选中日,插画+文案在工具栏下的空牌区域垂直居中(用户定稿) ===== */
/* min-height 链(非 height)保证长列表滚动行为不变;flex 链只在 :has(.empty-state) 时才产生居中效果 */
.pd-view-page.today-v1 { min-height: 100%; display: flex; flex-direction: column; }
.today-v1 .today-body { flex: 1; display: flex; align-items: stretch; }
.today-v1 .today-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.today-v1 .today-list { flex: 1; display: flex; flex-direction: column; }
.today-v1 .today-list .td-groups:has(.empty-state) { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.today-v1 .today-list .empty-state { padding: 0; }
.day-strip {
  position: relative; /* 日历弹窗 .ds-cal-pop 的定位锚点 */
  display: flex; align-items: center; gap: var(--space-1);
  background: var(--panel, #fff); border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: 6px 8px; margin-bottom: var(--space-3); width: fit-content;
}
.td-tom-pips { display: inline-flex; align-items: center; gap: 2px; }
.td-tom-pips i { width: 4px; height: 4px; border-radius: 50%; background: var(--line); }
.td-tom-pips i.done { background: var(--brand); }
.pd-view-seg { display: inline-flex; border: 1px solid var(--line-strong, #e4e7ed); border-radius: var(--radius-sm, 4px); overflow: hidden; }
.pd-view-seg > button { border: 0; background: transparent; padding: 4px 12px; cursor: pointer; color: var(--text-2); font-size: var(--fs-sm, 12px); display: inline-flex; align-items: center; }
.pd-view-seg > button.on { background: var(--brand); color: #fff; }
</style>
