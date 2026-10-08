<template>
  <div class="floating" @pointerdown="startDrag" @pointerup="stopDrag" @pointercancel="stopDrag" @lostpointercapture="stopDrag" @dblclick="onCardDblClick">
    <div class="tomato"
         :class="{'tomato--work': working, 'tomato--rest': resting, 'tomato--abandoning': abandoning,
                  'tomato--expand-menu': menuOpen, 'tomato--expand-noise': noiseOpen}">
      <div class="tomato__info">
        <div v-if="abandoning && working" class="tomato__giveup-label">{{ phaseText }}</div>
        <div class="tomato__time" :class="{'tomato__time--giveup': abandoning}">{{displayClock}}<small v-if="!abandoning">{{phaseText}}</small></div>
        <div v-if="st && st.attachTodo" class="tomato__task" :title="st.attachTodo.taskContent">{{ $t('statsB.TomatoFloatPage.attachLabel') }}<b>{{ st.attachTodo.taskContent }}</b>
          <button type="button" class="tomato__task-x close-x close-x--sm" :title="$t('statsB.TomatoFloatPage.detachTitle')" :aria-label="$t('statsB.TomatoFloatPage.detachTitle')"
                  @pointerdown.stop @click.stop="cancelAttach"></button>
        </div>
        <div v-else class="tomato__task">{{ $t('statsB.TomatoFloatPage.attachLabel') }}<b class="tomato__task-none">{{ $t('statsB.TomatoFloatPage.noAttach') }}</b></div>
        <!-- Remote running focus (LAN announce, display-only; opens the linked todo, toasts if absent;
             pointerdown.stop keeps the chip from dragging) -->
        <div v-if="remoteRun" class="tomato__remote" role="button" tabindex="0" :title="$t('statsD.TomatoPanel.remoteRunningTip')"
             @pointerdown.stop @click.stop="openRemoteTodo" @keydown="onRemoteKey">
          {{ $t('statsD.TomatoPanel.remoteRunning', { name: remoteRun.deviceName || remoteRun.deviceId, time: remoteClock }) }}
        </div>
        <div class="tomato__beads" :aria-label="$t('statsB.TomatoFloatPage.beadsAria')">
          <i v-for="k in beadsTotal" :key="k" :class="{done: k <= beadsDone}"></i>
        </div>
      </div>

      <div class="tomato__corner">
        <button type="button" class="corner-btn" :title="$t('statsP.TomatoFloatPage.titleMin')" @click="minimize"><i class="btn-min"></i></button>
        <button type="button" class="corner-btn corner-btn--muted" :title="abandoning ? $t('statsB.TomatoFloatPage.close') : $t('statsP.TomatoFloatPage.titleReset')" @click="abandoning ? cancelAbandon() : reset()"><i class="btn-close"></i></button>
        <button ref="menuBtn" type="button" class="corner-btn" :class="{'corner-btn--on': menuOpen, 'corner-btn--off': abandoning}"
                :title="$t('statsP.TomatoFloatPage.titleMenu')"
                :aria-expanded="menuOpen ? 'true' : 'false'"
                @click="toggleMenu"><i class="btn-dots"></i></button>
        <button ref="noiseBtn" type="button" class="corner-btn corner-btn--note" :class="{'corner-btn--on': noiseOpen}"
                :title="$t('statsB.TomatoFloatPage.noiseSection')"
                :aria-expanded="noiseOpen ? 'true' : 'false'"
                @click="toggleNoisePanel"><i class="btn-note"></i></button>
      </div>
      <!-- White noise selector: same expansion language as the ⋮ menu (card growth + glass panel fill + tf-pop symmetric fade-out) -->
      <transition name="tf-pop">
        <div v-if="noiseOpen" class="tf-noise" @pointerdown.stop>
          <div class="tf-noise__head">{{ $t('statsB.TomatoFloatPage.noiseSection') }}</div>
        <div class="tf-noise__list">
          <button v-for="c in noiseChips" :key="c.id || 'none'" type="button"
                  class="tf-noise__item" :class="{on: noiseCurrent === c.id}"
                  :title="c.label" @click="pickNoise(c.id)">
            <span class="tf-noise__name">{{ c.label }}</span>
            <i v-if="noiseCurrent === c.id" class="tf-noise__tick">✓</i>
          </button>
        </div>
        </div>
      </transition>

      <!-- Ring knob: the only progress element; start / abandon confirm -->
      <div ref="knobEl" class="tomato__knob" role="button" tabindex="0"
           :title="working ? $t('statsE.TomatoBar.giveUpFocusBtn') : (resting ? $t('statsE.TomatoBar.giveUpBreakBtn') : $t('statsP.TomatoFloatPage.titleStart'))"
           @click="btnMain" @keydown="onKnobKey">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="tomato__ring-bg" cx="18" cy="18" r="16" pathLength="100"/>
          <circle class="tomato__ring-fg" cx="18" cy="18" r="16" pathLength="100" :stroke-dasharray="ringPct + ' 100'"/>
        </svg>
        <span class="tomato__knob-icon">{{knobIcon}}</span>
      </div>

      <!-- Rest badge: pops out from the left of the ring -->
      <div v-if="resting" class="tomato__badge">{{ $t('statsB.TomatoFloatPage.restBadge', { n: (st.restTime || 5) }) }}</div>

      <!-- ⋮ task menu: picking one of today's todos attaches it (no auto-start); the transition handles symmetric fade-out (entry is handled by card growth + tt-fade-in) -->
      <transition name="tf-pop">
        <div v-if="menuOpen" class="tf-menu" @pointerdown.stop>
        <div class="tf-menu__head">
          <span class="tf-menu__title">{{ $t('statsB.TomatoFloatPage.menuTitle') }}</span>
          <button type="button" class="tf-menu__x close-x close-x--sm" :aria-label="$t('statsB.TomatoFloatPage.close')" @click="closeMenu()"></button>
        </div>
        <div class="tf-menu__list" role="listbox" :aria-label="$t('statsB.TomatoFloatPage.menuTitle')">
          <button v-for="t in tasks" :key="t.taskId" type="button" class="tf-menu__item"
                  :class="{'tf-menu__item--on': st && st.attachTodo && st.attachTodo.taskId === t.taskId}"
                  role="option" :aria-selected="st && st.attachTodo && st.attachTodo.taskId === t.taskId ? 'true' : 'false'"
                  :title="t.taskContent" @click="pickTask(t.taskId)">
            <span class="tf-menu__item-text">{{ t.taskContent }}</span>
            <i v-if="st && st.attachTodo && st.attachTodo.taskId === t.taskId" class="tf-menu__tick">✓</i>
          </button>
          <div v-if="!tasks.length" class="tf-menu__empty">{{ $t('statsB.TomatoFloatPage.menuEmpty') }}</div>
          <!-- D14-A7: the list is render-capped at 30 — say so instead of silently hiding the rest -->
          <div v-if="tasksTruncated" class="tf-menu__empty">{{ $t('statsB.TomatoFloatPage.menuTruncated') }}</div>
        </div>
        <button type="button" class="tf-menu__bare" @click="footerAction">{{ $t('statsB.TomatoFloatPage.menuClear') }}</button>
        </div>
      </transition>

      <!-- Abandon confirm: stable no-reason-input version (user-finalized 2026-09-01) — a question + give-up/continue buttons, top-right button retained -->
      <transition name="tf-pop">
        <div v-if="abandoning" class="tf-abandon" @pointerdown.stop>
          <div class="tf-abandon__q">{{ working ? $t('statsB.TomatoFloatPage.giveUpFocusTitle') : $t('statsB.TomatoFloatPage.giveUpRestTitle') }}</div>
          <div class="tf-abandon__actions">
            <button type="button" class="mini danger" @click="confirmAbandon">{{ $t('statsB.TomatoFloatPage.giveUp') }}</button>
            <button type="button" class="mini primary" @click="cancelAbandon">{{ $t('statsB.TomatoFloatPage.continueBtn') }}</button>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script lang="ts">
/** Standalone pomodoro float window page — final form (2026-08-31: ultra-light gray outline + ring knob).
 *  Pure white card face; the only progress element = the bottom-right ring knob (arc = remaining ratio;
 *  click = start / abandon confirm); large digits + phase label; attach row (✕ detach); today's beads;
 *  minimize / close(abandon+reset) / ⋮ task menu / ♪ noise (menus share the temp window-enlargement
 *  mechanism; browser debug host: widget-preview). Never pop a native dialog on a transparent frameless
 *  window — Windows paints a system title bar onto the host. */
import { formatMMSS, focusedElapsedSec, focusedMinutesText } from '../utils/tomatoShared.js'
import { NOISES } from '../utils/mediaRegistry.js'
import { remainSecOfAnnounce } from '../store/helpers/tomatoAnnounceShared.js'
import { remainingSecOfState } from '../store/tomato.js'
import { pruneRemoteAnnounces } from '../store/tomatoAnnounce.js'
// Drag/dblclick methods (pure relocation — spread into `methods` below)
import { tomatoFloatDragMethods } from './tomatoFloatDrag.js'
import { observeDispatch } from '../utils/dispatchObserved.js' // [maint/d23 FIX-3b] dispatches must be observed, not fire-and-forget
import { roleButtonActivate } from '../utils/roleButtonKey.js' // [maint/d23 FIX-3b a11y sweep] Space joins Enter

/** The browser debug host shim's todoAPI carries a version stamp; the real preload does not */
function isPreviewHost () {
  return !window.todoAPI || window.todoAPI.version === '0.1.0-browser-shim'
}
export default {
  name: 'TomatoFloatPage',
  data () {
    return {
      st: this.read(),
      remaining: null as any,
      abandoning: false,
      abandonBusy: false, // re-entrancy guard for confirmAbandon while the giveUp dispatch is in flight (D22 P2)
      abandonReason: '',
      menuOpen: false,
      noiseOpen: false,
      // Wall-clock tick for the 500ms loop (Date.now() in a computed is not reactive)
      now: Date.now(),
      preview: isPreviewHost()
    }
  },
  watch: {
    menuOpen () { this.syncPanel() },
    noiseOpen () { this.syncPanel() },
    abandoning () { this.syncPanel(); setTimeout(() => this.flushGhost(), 260) } // erase after the tf-pop 0.18s transition finishes
  },
  computed: {
    working () { return !!(this.st && this.st.status === 'startTomatoTime') },
    resting () { return !!(this.st && this.st.status === 'startRestTime') },
    /** Remote running focus (live announce) — touches this.st so the 1s refresh re-derives it. */
    remoteRun () { void this.st; return this.$store.getters['tomatoAnnounce/primaryRunning'] },
    remoteClock () { void this.st; return formatMMSS(remainSecOfAnnounce(this.$store.getters['tomatoAnnounce/primaryRunning'])) },
    clock () {
      if (this.remaining == null) return '--:--'
      return formatMMSS(this.remaining)
    },
    knobIcon () { return this.working ? '❚❚' : '▶' },
    // A13: formula single-sourced in utils/tomatoShared.js focusedMinutesText
    focusedMinText () {
      const s = this.st
      if (!this.working || !s || !s.startedAt) return '0'
      return focusedMinutesText(s.startedAt)
    },
    /* During abandon confirm the big digits switch to a forward-counting "focused for" —
       the user's decision quantity shown as live data instead of static small text */
    displayClock () {
      if (this.abandoning && this.working && this.st && this.st.startedAt) {
        return formatMMSS(focusedElapsedSec(this.st.startedAt, this.now))
      }
      return this.clock
    },
    phaseText () {
      if (this.abandoning && this.working) return this.$t('statsB.TomatoFloatPage.focusMinShort', { n: this.focusedMinText })
      if (this.working) return this.$t('statsP.TomatoFloatPage.phaseFocus')
      if (this.resting) return this.$t('statsP.TomatoFloatPage.phaseRest')
      return this.$t('statsP.TomatoFloatPage.phaseReady')
    },
    /* Ring arc remaining ratio 0-100 (ready = full ring); pathLength=100 draws directly by percentage */
    ringPct () {
      const s = this.st || {}
      if (this.working) {
        const total = (s.tomatoTime || 25) * 60
        return Math.max(0, Math.min(100, this.remaining / total * 100))
      }
      if (this.resting) {
        const total = (s.restTime || 5) * 60
        return Math.max(0, Math.min(100, this.remaining / total * 100))
      }
      return 100
    },
    /* Ready = menu footer is "start now"; running = footer is "clear attachment" */
    canPickTask () { return !!(this.st && this.st.status === 'default') },
    /* Today's pomodoro beads: done = completed today, total = daily target (capped 8–12 to prevent overflow) */
    beadsDone () { return Math.min(this.st ? (this.st.todayTomatoCount || 0) : 0, this.beadsTotal) },
    beadsTotal () {
      const target = (this.$store.state.settings && this.$store.state.settings.dailyTomatoTarget) || 8
      return Math.min(Math.max(Number(target) || 8, 1), 12)
    },
    attachName () { return (this.st && this.st.attachTodo) ? this.st.attachTodo.taskContent : '' },
    /* White noise sound list: first item = no playback (''), shared with the main window's settings.whiteNoiseAudio */
    noiseChips () {
      return [{ id: '', label: this.$t('statsB.TomatoFloatPage.noiseNone') }]
        .concat(NOISES.map(n => ({ id: n.id, label: this.$t(n.labelKey) })))
    },
    noiseCurrent () { return (this.$store.state.settings.whiteNoiseAudio || '') },
    /* Today's todo candidates (same pool as TomatoBar.attachCandidates). D14-A7: shared builder so
    the slice cap and the truncation notice read the same pool */
    taskPool () {
      const root = this.$store.state.todo || {}
      let list = (root.views && root.views.todayTodoList) || []
      if (!list.length) {
      // F4: compare against t.dayStart (store/todo.js caliber); the old 8-digit `YYYYMMDD` never equaled it.
        const today = window.dayjs ? +window.dayjs().startOf('day') : 0
        list = (root.todoList || []).filter(t => t && !t.delete && t.dayStart === today)
      }
      return list.filter(t => t && !t.complete)
    },
    tasks () {
      return this.taskPool().slice(0, 30)
    },
    /* D14-A7: was the pool bigger than the 30-item render cap? Drives the truncation notice */
    tasksTruncated () {
      return this.taskPool().length > 30
    }
  },
  methods: {
    read () { return this.$store.state.tomato },
    /** P2 (2026-09-19 UX review): same behavior as the TomatoPanel chip — a LIVE linked todo
     *  summons the main window (showMainFromFloat); an absent/tombstoned one toasts. */
    openRemoteTodo () {
      const id = this.remoteRun && this.remoteRun.attachTodoId
      const root = this.$store.state.todo || {}
      const live = id && (root.todoList || []).some(t => t && t.taskId === id && !t.delete)
      const EP = window.ElementPlus
      if (!live) {
        if (EP && EP.ElMessage) EP.ElMessage({ type: 'warning', message: this.$t('statsD.TomatoPanel.remoteTodoMissing'), duration: 4000, showClose: true })
        return
      }
      if (window.todoAPI && window.todoAPI.showMainFromFloat) window.todoAPI.showMainFromFloat()
    },
    refresh () {
      this.now = Date.now()
      this.st = this.read()
      // P1-6: prune announces on this tick so a crashed peer's ghost chip drops by TTL
      // (skipped while no announce exists: an idle window stops issuing 2Hz Vuex commits).
      try { pruneRemoteAnnounces(this.$store) } catch (e) { /* store not ready */ }
      // maint/d11-r4: single-source remaining seconds
      this.remaining = remainingSecOfState(this.st, this.now)
      // If the dialog is open but focus has already ended elsewhere (finished/ended elsewhere), auto-collapse — otherwise title and body desync
      if (this.abandoning && this.st.status !== 'startTomatoTime') this.abandoning = false
    },
    /* Window height decision log (2026-09-02): constant 240×320; ⋮/♪/abandon expansion is pure in-window
       CSS animation (OS never resizes); idle areas are main-process polled click-through; content-fit
       86/320 was rejected (per-toggle setBounds hard-clips the fade-out). syncPanel only reports "an
       expandable layer exists" so the hit area extends to the full window. */
    syncPanel () {
      if (this.preview) return
      if (!window.todoAPI || !window.todoAPI.tomatoFloatPanel) return
      window.todoAPI.tomatoFloatPanel(!!(this.menuOpen || this.noiseOpen))
    },
    /* Abandon open/close = full-window recomposite → DWM right-angle ghost repaints may linger;
       wipe once in place after the transition ends (most reliable erasure method tested here) */
    flushGhost () {
      if (this.preview) return
      if (window.todoAPI && window.todoAPI.flushTomatoFloat) window.todoAPI.flushTomatoFloat()
    },
    btnMain () {
      const s = this.st
      if (!s) return
      // [maint/d23 FIX-3b] observed: a failed startFocus surfaces a toast instead of idling silently
      if (s.status === 'default') { observeDispatch(this.$store, 'tomato/startFocus').catch(this.reportDispatchFail); return }
      // Click while running/resting = abandon confirm (no pause for the pomodoro — user-finalized)
      this.reset()
    },
    reset () {
      const s = this.st
      if (!s) return
      if (s.status === 'default') { this.persist({ status: 'default', startedAt: 0, remainSec: (s.tomatoTime || 25) * 60 }); return }
      // Abandoning during rest shows no confirm (user-finalized): nothing is logged, no cost, return straight to ready; the confirm dialog is only for focus
      // [maint/d23 FIX-3b] observed (same fix as confirmAbandon below): a failed rest-abandon
      // used to leave the countdown silently running with no feedback
      if (s.status === 'startRestTime') { observeDispatch(this.$store, 'tomato/giveUp', { record: false }).catch(this.reportDispatchFail); return }
      this.abandonReason = ''
      this.abandoning = true
    },
    persist (patch) { this.$store.commit('tomato/patch', patch); this.st = this.$store.state.tomato },
    minimize () { if (window.todoAPI) window.todoAPI.hideTomatoFloat() },
    // [D22 P2] giveUp is awaited (same fix as TomatoAbandonModal): the layer collapses only on success.
    async confirmAbandon () {
      if (this.abandonBusy) return
      this.abandonBusy = true
      try {
        await this.$store.dispatch('tomato/giveUp', { record: this.working, reason: this.abandonReason })
        this.closeAbandon()
      } catch (e) {
        console.error('[tomato] giveUp failed:', e)
        if (this.$message) this.$message.error(this.$t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
      } finally { this.abandonBusy = false }
    },
    cancelAbandon () {
      this.closeAbandon()
    },
    /* ⋮ task menu: openable at any phase (running = switch attachment); mutually exclusive with the ♪ noise panel */
    toggleMenu () {
      if (this.abandoning) return
      if (this.menuOpen) { this.closeMenu(); return }
      this.menuOpen = true
      this.noiseOpen = false
    },
    /* White noise selector bar: never expands during abandon confirm (avoid stacked states), otherwise openable anytime; mutually exclusive with the task menu */
    toggleNoisePanel () {
      if (this.abandoning) return
      if (this.noiseOpen) { this.closeNoisePanel(); return }
      this.noiseOpen = true
      this.menuOpen = false
    },
    /* [maint/d23 FIX-3b] closing a v-if panel must not strand keyboard focus on the removed
       nodes (falls to body; only 15px corner buttons). Same contract as ViewMoreMenu.closeMenu. */
    refocusToggle (ref) {
      this.$nextTick(() => {
        const el = this.$refs[ref]
        if (el && el.focus) { try { el.focus() } catch (e) { /* unfocusable host */ } }
      })
    },
    closeMenu (refocus = true) {
      this.menuOpen = false
      if (refocus) this.refocusToggle('menuBtn')
    },
    closeNoisePanel (refocus = true) {
      this.noiseOpen = false
      if (refocus) this.refocusToggle('noiseBtn')
    },
    closeAbandon (refocus = true) {
      this.abandoning = false
      if (refocus) this.refocusToggle('knobEl')
    },
    /* [maint/d23 FIX-3b a11y sweep] role="button" ring knob / remote chip: Space joins Enter */
    onKnobKey: roleButtonActivate(function () { this.btnMain() }),
    onRemoteKey: roleButtonActivate(function () { this.openRemoteTodo() }, { stop: true }),
    /* Picked task: attach only, never start (starting is up to the user via the main knob) */
    pickTask (taskId) {
      this.$store.dispatch('tomato/attach', taskId)
      this.closeMenu()
    },
    /* White noise switch: writes only the sound choice; play/stop follows automatically per focus state; collapse to the card on selection */
    async pickNoise (id) {
      // Action, not mutation: only the action persists via todoAPI.updateSettings → config.json.
      // [D22 P3] the action RESOLVES with {ok:false} on IPC failure — the panel stays open.
      try {
        const r = await this.$store.dispatch('settings/update', { whiteNoiseAudio: id })
        if (r && r.ok === false) throw (r.error || new Error('updateSettings failed'))
        this.closeNoisePanel()
      } catch (e) {
        console.error('[tomato] white noise settings write failed:', e)
        if (this.$message) this.$message.error(this.$t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
      }
    },
    cancelAttach () {
      this.$store.dispatch('tomato/attach', null)
    },
    /* [maint/d23 FIX-3b] failure toast for observed dispatches (actionFailedMsg key + detail) */
    reportDispatchFail (e) {
      if (this.$message) this.$message.error(this.$t('statsH.main.actionFailedMsg') + ((e && e.message) || ''))
    },
    footerAction () {
      /* The footer button is always "detach": only clears the selection, never binds a start (focus belongs solely to the ring knob) */
      this.cancelAttach()
      this.closeMenu()
    },
    // Whole-card drag/dblclick summon: verbatim in views/tomatoFloatDrag.js (size ratchet)
    startDrag (e) { return tomatoFloatDragMethods.startDrag.call(this, e) },
    _isCardInteractive (t) { return tomatoFloatDragMethods._isCardInteractive.call(this, t) },
    onCardDblClick (e) { return tomatoFloatDragMethods.onCardDblClick.call(this, e) },
    stopDrag (e) { return tomatoFloatDragMethods.stopDrag.call(this, e) }
  },
  mounted () {
    if (this.preview) {
      document.documentElement.classList.add('widget-preview')
    } else {
      document.documentElement.classList.add('widget-transparent')
      // document.title is what DWM ghost repaints draw — clear it to cut the ghost off at the root
      document.title = ''
      if (window.todoAPI) window.todoAPI.setTomatoFloatBounds()
    }
    this.refresh()
    this._onStorage = () => this.refresh()
    window.addEventListener('storage', this._onStorage)
    // F22: UNREACHABLE while the window is focusable:false (Electron DWM workaround); kept for the
    // post-v39 re-enable. TEST GAP: no float-window Escape test yet.
    this._onKey = e => {
      if (e.key !== 'Escape') return
      if (this.menuOpen) this.closeMenu()
      if (this.noiseOpen) this.closeNoisePanel()
    }
    window.addEventListener('keydown', this._onKey)
    this._iv = setInterval(() => this.refresh(), 500)
    // Route enforcement: the float window may only stay on __tomato-float (abnormal navigation would render the whole app in the tiny window)
    this._routeGuard = () => {
      if (this.$route.name !== '__tomato-float') {
        this.$router.push({ name: '__tomato-float' }).catch(() => {})
      }
    }
    this._unAfterEach = this.$router.afterEach(this._routeGuard)
    this._routeGuard()
  },
  beforeUnmount () {
    clearInterval(this._iv)
    if (this._onStorage) window.removeEventListener('storage', this._onStorage)
    if (this._onKey) window.removeEventListener('keydown', this._onKey)
    if (this._unAfterEach) this._unAfterEach()
    this.stopDrag()
    document.documentElement.classList.remove('widget-transparent')
    document.documentElement.classList.remove('widget-preview')
  }
}
</script>
<style>
.corner-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  transition: background .15s;
}
.corner-btn i { display: block; transform: scale(.75); }
.corner-btn:hover { background: rgba(15, 157, 143, .12); }
.corner-btn--on { background: var(--brand-light, #e7f7f7); opacity: 1; }
/* 放弃确认期间：⋮ 灰色禁用态（不可点） */
.corner-btn--off {
  opacity: .35;
  cursor: default;
  pointer-events: none;
}
.corner-btn--off:hover { background: transparent; }
.corner-btn--muted { color: var(--text-4, #c0c4cc); }
/* —— ⋮ 任务菜单：窗口临时放大（220×320）后铺满卡片，选今日待办其一即关联开始 —— */
.tf-menu {
  position: absolute;
  inset: 0;
  z-index: var(--z-float-noise);
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px 10px 10px;
  /* 与卡片同款玻璃白（勿用 var(--panel)：暗色主题下会变成深灰，和玻璃卡不协调） */
  background: rgba(255,255,255,.88);
  backdrop-filter: blur(10px);
  border-radius: var(--radius-lg);
  box-shadow: 0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px 0 rgba(0,0,0,.06);
  animation: tt-fade-in .15s ease both;
}
.tf-menu__head { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.tf-menu__title { color: var(--brand-dark); font-size: 12px; font-weight: 600; }
.tf-menu__x { margin-left: auto; }
/* 叉形/hover 由统一 close-x 体系负责 */
.tf-menu__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: thin; scrollbar-color: rgba(120,130,140,.35) transparent; }
.tf-menu__list::-webkit-scrollbar { width: 4px; }
.tf-menu__list::-webkit-scrollbar-thumb { background: rgba(120,130,140,.35); border-radius: 2px; }
.tf-menu__list::-webkit-scrollbar-track { background: transparent; }
.tf-menu__item {
  border: 0; background: none; text-align: left; cursor: pointer;
  /* flex-shrink:0 关键：任务多时子项保住自然高度让容器溢出滚动，
     否则 flex 默认把每个子项等比压扁=间距消失(2026-09-02 用户实拍) */
  flex-shrink: 0;
  padding: 6px 8px; border-radius: var(--radius-sm, 4px);
  color: var(--text-1); font-size: 12px; line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tf-menu__item:hover { background: var(--brand-light, #e7f7f7); color: var(--brand-dark); }
/* 已关联项高亮：✓ 标记 + 淡青底，选中状态在菜单里一眼可见 */
.tf-menu__item { display: flex; align-items: center; gap: 4px; }
.tf-menu__item-text { min-width: 0; flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tf-menu__item--on, .tf-menu__item--on:hover { background: var(--brand-light, #e7f7f7); color: var(--brand-dark); font-weight: 600; }
.tf-menu__tick { flex-shrink: 0; font-style: normal; font-size: 10px; color: var(--brand, var(--brand, #0f9d8f)); }
.tf-menu__empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 16px 0; }
.tf-menu__bare {
  flex-shrink: 0; margin-top: 6px; padding: 6px;
  border: 1px dashed var(--line-strong, #e4e7ed); border-radius: var(--radius-sm, 4px);
  background: none; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.tf-menu__bare:hover { border-color: var(--brand); color: var(--brand); }
html[data-theme="dark"] .corner-btn:hover { background: rgba(53,194,174,.18); }
html[data-theme="dark"] .corner-btn--muted { color: rgba(232,237,241,.35); }
/* ⋮ 菜单深色 */
html[data-theme="dark"] .tf-menu { background: #22262e; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
html[data-theme="dark"] .tf-menu__title { color: #7fd0c7; }
html[data-theme="dark"] .tf-menu__x { color: rgba(232,237,241,.55); }
html[data-theme="dark"] .tf-menu__x:hover { background: rgba(255,255,255,.1); color: #e8edf1; }
html[data-theme="dark"] .tf-menu__item { color: #e8edf1; }
html[data-theme="dark"] .tf-menu__item:hover { background: rgba(53,194,174,.15); color: #7fd0c7; }
html[data-theme="dark"] .tf-menu__item--on, html[data-theme="dark"] .tf-menu__item--on:hover { background: rgba(53,194,174,.18); color: #7fd0c7; }
html[data-theme="dark"] .tf-menu__tick { color: var(--brand-bright, #35c2ae); }
html[data-theme="dark"] .tf-menu__empty { color: rgba(232,237,241,.4); }
html[data-theme="dark"] .tf-menu__bare { border-color: rgba(255,255,255,.16); color: rgba(232,237,241,.7); }
html[data-theme="dark"] .tf-menu__bare:hover { border-color: var(--brand-bright, #35c2ae); color: #7fd0c7; }
/* ⋮ 菜单内：白噪音选择区（音色 chips 实时切换，全局派发器即时生效） */
.tf-menu__noise { padding-top: 6px; border-top: 1px solid rgba(120, 130, 140, .18); }
.tf-menu__noise-label { font-size: 9px; color: var(--text-3, #9aa0a6); margin-bottom: 4px; }
.tf-menu__noise .tf-menu__item { font-size: 10px; padding: 4px 8px; }
.tf-menu__noise .tf-menu__item--on, .tf-menu__noise .tf-menu__item--on:hover { background: rgba(15, 157, 143, .12); }
/* 放弃面板精简后 86px 原尺寸即可容纳：卡片不再生长（用户实测「空间够就不用变大」） */

/* 浮窗角钮图标 · mask+currentColor（旧固定灰底图在深色卡面对比不足；mask 走形状 alpha、
   颜色跟随主题；作用域限浮窗角钮） */
.corner-btn { color: #8a9096; }
html[data-theme="dark"] .corner-btn { color: rgba(232, 237, 241, .78); }
.tomato .corner-btn .btn-min,
.tomato .corner-btn .btn-close,
.tomato .corner-btn .btn-dots {
  background: none;
  background-color: currentColor;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}
.tomato .corner-btn .btn-min {
  width: 10px;
  height: 10px;
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22><rect y=%224%22 width=%2210%22 height=%222%22 rx=%221%22/></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22><rect y=%224%22 width=%2210%22 height=%222%22 rx=%221%22/></svg>');
}
.tomato .corner-btn .btn-close {
  width: 10px;
  height: 10px;
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22><path d=%22M1 1l8 8M9 1l-8 8%22 stroke=%22black%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 fill=%22none%22/></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22><path d=%22M1 1l8 8M9 1l-8 8%22 stroke=%22black%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 fill=%22none%22/></svg>');
}
.tomato .corner-btn .btn-dots {
  width: 4px;
  height: 12px;
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 4 14%22><circle cx=%222%22 cy=%222%22 r=%221.5%22/><circle cx=%222%22 cy=%227%22 r=%221.5%22/><circle cx=%222%22 cy=%2212%22 r=%221.5%22/></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 4 14%22><circle cx=%222%22 cy=%222%22 r=%221.5%22/><circle cx=%222%22 cy=%227%22 r=%221.5%22/><circle cx=%222%22 cy=%2212%22 r=%221.5%22/></svg>');
}
/* 音符角钮（mask+currentColor，随主题） */
.corner-btn .btn-note {
  width: 12px;
  height: 12px;
  background-color: currentColor;
  -webkit-mask: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22><path d=%22M4.2 10.2V2.4l6-1.2v7.6%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.3%22 stroke-linejoin=%22round%22/><circle cx=%222.9%22 cy=%2210.2%22 r=%221.7%22/><circle cx=%228.9%22 cy=%228.8%22 r=%221.7%22/></svg>') center / contain no-repeat;
  mask: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 12%22><path d=%22M4.2 10.2V2.4l6-1.2v7.6%22 fill=%22none%22 stroke=%22black%22 stroke-width=%221.3%22 stroke-linejoin=%22round%22/><circle cx=%222.9%22 cy=%2210.2%22 r=%221.7%22/><circle cx=%228.9%22 cy=%228.8%22 r=%221.7%22/></svg>') center / contain no-repeat;
}
/* ==================== 浮窗角钮 · 动效/样式/布局精修（2026-09-01） ====================
   三段时序各管一环：背景 .15s ease / 按钮缩放 .12s / 图标缩放 .18s 弹性曲线；
   悬停 = 图标 0.75→0.88 微放大（呼吸感，不加位移防抖）；按压 = 0.88 回弹；
   键盘焦点环走 outline（不占布局）；禁用态(放弃期间⋮)不出按压。 */
.corner-btn {
  transition: background-color .15s ease, transform .12s ease, opacity .15s ease;
}
.tomato .corner-btn:active { transform: scale(.88); }
.corner-btn:focus-visible { outline: 2px solid var(--brand, var(--brand, #0f9d8f)); outline-offset: 1px; }
.tomato .corner-btn i { transition: transform .18s cubic-bezier(.2, .8, .2, 1); }
.tomato .corner-btn:hover:not(.corner-btn--off) i { transform: scale(.88); }
.tomato .corner-btn--off:active { transform: none; }
html[data-theme="dark"] .corner-btn:focus-visible { outline-color: var(--brand-bright, #35c2ae); }
/* ==================== ⋮ 菜单展开 · 动效收尾（2026-09-01） ====================
   入场已有：卡片 86→320px 0.2s 弹性生长 + 内容 tt-fade-in 同步淡入；
   出场补齐：tf-pop 过渡 0.18s 淡出（组件层 transition），不再 v-if 硬切。
   列表滚动条细体化：240px 玻璃卡里默认粗滚动条喧宾夺主。 */
.tf-menu .tf-menu__list { scrollbar-width: thin; scrollbar-color: rgba(120,130,140,.35) transparent; }
.tf-menu .tf-menu__list::-webkit-scrollbar { width: 4px; }
.tf-menu .tf-menu__list::-webkit-scrollbar-thumb { background: rgba(120,130,140,.35); border-radius: 2px; }
.tf-menu .tf-menu__list::-webkit-scrollbar-track { background: transparent; }
html[data-theme="dark"] .tf-menu .tf-menu__list { scrollbar-color: rgba(232,237,241,.25) transparent; }
html[data-theme="dark"] .tf-menu .tf-menu__list::-webkit-scrollbar-thumb { background: rgba(232,237,241,.25); }
/* 勾选框选中图标白色（icon-done.svg 源文件为黑色，反相成纯白，
   对应设计稿 fa check-square 白色图形叠在 var(--brand, #0f9d8f) 底上） */
.td-check img { filter: brightness(0) invert(1); }
/* —— 浏览器预览模式（番茄浮窗在 5175 调试宿主打开时挂 widget-preview）：
      卡片按浮窗真实尺寸 240×86 居中呈现，配桌面感深色背景；放大态用类名表达，不再拉满整页 —— */
html.widget-preview, html.widget-preview body, html.widget-preview #app { height: 100%; }
html.widget-preview body { overflow: hidden; }
html.widget-preview .floating {
  position: static;
  height: 100%;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(1200px 600px at 20% 0%, rgba(15,157,143,.16), transparent 60%),
    linear-gradient(135deg, #202a38 0%, #171e29 55%, #1d2b33 100%);
}
html.widget-preview .tomato {
  width: 240px;
  height: 86px;
  flex: 0 0 auto;
  transition: width .25s cubic-bezier(.2,.8,.2,1), height .25s cubic-bezier(.2,.8,.2,1);
}
/* 同卡展开退役：放弃面板免填原因稳定版 86px 即容纳，卡片不再生长 */
html.widget-preview .tomato--expand-menu { width: 240px; height: 320px; }
.btn-close {
  width: 12px;
  height: 10px;
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAUCAYAAACXtf2DAAABP0lEQVRIS7VVMU7EMBDcpUyVig9gF1Rp8gDEC+jzB4SAO0TnDnHHnRB/cM8LEA9Ik4pizQeoUqVkkS1HJLnEd5HOLhJF3vHszmzWCH4R0RkivgPAhxDiBgC43TvwjcaYVwC4ZOYrKeW3xaF9VFV1miTJJyKe229m3kop72eQIBG9IOKtx381TXORZdmPIyjLMknT9AkArttsZ5D0Dvf4t7quH/M8bxyBXzuBzLyRUi4ClVjMGhHvphLrEjjJ9gHmJjQkAKXUSVEUNiun54QnY9VutdYLpdRvtyl2CAJyWeOdFES02ZPAv+6BFhwzb+3jrS9T1fWOnKrABXm5Vl0Tu2jbBFrr5VCWQyTqZWGMeQaA5aDalRDiIaCA2wpW0IKjEcSWKKrJo31+lDaN/aNFHRXxhl30cR39wvEDLMqV+QeV7TQk/RFG2gAAAABJRU5ErkJggg==') no-repeat 50%;
  background-size: 12px 10px;
}
.btn-dots {
  width: 12px; height: 12px;
  background: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 4 14%22><circle cx=%222%22 cy=%222%22 r=%221.6%22 fill=%22%23999%22/><circle cx=%222%22 cy=%227%22 r=%221.6%22 fill=%22%23999%22/><circle cx=%222%22 cy=%2212%22 r=%221.6%22 fill=%22%23999%22/></svg>') no-repeat 50%;
  background-size: 4px 12px;
}
.btn-min {
  width: 8px; height: 8px;
  background: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 8 8%22><rect x=%220%22 y=%223.25%22 width=%228%22 height=%221.5%22 rx=%22.75%22 fill=%22%23999%22/></svg>') no-repeat 50%;
  background-size: 8px 8px;
}
/* 遮罩层已删（用户定稿只要卡片本身）：tf-abandon 即弹窗卡片，绝对居中。
   translate 属性负责居中位移，transform 只做过渡缩放，两者互不打架 */
.tf-abandon__title { font-size: 11px; font-weight: 600; color: var(--text-1, #2b2f33); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tf-abandon__meta { flex-shrink: 0; font-size: 9px; color: var(--text-3, #9aa0a6); }
.tf-abandon {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  padding: 0 14px;
  background: #fff; /* 纯白定稿(白名单) */
  color: #2b2f33;
  /* 不再重定义 text/line/brand 全局 token(曾构成第三 token 源,base 改值此处不跟随);
    子元素颜色直接消费定稿字面量,深色分支由 html[data-theme] 专属规则覆盖 */
  border-radius: 14px;
}
.tf-abandon__q { font-size: 13px; font-weight: 600; color: var(--text-1, #2b2f33); line-height: 16px; }
.tf-abandon__actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.tf-abandon__actions .mini.primary {
  background: var(--brand, var(--brand, #0f9d8f));
  color: #fff;
  border-color: transparent;
}
.tf-abandon__actions .mini.primary:hover { background: var(--brand-dark, #0c8172); }
.tf-abandon__actions .mini.danger {
  background: #fef0f0;
  color: #d9534f;
  border: 1px solid #f5c8c5;
}
.tf-abandon__actions .mini.danger:hover { background: #fde3e3; }
html.widget-preview .tomato--expand-noise { width: 240px; height: 320px; }
.tf-noise {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px 10px 10px;
  background: rgba(255,255,255,.88);
  backdrop-filter: blur(10px);
  border-radius: var(--radius-lg);
  box-shadow: 0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px 0 rgba(0,0,0,.06);
}
.tf-noise__head { font-size: 12px; font-weight: 600; color: var(--brand-dark, #0c8172); padding: 0 4px 6px; }
.tf-noise__list { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.tf-noise__item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  border: 0; background: none; text-align: left; cursor: pointer;
  padding: 6px 8px; border-radius: var(--radius-sm, 4px);
  color: var(--text-1, #2b2f33); font-size: 12px; line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;

  flex-shrink: 0; /* 同 tf-menu__item：防任务/条目多时被 flex 压扁 */
}
.tf-noise__item:hover { background: var(--brand-light, #e7f7f7); color: var(--brand-dark, #0c8172); }
.tf-noise__item.on, .tf-noise__item.on:hover { background: var(--brand-light, #e7f7f7); color: var(--brand-dark, #0c8172); font-weight: 600; }
.tf-noise__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tf-noise__tick { flex-shrink: 0; font-style: normal; font-size: 10px; color: var(--brand, var(--brand, #0f9d8f)); }
.tf-noise .tf-noise__list { scrollbar-width: thin; scrollbar-color: rgba(120,130,140,.35) transparent; }
.tf-noise .tf-noise__list::-webkit-scrollbar { width: 4px; }
.tf-noise .tf-noise__list::-webkit-scrollbar-thumb { background: rgba(120,130,140,.35); border-radius: 2px; }
.tf-noise .tf-noise__list::-webkit-scrollbar-track { background: transparent; }
/* 放弃专注弹窗 —— 紧凑简约版（布局层独立渲染） */
.modal.modal--abandon { position: fixed; inset: 0; background: rgba(15, 22, 26, .42); z-index: var(--z-overlay); display: flex; align-items: center; justify-content: center; }




.abandon-card { position: relative; width: 320px; max-width: 90vw; box-sizing: border-box; border-radius: var(--radius-xl);
  background: var(--panel, #fff); box-shadow: 0 16px 48px rgba(10, 20, 24, .22); padding: 18px 20px 14px; }




.abandon-x { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border: none; border-radius: var(--radius-md);
  background: none; color: var(--text-3, #6d7278); display: flex; align-items: center; justify-content: center; cursor: pointer; }




.abandon-x:hover { background: rgba(0, 0, 0, .05); color: var(--text-1, #333); }




.abandon-title { font-size: var(--fs-lg); font-weight: 600; color: var(--text-1, #333); padding-right: 26px; }




.abandon-hint { margin: 8px 0 12px; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-3, #6d7278); }




.abandon-hint b { color: var(--text-1, #333); }




.abandon-reason-input { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid var(--line-strong, #d8dde2);
  border-radius: var(--radius-md); font-size: var(--fs-md); font-family: inherit; color: var(--text-1, #333); background: transparent; }




.abandon-reason-input:focus { outline: none; border-color: var(--brand, #0f9d8f); }




.abandon-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }




.abandon-btn { border: none; border-radius: var(--radius-md); padding: 7px 14px; font-size: var(--fs-md); font-family: inherit; cursor: pointer;
  background: none; color: var(--text-2, #606266); }




.abandon-btn:hover { background: rgba(0, 0, 0, .05); }




.abandon-btn--giveup { background: var(--danger-strong); color: #fff; }

.abandon-btn--giveup:hover { background: var(--danger-strong); }

/* ==================== 6. 浮窗深色主题适配（html[data-theme="dark"] 由 applyColorMode 统一挂载） ==================== */
html[data-theme="dark"] .tomato { background: #22262e; border-color: rgba(255,255,255,.12); box-shadow: 0 10px 28px rgba(0,0,0,.45); }
html[data-theme="dark"] .tomato__time { color: #e8edf1; }
html[data-theme="dark"] .tomato__time small { color: rgba(232,237,241,.55); }
html[data-theme="dark"] .tomato__task { color: rgba(232,237,241,.5); }
html[data-theme="dark"] .tomato__task b { color: #7fd0c7; }
html[data-theme="dark"] .tomato__task-none { color: rgba(232,237,241,.4); }
html[data-theme="dark"] .tomato__task-x { color: rgba(232,237,241,.5); }
html[data-theme="dark"] .tomato__task-x:hover { background: rgba(255,255,255,.1); color: #e8edf1; }
html[data-theme="dark"] .tomato__beads i { background: rgba(53,194,174,.22); }
html[data-theme="dark"] .tomato__beads i.done { background: var(--brand-bright, #35c2ae); }
/* Remote running focus chip (LAN sync announce, display-only) */
.tomato__remote { font-size: 11px; color: var(--brand, #35c2ae); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
/* P2 (2026-09-19 UX review): dark-mode token follows the file's neighboring dark overrides
   (same #7fd0c7 tint the task title uses) — the light token dimmed the chip on dark cards. */
html[data-theme="dark"] .tomato__remote { color: #7fd0c7; }
html[data-theme="dark"] .tomato__knob { background: #22262e; }
html[data-theme="dark"] .tomato__ring-bg { stroke: rgba(53,194,174,.25); }
html[data-theme="dark"] .tomato__ring-fg { stroke: var(--brand-bright, #35c2ae); }
html[data-theme="dark"] .tomato--rest .tomato__ring-fg { stroke: #ffa95c; }
html[data-theme="dark"] .tomato__knob-icon { color: #7fd0c7; }
html[data-theme="dark"] .tomato--rest .tomato__knob-icon { color: #ffa95c; }
html[data-theme="dark"] .tomato__badge { background: #e8862a; }
html[data-theme="dark"] .tomato .tf-abandon .mini {
  background: rgba(255,255,255,.08);
  color: #e8edf1;
  border: 1px solid rgba(255,255,255,.14);
}
html[data-theme="dark"] .tomato .tf-abandon .mini:hover { background: rgba(255,255,255,.14); }
html[data-theme="dark"] .tomato .tf-abandon .mini.danger {
  background: rgba(249,83,74,.16);
  color: #f3837a;
  border-color: transparent;
}
html[data-theme="dark"] .tomato .tf-abandon .mini.danger:hover { background: rgba(249,83,74,.26); }
/* ♪ 噪音面板深色与细滚动条：完全对齐 tf-menu 同款（2026-09-01） */
html[data-theme="dark"] .tf-noise { background: #22262e; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
html[data-theme="dark"] .tf-noise__head { color: #7fd0c7; }
html[data-theme="dark"] .tf-noise__item { color: #e8edf1; }
html[data-theme="dark"] .tf-noise__item:hover { background: rgba(53,194,174,.15); color: #7fd0c7; }
html[data-theme="dark"] .tf-noise__item.on, html[data-theme="dark"] .tf-noise__item.on:hover { background: rgba(53,194,174,.18); color: #7fd0c7; }
html[data-theme="dark"] .tf-noise__tick { color: var(--brand-bright, #35c2ae); }
html[data-theme="dark"] .tf-noise .tf-noise__list { scrollbar-color: rgba(232,237,241,.25) transparent; }
html[data-theme="dark"] .tf-noise .tf-noise__list::-webkit-scrollbar-thumb { background: rgba(232,237,241,.25); }
@keyframes sn-sync-pop { from { transform: scale(.6); } 60% { transform: scale(1.15); } }
@keyframes sn-sync-draw { to { stroke-dashoffset: 0; } }
@keyframes sidebar-profile-spin { to { transform: rotate(1turn); } }
/* restored 2026-09-07: lost with style-3.css retirement (audit catch — refs above silently no-oped) */
@keyframes sn-slide { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
@keyframes mgr-preview-in { from { opacity: 0; transform: translateY(-4px); } }
</style>
