<template>

  <div class="tomato-panel">
    <header>
      <b><i class="ico" style="--ico:url('app://app/assets/img/icon-tomato-timer2.svg');width:16px;height:16px"></i> {{ $t('statsD.TomatoPanel.title') }}</b>
      <span class="tp-count">{{ $t('statsD.TomatoPanel.today', { n: s.todayTomatoCount||0 }) }}</span>
      <span class="ml-auto"></span>
      <button class="mini" @click="openFloatWindow" :title="$t('statsD.TomatoPanel.floatTitle')">{{ $t('statsD.TomatoPanel.float') }}</button>
      <button class="mini close-x" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click="closePanel"></button>
    </header>
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
import store from '../store/index.js'

export default {
  name: 'TomatoPanel',
  data () { return { remaining: 1500 } },
  computed: {
    s () { return this.$store.state.tomato },
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
    openFloatWindow () {
      // Use the main process frameless float window (same channel as the Settings page toggle) instead of a plain window.open popup
      if (window.todoAPI && window.todoAPI.showTomatoFloat) window.todoAPI.showTomatoFloat()
      store.commit('ui/toggleTomatoPanel', false)
    },
    recalc () {
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
