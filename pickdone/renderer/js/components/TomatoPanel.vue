<template>

  <div class="tomato-panel">
    <header>
      <b><i class="ico" style="--ico:url('app://app/assets/img/icon-tomato-timer2.svg');width:16px;height:16px"></i> {{ $t('statsD.TomatoPanel.title') }}</b>
      <span class="tp-count">{{ $t('statsD.TomatoPanel.today', { n: s.todayTomatoCount||0 }) }}</span>
      <span class="ml-auto"></span>
      <button class="mini" @click="openFloatWindow" :title="$t('statsD.TomatoPanel.floatTitle')">{{ $t('statsD.TomatoPanel.float') }}</button>
      <button class="mini close-x" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click="closePanel"></button>
    </header>
    <!-- Remote running focus (LAN sync announce, display-only): click opens the linked todo -->
    <div v-if="remoteRun" class="tp-remote" role="button" tabindex="0"
         :title="$t('statsD.TomatoPanel.remoteRunningTip')"
         @click="openRemoteTodo" @keydown.enter.prevent="openRemoteTodo">
      <i class="ico" style="--ico:url('app://app/assets/img/icon-tomato-timer2.svg');width:12px;height:12px"></i>
      {{ $t('statsD.TomatoPanel.remoteRunning', { name: remoteRun.deviceName || remoteRun.deviceId, time: remoteClock }) }}
    </div>
    <div class="ring-wrap">
      <svg viewBox="0 0 120 120" class="ring">
        <circle cx="60" cy="60" r="52" class="ring-bg"/>
        <circle cx="60" cy="60" r="52" class="ring-fg" :class="{rest:isRest}"
                stroke-dasharray="326.7" :stroke-dashoffset="326.7*(1-percent/100)" stroke-linecap="round"/>
      </svg>
      <div class="ring-center">
        <div class="phase">{{isRest?$t('statsD.TomatoPanel.phaseRest'):(isWork?$t('statsD.TomatoPanel.phaseWork'):$t('statsD.TomatoPanel.phaseIdle'))}}</div>
        <div class="clock">{{clock}}</div>
      </div>
    </div>
    <div class="cfg-row"><span>{{ $t('statsD.TomatoPanel.focusMinutes') }}</span><el-input-number size="small" :model-value="s.tomatoTime||25" :min="5" :max="180" @change="v=>commitPatch({tomatoTime:v})"/></div>
    <div class="cfg-row"><span>{{ $t('statsD.TomatoPanel.restMinutes') }}</span><el-input-number size="small" :model-value="s.restTime||5" :min="1" :max="60" @change="v=>commitPatch({restTime:v})"/></div>
    <!-- [Removed enableCompleteAudio dropdown]: no playback logic ever reads the tomato store key it wrote (the actual completion sound uses
         settings.completeSound), making it dead UI duplicating the Settings page; the effective completion sound is changed under Settings -> Pomodoro -->
    <section class="tp-records">
      <header>{{ $t('statsD.TomatoPanel.todayRecords') }} <em>{{ $t('statsD.TomatoPanel.countN', { n: todayRecords.length }) }}</em></header>
      <div v-for="r in todayRecords.slice(0,6)" :key="r.tomatoId" class="rec-row">
        <app-icon :name="r.succeed ? 'check' : 'x'" :size="12" :style="{ color: r.succeed ? 'var(--brand)' : 'var(--danger)' }"/>
        <span class="rf">{{r.focus||$t('statsD.TomatoPanel.freeFocus')}}</span>
        <span class="rd">{{ $t('statsD.TomatoPanel.minutesN', { n: r.focusDuration }) }}</span>
        <time>{{dfmt(r.endTime)}}</time>
      </div>
      <div v-if="!todayRecords.length" class="empty-tip">{{ $t('statsD.TomatoPanel.emptyTip') }}</div>
    </section>
  </div>
</template>

<script lang="ts">
/** Full pomodoro settings panel (opened via shortcut / the ⚙ on the bottom bar): ring timer / duration config / today's records / float window */
import {dayjs, FMT } from '../utils/core.js'
import { formatMMSS } from '../utils/tomatoShared.js'
import { remainSecOfAnnounce } from '../store/helpers/tomatoAnnounceShared.js'
import store from '../store/index.js'

export default {
  name: 'TomatoPanel',
  data () { return { remaining: 1500, nowTs: Date.now() } },
  computed: {
    s () { return this.$store.state.tomato },
    /** Remote running focus (live cross-device announce) — display-only chip source. */
    remoteRun () { return this.$store.getters['tomatoAnnounce/primaryRunning'] },
    remoteClock () { return formatMMSS(remainSecOfAnnounce(this.remoteRun, this.nowTs)) },
    isWork () { return this.s.status === 'startTomatoTime' },
    isRest () { return this.s.status === 'startRestTime' },
    percent () {
      const total = (this.isRest ? this.s.restTime : this.s.tomatoTime) * 60 || 1
      return Math.min(100, Math.round((1 - this.remaining / total) * 100))
    },
    clock () {
      // floor semantics consistent across the whole chain: remainSecOf/TomatoBar/float window (the old ceil was off by 1 second: bar showed 24:59 while the panel showed 25:00)
      const n = Math.max(0, Math.floor(this.remaining))
      return formatMMSS(n)
    },
    todayRecords () {
      const key = dayjs().format(FMT.date)
      return this.$store.getters['tomato/recordsByDate'].get(key) || []
    }
  },
  mounted () {
    this.recalc()
    this._iv = setInterval(() => this.recalc(), 500)
  },
  beforeUnmount () { clearInterval(this._iv) },
  methods: {
    dfmt (ts) { return dayjs(ts).format(FMT.time) },
    commitPatch (p) { store.commit('tomato/patch', p) },
    /** Open the remote focus's linked todo (display-only: never starts/stops anything).
     *  P2 (2026-09-19 UX review): an absent/deleted (tombstoned) todo must not click-fail
     *  silently — toast "task not on this device" instead of a silent no-op. */
    openRemoteTodo () {
      const id = this.remoteRun && this.remoteRun.attachTodoId
      const row = id ? (this.$store.state.todo.todoList || []).find(t => t && t.taskId === id && !t.delete) : null
      if (row) store.commit('ui/openEdit', row)
      else if (this.$message) this.$message.warning(this.$t('statsD.TomatoPanel.remoteTodoMissing'))
    },
    openFloatWindow () {
      // Use the main process frameless float window (same channel as the Settings page toggle) instead of a plain window.open popup
      if (window.todoAPI && window.todoAPI.showTomatoFloat) window.todoAPI.showTomatoFloat()
      store.commit('ui/toggleTomatoPanel', false)
    },
    recalc () {
      this.nowTs = Date.now() // remote chip countdown re-derives from the wall clock
      // P1-6 (2026-09-19 UX review): the store getter caches on state, and Date.now() inside it is
      // not reactive — a peer that crashed mid-focus left a ghost chip. This 500ms tick dispatches
      // the store's prune so expired announces drop from the chip without a fresh sync event.
      // Round-3 perf: skip the commit while no peer announce exists — pruning an empty map is a
      // no-op, so an idle panel stops issuing 2Hz Vuex commits.
      try { if (Object.keys(store.state.tomatoAnnounce.remote).length) store.commit('tomatoAnnounce/prune') } catch (e) { /* store not ready */ }
      const s = this.s
      let remain
      if ((s.status === 'startTomatoTime' || s.status === 'startRestTime') && s.startedAt) {
        const total = (s.status === 'startRestTime' ? s.restTime : s.tomatoTime) * 60
        remain = Math.max(0, total - Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000)))
      } else remain = (s.tomatoTime || 25) * 60
      this.remaining = remain
    },
    closePanel () { store.commit('ui/toggleTomatoPanel', false) }
  },

}
</script>
<style>
/* Remote running focus chip (LAN sync announce, display-only) */
.tp-remote { display: flex; align-items: center; gap: 5px; font-size: var(--fs-xs); color: var(--brand); background: var(--brand-light); border-radius: var(--radius-sm); padding: 3px 8px; margin-bottom: 6px; cursor: pointer; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tp-remote:hover { filter: brightness(0.97); }
.tp-remote:focus-visible { outline: 2px solid var(--brand); outline-offset: -1px; }
</style>
