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
        <div class="tomato__beads" :aria-label="$t('statsB.TomatoFloatPage.beadsAria')">
          <i v-for="k in beadsTotal" :key="k" :class="{done: k <= beadsDone}"></i>
        </div>
      </div>

      <div class="tomato__corner">
        <button type="button" class="corner-btn" :title="$t('statsP.TomatoFloatPage.titleMin')" @click="minimize"><i class="btn-min"></i></button>
        <button type="button" class="corner-btn corner-btn--muted" :title="abandoning ? $t('statsB.TomatoFloatPage.close') : $t('statsP.TomatoFloatPage.titleReset')" @click="abandoning ? cancelAbandon() : reset()"><i class="btn-close"></i></button>
        <button type="button" class="corner-btn" :class="{'corner-btn--on': menuOpen, 'corner-btn--off': abandoning}"
                :title="$t('statsP.TomatoFloatPage.titleMenu')"
                :aria-expanded="menuOpen ? 'true' : 'false'"
                @click="toggleMenu"><i class="btn-dots"></i></button>
        <button type="button" class="corner-btn corner-btn--note" :class="{'corner-btn--on': noiseOpen}"
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
      <div class="tomato__knob" role="button" tabindex="0"
           :title="working ? $t('statsE.TomatoBar.giveUpFocusBtn') : (resting ? $t('statsE.TomatoBar.giveUpBreakBtn') : $t('statsP.TomatoFloatPage.titleStart'))"
           @click="btnMain" @keydown.enter.prevent="btnMain">
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
          <button type="button" class="tf-menu__x close-x close-x--sm" :aria-label="$t('statsB.TomatoFloatPage.close')" @click="closeMenu"></button>
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
/** Standalone pomodoro float window page — final form (finalized 2026-08-31: "ultra-light gray outline + ring knob"):
 *  Pure white card face (interior never changes color by phase) + 1px ultra-light gray outline; the only progress element = the ring knob at bottom-right
 *  (arc = remaining ratio, cyan for focus / orange for rest, ring center ▶/❚❚, click = start / abandon confirm); large time digits + small phase label,
 *  attached task row (✕ to detach), today's pomodoro beads (settings.dailyTomatoTarget is the total).
 *  No white flash on completion (user-finalized); during rest the badge pops out from the left of the ring.
 *  Top-right mini buttons: minimize / close (abandon + reset) / ⋮ task menu (picking a task only attaches it without starting; can rebind at any phase).
 *  The ⋮ menu and abandon dialog share the "temporarily enlarged window" mechanism; the browser debug host uses widget-preview (class-name enlargement).
 *  Note: never pop a native dialog on a transparent frameless window — Windows will paint a system title bar onto the host window. */
import { formatMMSS } from '../utils/tomatoShared.js'
import { NOISES } from '../utils/mediaRegistry.js'

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
      abandonReason: '',
      menuOpen: false,
      noiseOpen: false,
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
    clock () {
      if (this.remaining == null) return '--:--'
      return formatMMSS(this.remaining)
    },
    knobIcon () { return this.working ? '❚❚' : '▶' },
    focusedMinText () {
      const s = this.st
      if (!this.working || !s || !s.startedAt) return '0'
      return String(Math.max(0, Math.floor((Date.now() - s.startedAt) / 60000)))
    },
    /* During abandon confirm: another presentation of the same info — the big digits switch
       from countdown to a forward-counting "focused for", showing the user's decision
       quantity (this focus session) as live data instead of repeating it in static small text */
    displayClock () {
      if (this.abandoning && this.working && this.st && this.st.startedAt) {
        return formatMMSS(Math.max(0, Math.floor((this.now - this.st.startedAt) / 1000)))
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
    /* Today's todo candidates: same criteria as the main window's tomato bar attachCandidates; computed as fallback when views aren't ready */
    tasks () {
      const root = this.$store.state.todo || {}
      let list = (root.views && root.views.todayTodoList) || []
      if (!list.length) {
        const today = window.dayjs ? +window.dayjs().format('YYYYMMDD') : 0
        list = (root.todoList || []).filter(t => t && !t.delete && t.dayStart === today)
      }
      return list.filter(t => t && !t.complete).slice(0, 30)
    }
  },
  methods: {
    read () { return this.$store.state.tomato },
    refresh () {
      this.st = this.read()
      const s = this.st
      let remain = (s.tomatoTime || 25) * 60
      if ((s.status === 'startTomatoTime' || s.status === 'startRestTime') && s.startedAt) {
        const total = (s.status === 'startRestTime' ? s.restTime : s.tomatoTime) * 60
        remain = Math.max(0, total - Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)))
      }
      this.remaining = remain
      // If the dialog is open but focus has already ended elsewhere (finished/ended elsewhere), auto-collapse — otherwise title and body desync
      if (this.abandoning && s.status !== 'startTomatoTime') this.abandoning = false
    },
    /* Window height decision log (second pass, 2026-09-02): constant 240×320; expanding/collapsing the ⋮ menu / ♪ noise / abandon confirm
       are all pure CSS animations inside the window (GPU-composited = buttery), the OS never resizes. Idle transparent empty areas are
       handled by main-process polled click-through (click-through whenever the cursor is outside interactive areas, never blocking the desktop);
       the DWM ghost title is cut off at the root by clearing the window title.
       (The content-fit approach — 86 idle / 320 expanded — was rejected: every expand/collapse needs an OS-level setBounds,
       the fade-out gets hard-clipped and races the CSS animation, losing all smoothness — user decided to return to constant height.)
       syncPanel only reports "an expandable layer exists" so the hit area extends to the full window. */
    syncPanel () {
      if (this.preview) return
      if (!window.todoAPI || !window.todoAPI.tomatoFloatPanel) return
      window.todoAPI.tomatoFloatPanel(!!(this.menuOpen || this.noiseOpen))
    },
    /* Abandon layer open/close = full-window recomposite, which brings DWM right-angle rectangle ghost repaints
       (confirmed by user screenshots; even after roundedCorners:false removed the native right-angle layer,
       residue may remain) — wipe once in place after the transition ends (most reliable erasure method tested in this project) */
    flushGhost () {
      if (this.preview) return
      if (window.todoAPI && window.todoAPI.flushTomatoFloat) window.todoAPI.flushTomatoFloat()
    },
    btnMain () {
      const s = this.st
      if (!s) return
      if (s.status === 'default') { this.$store.dispatch('tomato/startFocus'); return }
      // Click while running/resting = abandon confirm (no pause for the pomodoro — user-finalized)
      this.reset()
    },
    reset () {
      const s = this.st
      if (!s) return
      if (s.status === 'default') { this.persist({ status: 'default', startedAt: 0, remainSec: (s.tomatoTime || 25) * 60 }); return }
      // Abandoning during rest shows no confirm (user-finalized): nothing is logged, no cost, return straight to ready; the confirm dialog is only for focus
      if (s.status === 'startRestTime') { this.$store.dispatch('tomato/giveUp', { record: false }); return }
      this.abandonReason = ''
      this.abandoning = true
    },
    persist (patch) { this.$store.commit('tomato/patch', patch); this.st = this.$store.state.tomato },
    minimize () { if (window.todoAPI) window.todoAPI.hideTomatoFloat() },
    confirmAbandon () {
      this.$store.dispatch('tomato/giveUp', { record: this.working, reason: this.abandonReason })
      this.abandoning = false
    },
    cancelAbandon () {
      this.abandoning = false
    },
    /* ⋮ task menu: openable at any phase (running = switch attachment); mutually exclusive with the ♪ noise panel */
    toggleMenu () {
      if (this.abandoning) return
      this.menuOpen = !this.menuOpen
      if (this.menuOpen) this.noiseOpen = false
    },
    /* White noise selector bar: never expands during abandon confirm (avoid stacked states), otherwise openable anytime; mutually exclusive with the task menu */
    toggleNoisePanel () {
      if (this.abandoning) return
      this.noiseOpen = !this.noiseOpen
      if (this.noiseOpen) this.menuOpen = false
    },
    closeMenu () {
      this.menuOpen = false
    },
    /* Picked task: attach only, never start (starting is up to the user via the main knob) */
    pickTask (taskId) {
      this.$store.dispatch('tomato/attach', taskId)
      this.menuOpen = false
    },
    /* White noise switch: only writes the sound choice; play/stop is followed automatically by the global dispatcher per focus state; collapse back to the card on selection */
    pickNoise (id) {
      // Use the action, not the mutation: only the update action calls todoAPI.updateSettings → config.json; the original mutation keeps the sound choice out of the recovery channel
      this.$store.dispatch('settings/update', { whiteNoiseAudio: id })
      this.noiseOpen = false
    },
    cancelAttach () {
      this.$store.dispatch('tomato/attach', null)
    },
    footerAction () {
      /* The footer button is always "detach": only clears the selection, never binds a start (focus belongs solely to the ring knob) */
      this.cancelAttach()
      this.menuOpen = false
    },
    /* Whole-card drag — left button only, excluding button area/menu/dialog; exclude first, then setPointerCapture
       (capture redirects subsequent clicks to the captured element, so buttons would never receive the click) */
    startDrag (e) {
      if (this._dragging) this.stopDrag()
      if (e.button !== 0) return
      const t = e.target
      if (this._isCardInteractive(t)) return
      this._dragging = true
      this._dragPointerId = e.pointerId
      this._dragTarget = e.currentTarget
      if (this._dragTarget.setPointerCapture) {
        try { this._dragTarget.setPointerCapture(this._dragPointerId) } catch (err) { /* already released, etc. */ }
      }
      if (window.todoAPI) window.todoAPI.startTomatoFloatDrag()
      e.preventDefault()
    },
    /* Interactive areas on the card (buttons/menu/dialog) — one shared exclusion list for drag and double-click */
    _isCardInteractive (t) {
      return !!(t && t.closest && (t.closest('.tomato__corner') || t.closest('.tf-menu') || t.closest('.tomato__knob') || t.closest('.tomato__task-x') || t.closest('.tf-abandon') || t.closest('.tf-noise')))
    },
    /* Double-click empty card area = summon main window (added 2026-09-02): the float window is non-activatable (focusable:false),
       summoning goes through the main process showMainOrLock (covering lock-screen state redirect to the lock window,
       and all branches for rebuilding a destroyed main window) */
    onCardDblClick (e) {
      const t = e.target
      if (this._isCardInteractive(t)) return
      if (window.todoAPI && window.todoAPI.showMainFromFloat) window.todoAPI.showMainFromFloat()
    },
    stopDrag (e) {
      if (!this._dragging) return
      if (e && e.pointerId != null && e.pointerId !== this._dragPointerId) return
      this._dragging = false
      const t = this._dragTarget
      if (t && t.hasPointerCapture && t.hasPointerCapture(this._dragPointerId)) t.releasePointerCapture(this._dragPointerId)
      this._dragPointerId = null
      this._dragTarget = null
      if (window.todoAPI) window.todoAPI.stopTomatoFloatDrag()
    }
  },
  mounted () {
    if (this.preview) {
      document.documentElement.classList.add('widget-preview')
    } else {
      document.documentElement.classList.add('widget-transparent')
      // The window title gets overridden by document.title (BrowserWindow's title:'' is only the pre-load default),
      // and that title text is exactly what DWM ghost repaints draw — the float page must clear it itself to cut it off at the root (2026-09-02)
      document.title = ''
      if (window.todoAPI) window.todoAPI.setTomatoFloatBounds()
    }
    this.refresh()
    this._onStorage = () => this.refresh()
    window.addEventListener('storage', this._onStorage)
    this._onKey = e => {
      if (e.key !== 'Escape') return
      if (this.menuOpen) this.closeMenu()
      this.noiseOpen = false
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
  },

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
.tf-menu__tick { flex-shrink: 0; font-style: normal; font-size: 10px; color: var(--brand, #0f9d8f); }
.tf-menu__empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 16px 0; }
.tf-menu__bare {
  flex-shrink: 0; margin-top: 6px; padding: 6px;
  border: 1px dashed var(--line-strong, #e4e7ed); border-radius: var(--radius-sm, 4px);
  background: none; color: var(--text-2); font-size: 12px; cursor: pointer;
}
.tf-menu__bare:hover { border-color: var(--brand); color: var(--brand); }
html.dark .corner-btn { color: rgba(232,237,241,.65); }
html.dark .corner-btn:hover { background: rgba(53,194,174,.18); }
html.dark .corner-btn--muted { color: rgba(232,237,241,.35); }
/* ⋮ 菜单深色 */
html.dark .tf-menu { background: #22262e; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
html.dark .tf-menu__title { color: #7fd0c7; }
html.dark .tf-menu__x { color: rgba(232,237,241,.55); }
html.dark .tf-menu__x:hover { background: rgba(255,255,255,.1); color: #e8edf1; }
html.dark .tf-menu__item { color: #e8edf1; }
html.dark .tf-menu__item:hover { background: rgba(53,194,174,.15); color: #7fd0c7; }
html.dark .tf-menu__item--on, html.dark .tf-menu__item--on:hover { background: rgba(53,194,174,.18); color: #7fd0c7; }
html.dark .tf-menu__tick { color: #35c2ae; }
html.dark .tf-menu__empty { color: rgba(232,237,241,.4); }
html.dark .tf-menu__bare { border-color: rgba(255,255,255,.16); color: rgba(232,237,241,.7); }
html.dark .tf-menu__bare:hover { border-color: #35c2ae; color: #7fd0c7; }
/* ⋮ 菜单内：白噪音选择区（音色 chips 实时切换，全局派发器即时生效） */
.tf-menu__noise { padding-top: 6px; border-top: 1px solid rgba(120, 130, 140, .18); }
.tf-menu__noise-label { font-size: 9px; color: var(--text-3, #9aa0a6); margin-bottom: 4px; }
.tf-menu__noise .tf-menu__item { font-size: 10px; padding: 4px 8px; }
.tf-menu__noise .tf-menu__item--on, .tf-menu__noise .tf-menu__item--on:hover { background: rgba(15, 157, 143, .12); }
/* 放弃面板内容精简后：卡片 86 → 100px 容纳三行 */
/* 放弃面板精简后 86px 原尺寸即可容纳：卡片不再生长（用户实测「空间够就不用变大」） */

/* ==================== 浮窗角钮图标 · mask+currentColor（深浅主题自适应） ====================
   旧版图标=固定灰色背景图：深色卡面上对比度不足（用户实测"三个钮看不到"）。
   mask 用形状 alpha，颜色走 currentColor 跟随主题；作用域限定浮窗角钮，不波及他处同名类。 */
.corner-btn { color: #8a9096; }
html.dark .corner-btn { color: rgba(232, 237, 241, .78); }
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
.corner-btn:focus-visible { outline: 2px solid var(--brand, #0f9d8f); outline-offset: 1px; }
.tomato .corner-btn i { transition: transform .18s cubic-bezier(.2, .8, .2, 1); }
.tomato .corner-btn:hover:not(.corner-btn--off) i { transform: scale(.88); }
.tomato .corner-btn--off:active { transform: none; }
html.dark .corner-btn:focus-visible { outline-color: #35c2ae; }
/* ==================== ⋮ 菜单展开 · 动效收尾（2026-09-01） ====================
   入场已有：卡片 86→320px 0.2s 弹性生长 + 内容 tt-fade-in 同步淡入；
   出场补齐：tf-pop 过渡 0.18s 淡出（组件层 transition），不再 v-if 硬切。
   列表滚动条细体化：240px 玻璃卡里默认粗滚动条喧宾夺主。 */
.tf-menu .tf-menu__list { scrollbar-width: thin; scrollbar-color: rgba(120,130,140,.35) transparent; }
.tf-menu .tf-menu__list::-webkit-scrollbar { width: 4px; }
.tf-menu .tf-menu__list::-webkit-scrollbar-thumb { background: rgba(120,130,140,.35); border-radius: 2px; }
.tf-menu .tf-menu__list::-webkit-scrollbar-track { background: transparent; }
html.dark .tf-menu .tf-menu__list { scrollbar-color: rgba(232,237,241,.25) transparent; }
html.dark .tf-menu .tf-menu__list::-webkit-scrollbar-thumb { background: rgba(232,237,241,.25); }
/* 勾选框选中图标白色（icon-done.svg 源文件为黑色，反相成纯白，
   对应设计稿 fa check-square 白色图形叠在 #0f9d8f 底上） */
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
  background: var(--brand, #0f9d8f);
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
.tf-noise__tick { flex-shrink: 0; font-style: normal; font-size: 10px; color: var(--brand, #0f9d8f); }
.tf-noise .tf-noise__list { scrollbar-width: thin; scrollbar-color: rgba(120,130,140,.35) transparent; }
.tf-noise .tf-noise__list::-webkit-scrollbar { width: 4px; }
.tf-noise .tf-noise__list::-webkit-scrollbar-thumb { background: rgba(120,130,140,.35); border-radius: 2px; }
.tf-noise .tf-noise__list::-webkit-scrollbar-track { background: transparent; }
</style>
