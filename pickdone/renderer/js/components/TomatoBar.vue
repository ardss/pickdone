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
<style>
/* =====================================================================
   原 style-4.css（已退役 2026-09）—— 番茄专注条 / 设置中心 / 重复任务弹窗 / 小组件窗口 / 番茄浮窗
   本文件样式（沿用既有类名体系）：
   - 构建产物 A   : .tomato-timer* / .fix1 / .icon-link / .cancel-attach-todo
                            base-modal（.modal-container/.modal-tablecloth/.modal*）
                            设置中心（.setting_tabs/.tab-panel/.form-item*）
                            widget 日历下拉菜单
   - 构建产物 B : 浮窗（.floating/.tomato* 等浮窗体系类）
   ===================================================================== */
/* ===== 自 base.css 迁入（番茄记录 tfr-，内容逐字未改；置于头部以保持原级联顺序 base < 本文件）===== */

/* ==================== 番茄专注记录全屏弹窗（对齐.todo-fc 旧版 .tomato-record[scoped-hash]） ==================== */
.tomato-record { padding: 10px 16px; border-bottom: 1px solid var(--line, #f3f3f3); }
btn-play|stop|stop2|close）
   ===================================================================== */

/* ==================== 1. 底部番茄专注条（tomato-timer） ==================== */
/*  */
.tomato-timer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 25px;
  background-color: var(--tomato-bg);
  transition: all .2s;
}
.tomato-timer--work { background-color: var(--tomato-bg); }
.tomato-timer--rest { background-color: #f6e8d1; }
.tomato-timer__status {
  position: relative;
  z-index: 1;
  max-width: 40%;
  color: var(--brand-dark);
  font-weight: 400;
  font-size: var(--fs-sm);
  line-height: 18px;
  transition: all .2s;
}
.tomato-timer__status > div { display: flex; align-items: center; }
.tomato-timer__status > div:first-of-type { margin-bottom: var(--space-1); }
.tomato-timer__status > div > span { min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.tomato-timer__status > div > div:last-of-type { flex-shrink: 0; }
.tomato-timer__status--work { color: var(--brand-dark); }
.tomato-timer__status--rest { color: #f93; }
/* 右侧操作组：贴右缘排布（关联任务/开始专注/完整面板） */
.tomato-timer__right {
  left: auto;
  right: 14px;
  justify-content: flex-end;
  flex-direction: row;
  gap: 14px;
  pointer-events: none;
}
/* 容器穿透点击，但按钮本身必须可点 */
.tomato-timer__right > * { pointer-events: auto; }
.tomato-timer__play,
.tomato-timer__right {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: auto;
}
.tomato-timer__play {
  right: 25px;
  width: 138px;
  height: 48px;
  padding: 0;
  color: #fff;
  font-weight: 400;
  font-size: var(--fs-lg);
  line-height: 21px;
  background-color: #0c8172;
  border: none;
  border-radius: var(--radius-sm);
  transition: all .2s;
}
.tomato-timer__play:focus { outline: 0; box-shadow: 0 0 0 3px rgba(0,140,142,.25); }
.tomato-timer__play:hover { background-color: #008284; }
.tomato-timer__play:active { background-color: #00787a; }
.tomato-timer__play:before {
  display: block;
  width: 16px;
  height: 16px;
  margin-right: 10px;
  content: "";
  background: currentColor;
  -webkit-mask: url('app://app/assets/img/icon-tomato-timer2.svg') center / contain no-repeat;
  mask: url('app://app/assets/img/icon-tomato-timer2.svg') center / contain no-repeat;
}
/* 专注中「■ 放弃专注」品牌青(2026-09-03用户拍板:砖红攻击性太强与品牌不符,放弃语义由文案承载) */
.tomato-timer__play--work { background-color: #bd401e; }
.tomato-timer__play--work:focus { outline: 0; box-shadow: 0 0 0 3px rgba(189,64,30,.25); }
.tomato-timer__play--work:hover { background-color: #b3401e; }
.tomato-timer__play--work:active { background-color: #a9401e; }
/* 休息中：橙色按钮 */
.tomato-timer__play--rest { background-color: #fe9933; }
.tomato-timer__play--rest:focus { outline: 0; box-shadow: 0 0 0 3px rgba(254,153,51,.25); }
.tomato-timer__play--rest:hover { background-color: #f49033; }
.tomato-timer__play--rest:active { background-color: #ea8633; }
/* 大号青色计时数字：点击 = 暂停/继续（实现交互补充） */
.tomato-timer__time {
  color: var(--brand-dark);
  font-weight: 600;
  font-size: 26px;
  line-height: 42px;
  cursor: pointer;
  transition: all .2s;
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
  pointer-events: auto;
}
.tomato-timer__time--rest { color: #f93; }
/* ====== 设计稿精确布局 ====== */
.tomato-bar.tomato-timer {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  flex-shrink: 0;
  padding: 0 25px;
  background-color: var(--tomato-bg);
  transition: all .2s;
  overflow: visible;
}
.tomato-timer--rest { background-color: #f6e8d1; }
.tomato-timer__status {
  position: relative; z-index: 1; max-width: 40%;
  color: var(--brand-text); font-weight: 400; font-size: var(--fs-sm); line-height: 18px;
}
.tomato-timer__status .tb-row {
  display: flex; align-items: center; gap: var(--space-1);
}
.tomato-timer__status .tb-row + .tb-row { margin-top: 5px; }
.tomato-timer__center {
  position: absolute; top: 0; bottom: 0; right: 0; left: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  pointer-events: none;
}
.tomato-timer__center > * { pointer-events: auto; }
.tomato-timer__time {
  color: var(--brand-dark); font-weight: 600; font-size: 26px; line-height: 42px;
  font-variant-numeric: tabular-nums;
}
.tomato-timer__time--rest { color: #fe9933; }
.tomato-timer__play {
  position: absolute; right: 25px; top: 0; bottom: 0; margin: auto;
  width: 138px; height: 48px; padding: 0;
  color: #fff; font-weight: 400; font-size: var(--fs-lg); line-height: 21px;
  border: none; border-radius: var(--radius-sm); transition: all .2s;
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
/* —— 窄条变体：非今日视图专注/休息进行中的兜底形态（相位+倒计时+放弃，收成/白噪音/小窗已 v-if 收起） —— */
.tomato-bar--slim { padding: 0 16px; }
.tomato-bar--slim .tomato-timer__status { max-width: 46%; }
.tomato-bar--slim .tomato-timer__time { font-size: 18px; line-height: 24px; }
.tomato-bar--slim .tomato-timer__play { width: 108px; height: 30px; font-size: var(--fs-sm); }
html[data-theme="dark"] .tomato-bar { background: var(--panel); }
html[data-theme="dark"] .tomato-bar.running { background: var(--tomato-bg); }
/* 番茄计时数字:--brand-dark 暗底对比不足 */
html[data-theme="dark"] .tomato-timer__time { color: var(--brand-bright, #35c2ae); }
html[data-theme="dark"] .tomato-timer__label,
html[data-theme="dark"] .tomato-timer__count { color: var(--text-3); }
@media (max-width: 605px) {
  .tomato-timer__time { margin-right: 0; }
}
@media print {
  .tomato-timer { display: none; }
}
/* 计数徽标=灰底圆角 pill（2026-08-28 用户定稿，同.todo-fc 旧版样式），右缘留 4px 不贴高亮边；warn（过期待办）升级为红色 pill */
.sn-badge { font-variant-numeric: tabular-nums;
  margin-left: auto; margin-right: var(--space-1); font-style: normal; font-size: var(--fs-sm); font-weight: 500;
  line-height: 1; color: var(--text-2); background: var(--gray-bg);
  border-radius: var(--radius-md); padding: 3px 7px;
}
.modal {
  flex-shrink: 0;
  max-height: 100%;
  max-width: 100%;
  background-color: var(--panel, #fff);
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.modal__header {
  position: relative;
  display: flex;
  flex-shrink: 0;
  gap: var(--space-1);
  align-items: center;
  padding: 15px;
  color: var(--brand-dark);
  font-size: var(--fs-base);
  line-height: 18px;
  border-bottom: 1px solid #f3f3f3;
}
.modal__header--header-no-padding { padding: 0; border-bottom: 0 solid #f3f3f3; }
.modal__body { flex: 1; padding: 15px; overflow: auto; }
.modal__body--body-no-padding { padding: 0; }
.modal__footer {
  flex-shrink: 0;
  display: flex;
  gap: 15px;
  align-items: center;
  justify-content: flex-end;
  padding: 15px;
  border-top: 1px solid #f3f3f3;
}
.btn-play {
  width: 14px;
  height: 16px;
  background: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAgCAYAAAABtRhCAAACLElEQVRIS73W0WvTUBTH8e8dnU/W+Qf45rMK/lvKHtI0XaqYC4q01cqoqNCHSUEUHIIU9zJ9mBOkyJiCIGMMEZHhgzqxrbo2yZHY1s6ysqZNdiEQEjif/JJ7DlEEK58/QSLxBFEKn1ks4/nf6zEsBSiuFa8zpYxu/Qa+lHFbV7DtnahNhdZHSR4LEp0dKL6G+FlM82mUaAAeJ5lcBXVqn8K7iJTx3ByZzHYUsCKXmyFxZBXF6eEFZQtfOaSNB4BMAo8IdgnhIfgOprkxLhoODBSRbQRNs34Xrd2wcHiwJ4hU8T0Hy3oTBh0f7KTdAcnRaJTQ+vco8GTgv7Q8w2vbZDJrB6HRgJ20dYQSTXUDbXwbBkcH9oV1PNfGspb3Q+MAA6eNSAXPdQYHRlxgJ5zIBoiNaT7upY0X7KAuwjzt3RzZ7Nf4wf5OPodp3D5E0J/FNG8eEij3aLUcbPt9vKDIF5CrNBp3epMoTnAZZI5U6vXefowD/Ij4l9ncrFAutwebPzow2P6K+91v9SHe0SbyDoVNKlWNe3i3QRbwPI1lfT4IC+5P8krX8b1LpNNLo0ATjDb5BcxTrxfQ+nsYLHxCkZeIf4F0eiUsFC5h0MCiCjR/3ELrn+Ni/YTT0y+G/AgH076Kqy4yZ7ydBOonzOeTJBIBeOa/gsInlDjUahUWF70osE7C4CgWS6DOd4sKwiPa2NjGVlRQP2FwViicZCqxAjKDkOJVbSHKVHsf+g/IPxQwDBpbNAAAAABJRU5ErkJggg==') no-repeat 50%;
  background-size: 14px 16px;
}
.modal--settings {
  width: 680px;
  height: min(78vh, 620px);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
}
/* —— 弹窗卡片统一进场：fade + 上移 + 轻缩放（180ms 快进慢出）。
      .modal 均为 v-if 挂载，动画每次打开自动播放；离场不做（v-if 直接卸载） —— */
.modal { animation: modal-pop .18s cubic-bezier(.2, .8, .2, 1) both; }
/* ==================== 4.5 设置中心:左侧分类导航版式 ==================== */
.modal--settings-center { position: relative; flex-direction: row; width: min(1024px, 94vw); height: min(80vh, 680px); align-items: stretch; }
/* header 曾是 close 的定位锚(position:relative),左导航版式下 header=148px 左列,关闭钮被钉在左列右上角悬在"通用"旁;改锚到整个弹窗,落 dialog 真右上角(主流位置) */
.modal--settings-center .modal__header { position: static; flex-direction: column; align-items: stretch; width: 148px; flex-shrink: 0; padding: 20px 0 0; height: auto; }
/* 垂直居中于搜索行(行高33,close高28→top≈2.5):之前 top:12 使钮心比搜索行心低约10px,一高一低 */
.modal--settings-center .modal__close { position: absolute; top: 3px; right: 12px; margin: 0; z-index: 5; }
@keyframes scBlink { 50% { opacity: .4 } }
</style>
