<template>

  <div class="tomato-bar tomato-timer"
       :style="slim ? 'height:40px;flex:0 0 40px;min-height:0' : 'height:72px;flex:0 0 72px;min-height:0'"
       :class="[slim ? 'tomato-bar--slim' : '', {'tomato-timer--work': isWork, 'tomato-timer--rest': isRest}]">
    <div class="tomato-timer__status">
      <div class="tb-row">
        <template v-if="attachName">
          <app-icon name="link" :size="14" :style="{color: isRest ? 'var(--tt-rest-accent)' : 'var(--tt-work-accent)'}"/>
          <!-- State-aware: idle + attached = "ready to start: X", no longer always "focusing" (residual-state bug after giving up, caught in dual-Persona testing) -->
          {{ isRest ? $t('statsE.TomatoBar.restAttach', { name: attachName }) : (isWork ? $t('statsE.TomatoBar.workAttach', { name: attachName }) : $t('statsE.TomatoBar.readyPrefix') + attachName) }}
          <button type="button" class="tb-unlink" style="opacity:.5;cursor:pointer;background:none;border:none;padding:0;display:inline-flex;align-items:center"
                  :title="$t('statsE.TomatoBar.unlinkBtn')" :aria-label="$t('statsE.TomatoBar.unlinkPrefix') + attachName" @click="cancelAttach">
            <app-icon name="x" :size="11"/>
          </button>
        </template>
        <template v-else>
          <app-icon name="timer" :size="14" :style="{color: isRest ? 'var(--tt-rest-accent)' : 'var(--tt-work-accent)'}"/>
          <span>{{ $t('statsE.TomatoBar.readyStatus') }}</span>
        </template>
      </div>
      <div class="tb-row tb-row--harvest" v-if="!slim" style="cursor:pointer;display:flex;align-items:center;gap:8px">
        <span role="button" tabindex="0" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px"
              :title="$t('statsE.TomatoBar.viewRecordsBtn')" @click="showRecordList" @keydown.enter.prevent="showRecordList">
          <app-icon name="list" :size="12" style="opacity:.6"/>
          <span>{{ $t('statsE.TomatoBar.todayHarvestPrefix') }}<b :style="{color: targetReached ? 'var(--tt-reached)' : 'var(--tt-open)'}" :title="$t('statsH.TomatoBar.harvestTip', { d: todayDone, n: todayTarget })">{{todayDone}}/{{todayTarget}}</b></span>
        </span>
        <button type="button" class="tb-float-toggle" :class="{on: floatOn}" @click="toggleFloat"
                :aria-label="floatOn ? $t('statsH.TomatoBar.floatAriaOn') : $t('statsH.TomatoBar.floatAriaOff')"
                :title="floatOn ? $t('statsH.TomatoBar.floatAriaOn') : $t('statsH.TomatoBar.floatAriaOff')">
          <app-icon name="matrix" :size="12"/>
          <span>{{ floatOn ? $t('statsH.TomatoBar.floatBtnOn') : $t('statsH.TomatoBar.floatBtnOff') }}</span>
        </button>
      </div>
    </div>

    <div class="tomato-timer__center">
      <div class="tomato-timer__time" :class="{'tomato-timer__time--rest': isRest}">{{clock}}</div>
    </div>

    <button type="button" class="tomato-timer__play"
            :class="{'tomato-timer__play--work': isWork, 'tomato-timer__play--rest': isRest}"
            @click="onPlayClick">
      {{playText}}
    </button>

  </div>
</template>

<script lang="ts">
/**
 * Bottom pomodoro focus bar -- bottom pomodoro focus bar
 * Structure: __status (left 40% z1) | __right (absolute full-width column = timer + noise centered) | __play (right 25px 138x48)
 * Three states: default -> pomodoro focus (teal) | startTomatoTime -> abandon focus (#bd401e) | startRestTime -> abandon break (#fe9933)
 */
import {dayjs, FMT } from '../utils/core.js'
import { formatMMSS } from '../utils/tomatoShared.js'
import store from '../store/index.js'

// The noise list/files/prefix have been consolidated into utils/mediaRegistry.js (single source of truth); only the "labelKey tail segment" is adapted here

export default {
  name: 'TomatoBar',
  data () { return { ts: 0, floatOn: false } },
  computed: {
    s () { return this.$store.state.tomato },
    status () { return this.s.status || 'default' },
    isWork () { return this.status === 'startTomatoTime' },
    isRest () { return this.status === 'startRestTime' },
    isRunning () { return this.status !== 'default' },
    // Design-final: the full bar only appears on the today-todo view; other views show only a slim strip while focus/rest is running (phase + countdown + give up; harvest/noise/minimize hidden)
    slim () { return this.$route.name !== 'todo-list-today' },
    clock () {
      const s = this.s
      const now = this.ts || Date.now() // reactive ts: both cross-window sync and the per-second poll reliably trigger recomputation
      if ((s.status === 'startTomatoTime' || s.status === 'startRestTime') && s.startedAt) {
        const total = (s.status === 'startRestTime' ? s.restTime : s.tomatoTime) * 60
        const elapsed = Math.max(0, Math.floor((now - s.startedAt) / 1000)) // clamped to 0 so a negative fraction does not floor to -1 (25:01 flicker at click instant)
        return this.fmt(Math.max(0, total - elapsed))
      }
      return this.fmt((s.tomatoTime || 25) * 60)
    },
    attachName () { return this.s.attachTodo ? this.s.attachTodo.taskContent : '' },
    statusText () {
      if (this.isRest) return this.$t('statsE.TomatoBar.restingStatus')
      if (this.isWork) return this.$t('statsE.TomatoBar.focusingStatus')
      return this.attachName ? this.$t('statsE.TomatoBar.readyPrefix') + this.attachName : this.$t('statsH.TomatoBar.notStarted')
    },
    todayDone () {
      const key = dayjs().format(FMT.date)
      return (this.s.tomatoRecordList || []).filter(r => r.succeed !== false && r.dateKey === key).length
    },
    /* The ledger-dot spotlight triggers only at the instant the first pomodoro lands (0→1 jump);
       it must never trigger off "today already has completions" — otherwise every refresh would force a screen overlay once (incident reported by user testing) */
    todayTarget () { return Number(this.$store.state.settings.dailyTomatoTarget) || 8 },
    targetReached () { return this.todayDone >= this.todayTarget },
    focusedMinText () {
      // Minutes focused this session (for display in the abandon modal)
      if (!this.isWork || !this.s.startedAt) return '0'
      return String(Math.max(0, Math.floor((Date.now() - this.s.startedAt) / 60000)))
    },
    attachCandidates () {
      return [...this.$store.state.todo.views.todayTodoList].filter(t => !t.complete).slice(0, 30)
    },
    playText () {
      if (this.isWork) return this.$t('statsE.TomatoBar.giveUpFocusBtn')
      if (this.isRest) return this.$t('statsE.TomatoBar.giveUpBreakBtn')
      return this.$t('statsE.TomatoBar.pomodoroTitle')
    }
  },

  mounted () {
    this._iv = setInterval(() => {
      this.ts = Date.now() // completion check / bookkeeping live in store/tomato's shared tick (dispatched per window by main.js); this only refreshes the display
      // While idle (non-running) the status does not change; push once after each flip instead of pushing IPC every second
      const st = this.$store.state.tomato
      // Remaining seconds sourced like pushTaskbar (the component has no remainSec data field; it used to be always undefined, freezing the taskbar countdown after phase switches)
      const sig = (st.status || '') + ':' + (st.status && st.status !== 'default' ? Math.floor(this.remainSecNow() / 60) : '')
      if (sig !== this._lastTbSig) { this._lastTbSig = sig; this.pushTaskbar() }
      // Re-align the float window's real visibility every 15s (tray/shortcut closing the float bypasses this component, so the local toggle state drifts)
      this._floatSyncN = (this._floatSyncN || 0) + 1
      if (this._floatSyncN >= 15 && window.todoAPI && window.todoAPI.tomatoFloatShown) {
        this._floatSyncN = 0
        window.todoAPI.tomatoFloatShown().then(v => { this.floatOn = !!v }).catch(() => {})
      }
    }, 1000)
    // Taskbar thumbnail toolbar button callback (abandon; the pomodoro has no pause semantics)
    if (window.todoAPI && window.todoAPI.onTomatoTaskbarCmd) {
      this._offTaskbar = window.todoAPI.onTomatoTaskbarCmd(({ action }) => {
        if (action === 'giveup') {
          // Same confirm dialog as the in-app abandon entries (was a silent record:true give-up here; consolidated 2026-09-01)
          store.commit('ui/openTomatoAbandon')
        }
      })
    }
    // The float button's "on" state follows the main process float window's actual visibility (the float window can be closed from the tray or itself; tracking it inside the component would drift)
    if (window.todoAPI && window.todoAPI.tomatoFloatShown) {
      window.todoAPI.tomatoFloatShown().then(v => { this.floatOn = !!v }).catch(() => {})
    }
  },
  beforeUnmount () {
    this._unmounted = true // pending pips-tour setTimeout callbacks use this to skip popping
    clearInterval(this._iv)
    if (typeof this._offTaskbar === 'function') this._offTaskbar() // the browser shim once downgraded it to a Promise (non-function); a bare truthiness check would crash
    // Clear taskbar traces on unmount, preventing leftover progress bar/countdown title from the previous session
    // Not cleared while focus is running (avoids the countdown flashing blank for a beat on future remounts/refactors)
    if (!this.isRunning && window.todoAPI && window.todoAPI.pushTomatoTaskbar) window.todoAPI.pushTomatoTaskbar({ status: 'default' })
  },
  watch: {
    todayDone () { this.maybePipsTour() }
  },
  methods: {
    /* 0→1 跳变引导触发器:有副作用+异步动作,必须以 method 形式存在(computed 语义不成立) */
    maybePipsTour () {
      const prev = this._prevTodayDone
      this._prevTodayDone = this.todayDone
      if (this.todayDone < 1 || this._pipsTourDone) return
      if (prev !== 0) return // only a real 0→1 jump within this session teaches; users starting with existing completions get no popup
      import('../utils/onboardingTours.js').then(mod => {
        if (mod.tourSeenState().pips) { this._pipsTourDone = true; return }
        this._pipsTourDone = true
        setTimeout(() => { if (!this._unmounted) mod.runTour('pips', true) }, 800)
      }).catch(() => {})
    },
    fmt (n) { return formatMMSS(n) },
    /** Remaining seconds (same source as clock: derived from startedAt while running, frozen when paused, full amount when idle); shared by the taskbar signature and push */
    remainSecNow () {
      const s = this.s
      const running = this.isWork || this.isRest
      const total = (this.isRest ? s.restTime : s.tomatoTime) * 60
      const now = this.ts || Date.now()
      return running && s.startedAt
        ? Math.max(0, total - Math.max(0, Math.floor((now - s.startedAt) / 1000)))
        : total
    },
    /** Taskbar trio status push (progress bar / title countdown / thumbnail toolbar; todoAPI only exists on desktop) */
    pushTaskbar () {
      if (!window.todoAPI || !window.todoAPI.pushTomatoTaskbar) return
      const s = this.s
      const total = (this.isRest ? s.restTime : s.tomatoTime) * 60
      const remainSec = this.remainSecNow()
      window.todoAPI.pushTomatoTaskbar({
        status: s.status || 'default',
        totalSec: total,
        remainSec,
        todayDone: this.todayDone,
        overlayDesc: this.$t('statsE.TomatoBar.todayHarvestPrefix'),
        phaseText: this.isRest ? this.$t('statsE.TomatoBar.restingStatus') : this.$t('statsE.TomatoBar.focusingStatus'),
        btnStopText: this.isRest ? this.$t('statsE.TomatoBar.giveUpBreakBtn') : this.$t('statsE.TomatoBar.giveUpFocusBtn')
      })
    },
    async onPlayClick () {
      if (this.status === 'default') {
        store.dispatch('tomato/startFocus') // white noise is played automatically by the global dispatcher per focus state
        return
      }
      // Abandoning (focus or break) needs a second confirmation to prevent accidental clicks; when abandoning focus a reason may optionally be filled in (for retrospective; may be left empty)
      if (this.isRest) {
        try { await this.$confirm(this.$t('statsE.TomatoBar.giveUpBreakConfirm'), this.$t('statsH.TomatoBar.tip'), { type: 'warning', confirmButtonText: this.$t('statsH.TomatoBar.giveUp'), cancelButtonText: this.$t('statsH.TomatoBar.continueText') }) } catch (e) { return }
        this.$store.dispatch('tomato/giveUp', { record: false }) // noise stop is handled by the global dispatcher
        return
      }
      // The modal is rendered independently at the layout level (nested inside the tomato bar it gets squeezed into a tiny box by the small container; verified by the user)
      this.$store.commit('ui/openTomatoAbandon')
    },
    // Unified single entry via the attach action: a direct commit patch bypasses lookup/validation semantics (same class of incident as _dragPlan)
    cancelAttach () { store.dispatch('tomato/attach', null) },
    openPanel () { store.commit('ui/toggleTomatoPanel', true) },
    // Following the common showTomatoRecordList pattern: open the modal then fetch data; with no records, show a message instead of the modal
    showRecordList () {
      if (!(this.s.tomatoRecordList || []).length) { this.$message.info(this.$t('statsE.TomatoBar.noHarvestMsg')); return }
      store.commit('ui/toggleTomatoFocusRecord', true)
    },
    onAttachChange (id) {
      // The id is resolved inside the action; when the local todoList lags behind the broadcast and find misses, it no longer silently nulls attachTodo
      store.dispatch('tomato/attach', id || null)
    },


    async toggleFloat () {
      if (!window.todoAPI) return
      if (this.floatOn) { window.todoAPI.hideTomatoFloat() } else { window.todoAPI.showTomatoFloat() }
      this.floatOn = !this.floatOn
      // Calibrated against the main process's real visibility (after the tray closes the float, a local optimistic flip once drifted into a reversed no-op)
      await new Promise(r => setTimeout(r, 300))
      try { this.floatOn = !!(await window.todoAPI.tomatoFloatShown()) } catch { /* keep optimistic */ }
    },

  },

}
</script>
