<template>

  <div class="today-x">
    <div class="tx-flow">
      <div class="tx-toolbar">
        <day-date-strip/>
        <button class="tx-drawer-btn" :class="{on:drawerOpen}" @click="toggleDrawer">{{ drawerOpen ? $t('statsE.TodayX.drawerClose') : $t('statsE.TodayX.drawerOpen') }}</button>
      </div>

      <div class="tx-sec"><span>{{ $t('statsE.TodayX.now') }}</span><span class="tx-clock">{{ tick > -1 ? dayjs().format('HH:mm:ss') : '' }}</span></div>
      <div class="tx-now" v-if="nowTask">
        <div class="tx-now__main">
          <div class="tx-now__tag">{{ running ? $t('statsE.TodayX.focusingTag', { n: nowRound }) : $t('statsE.TodayX.selectedTag') }}</div>
          <div class="tx-now__title">{{ nowTask.taskContent }}</div>
          <div class="tx-now__meta">
            <span>{{ $t('statsE.TodayX.estN', { n: estimateOf(nowTask.taskId) }) }}</span>
            <span>{{ $t('statsE.TodayX.doneN', { n: tomatoActualOf(nowTask.taskId) }) }}</span>
          </div>
        </div>
        <div class="tx-now__side">
          <template v-if="running">
            <div class="tx-now__timer">{{ timerLabel }}</div>
            <button class="tx-giveup" @click="askGiveUp">{{ $t('statsE.TodayX.giveUp') }}</button>
          </template>
          <template v-else>
            <div class="tx-now__timer tx-now__timer--idle">{{ idleTimerLabel }}</div>
            <button class="tx-startbtn" @click="startSelected">{{ $t('statsE.TodayX.startBtn') }}</button>
          </template>
        </div>
      </div>
      <div class="tx-now tx-now--idle" v-else>
        <div class="tx-now__main">
          <div class="tx-now__tag">{{ $t('statsE.TodayX.idleTag') }}</div>
          <div class="tx-now__idle">{{ $t('statsE.TodayX.idleHint') }}</div>
        </div>
      </div>

      <div class="tx-sec"><span>{{ $t('statsE.TodayX.settled') }}</span><span class="tx-cnt">{{ settled.length }}</span></div>
      <div class="tx-settled" v-if="settled.length">
        <div v-for="r in settled" :key="r.key" class="tx-settled__row">
          <span class="tx-settled__time">{{ r.time }}</span>
          <i class="tx-settled__dot"></i>
          <span>{{ $t('statsE.TodayX.focusMin', { n: r.dur }) }} · {{ r.title }}</span>
        </div>
      </div>
      <div class="tx-chips" v-if="doneChips.length">
        <span class="tx-chip" v-for="(c,i) in doneChips" :key="i"><app-icon name="check" :size="11"/>{{ c }}</span>
      </div>

      <div class="tx-sec"><span>{{ $t('statsE.TodayX.next') }}</span><span class="tx-cnt">{{ groups.reduce((n,g)=>n+g.todos.length,0) }}</span></div>
      <todo-groups :groups="groups"/>
    </div>

    <div class="tx-drawer" :class="{open:drawerOpen}">
      <div class="tx-drawer__head">{{ $t('statsE.TodayX.drawerTitle') }}</div>
      <day-rail/>
    </div>
  </div>
</template>

<script lang="ts">
import { FMT, dayjs } from '../utils/core.js'
import { getEstimate } from '../utils/tomatoEstimate.js'
import { remainSecOf, formatMMSS } from '../utils/tomatoShared.js'
import DayDateStrip from '../components/DayDateStrip.vue'
import DayRail from '../components/DayRail.vue'
import TodoGroups from '../components/TodoGroups.vue'

const nowHm = ts => dayjs(ts).format('HH:mm')

const X_CSS = `
.today-x{display:flex;gap:16px;align-items:flex-start;padding:0 4px 20px}
.tx-flow{flex:1;min-width:0}
.tx-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.tx-toolbar .day-strip{flex:1;margin-bottom:0}
.tx-drawer-btn{border:1px solid var(--brand);color:var(--brand);background:none;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;white-space:nowrap;flex-shrink:0}
.tx-drawer-btn:hover,.tx-drawer-btn.on{background:var(--brand);color:#fff}
.tx-sec{display:flex;justify-content:space-between;align-items:center;margin:16px 2px 8px;font-size:11px;color:var(--text-3);letter-spacing:.5px}
.tx-cnt{background:var(--gray);border-radius:8px;padding:0 7px;font-size:10px}
.tx-clock{font-variant-numeric:tabular-nums}
.tx-now{background:linear-gradient(135deg,var(--brand),var(--brand-dark));border-radius:14px;padding:18px 20px;color:#fff;display:flex;gap:24px;align-items:center;box-shadow:var(--shadow)}
.tx-now--idle{background:var(--panel);border:1px dashed var(--line);box-shadow:none;color:var(--text-3)}
.tx-now__main{flex:1;min-width:0}
.tx-now__tag{font-size:11px;opacity:.9}
.tx-now__title{font-size:19px;font-weight:700;margin-top:6px}
.tx-now__meta{display:flex;gap:14px;margin-top:8px;font-size:12px;opacity:.92}
.tx-now__side{text-align:center;flex-shrink:0}
.tx-now__timer{font-size:40px;font-weight:700;font-variant-numeric:tabular-nums}
.tx-giveup{margin-top:10px;background:rgba(0,0,0,.18);color:#fff;border:0;border-radius:9px;padding:8px 18px;font-size:12px;cursor:pointer}
.tx-giveup:hover{background:var(--danger, #e9484d)}
.tx-now__idle{font-size:13px;margin-top:6px}
.tx-settled{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.tx-settled__row{display:flex;align-items:center;gap:9px;font-size:12px;color:var(--text-2);padding:3px 0}
.tx-settled__time{color:var(--text-4);font-variant-numeric:tabular-nums;flex-shrink:0}
.tx-settled__dot{width:5px;height:5px;border-radius:50%;background:var(--brand);flex-shrink:0}
.tx-chips{display:flex;gap:8px;flex-wrap:wrap}
.tx-chip{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 10px;font-size:11.5px;color:var(--text-3)}
.tx-tasks{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:4px 0}
.tx-now__timer--idle{opacity:.5}
.tx-startbtn{border:0;background:var(--panel, #fff);color:var(--brand-dark);font-weight:600;border-radius:9px;padding:9px 20px;font-size:12px;cursor:pointer}
.tx-startbtn:hover{background:var(--brand-light);color:var(--brand-dark)}
.tx-empty{padding:8px 2px;font-size:12px;color:var(--text-4)}
.tx-drawer{width:0;overflow:hidden;transition:width .3s cubic-bezier(.2,.8,.2,1);flex-shrink:0}
.tx-drawer.open{width:340px}
.tx-drawer__head{font-size:12px;color:var(--text-3);padding:2px 0 8px}
.today-x .day-rail{position:static;height:auto;display:flex}
`

function injectXStyle () {
  if (document.getElementById('today-x-style')) return
  const el = document.createElement('style')
  el.id = 'today-x-style'
  el.textContent = X_CSS
  document.head.appendChild(el)
}

export default {
  name: 'TodayXView',
  components: { DayDateStrip, DayRail, TodoGroups },
  data () {
    return { drawerOpen: false, tick: 0, tickTimer: null }
  },
  computed: {
    v () { return this.$store.state.todo.views },
    tomato () { return this.$store.state.tomato },
    today0 () { return this.$store.state.todo.todayTimestamp },
    /* ---- Now ---- */
    focusing () { return this.tomato.status === 'startTomatoTime' },
    nowTask () { return this.tomato.attachTodo },
    running () { return this.focusing && !!this.tomato.startedAt },
    remainSec () {
      void this.tick
      const s = this.tomato
      if (s.status !== 'startTomatoTime' || !s.startedAt) return s.tomatoTime * 60
      return remainSecOf(s.status, s.startedAt, s.tomatoTime, s.restTime) || 0
    },
    timerLabel () { return formatMMSS(Math.max(0, this.remainSec)) },
    /* Idle state previews the configured focus length instead of a hardcoded 25:00 (aligned with TomatoBar) */
    idleTimerLabel () { return formatMMSS((this.tomato.tomatoTime || 25) * 60) },
    nowRound () { return this.tomatoActualOf(this.nowTask && this.nowTask.taskId) + 1 },
    /* ---- Settled ---- */
    settled () {
      const out = []
      for (const r of (this.tomato.tomatoRecordList || [])) {
        if (r.succeed === false || !r.endTime) continue
        if (dayjs(Number(r.endTime)).format(FMT.date) !== dayjs().format(FMT.date)) continue
        const t = r.focusTaskId && this.$store.state.todo.todoList.find(x => x.taskId === r.focusTaskId)
        out.push({
          key: r.tomatoId, time: nowHm(Number(r.endTime)),
          title: t ? t.taskContent : (r.focus || this.$t('statsE.TodayX.freeFocus')),
          dur: r.focusDuration || 0
        })
      }
      return out.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 6)
    },
    doneChips () { return (this.v.todayDoneList || []).slice(0, 5).map(t => t.taskContent) },
    /* ---- Next (today + overdue uncompleted) ---- */
    /* Grouping is delegated to the generic TodoGroups component: drag sort / click-row edit / hover delete / check / pomodoro select, all interactions retained */
    groups () {
      const g = []
      const undone = this.$store.state.todo.todoList
        .filter(t => !t.delete && !t.complete && t.dayStart && t.dayStart <= this.today0)
        .sort((x, y) => (x.dayStart - y.dayStart) || (x.todoTime - y.todoTime))
      g.push({ key: 'x-next', label: this.$t('statsE.TodayX.next'), todos: undone, count: undone.length })
      const done = this.v.todayDoneList || []
      if (done.length) g.push({ key: 'x-done', label: this.$t('statsE.TodayX.doneGroup'), todos: done, count: done.length })
      const open = this.$store.state.todo.todoList.filter(t => !t.delete && !t.complete && !t.dayStart)
      g.push({ key: 'x-open', label: this.$t('statsE.TodayX.unscheduled'), todos: open, count: open.length })
      return g
    }
  },
  mounted () {
    injectXStyle()
    this.tickTimer = setInterval(() => { this.tick++ }, 1000)
  },
  beforeUnmount () { clearInterval(this.tickTimer) },
  methods: {
    /* Pomodoro ledger: pomodoros already invested in a task (attributed by record, abandoned ones excluded) — O(1) store lookup, do not re-filter the whole list */
    tomatoActualOf (id) {
      if (!id) return 0
      return this.$store.getters['tomato/actualCountByTask'].get(id) || 0
    },
    estimateOf (id) { return getEstimate(id) },

    detach () { this.$store.dispatch('tomato/attach', null) },
    /* Give up focus = first pop the global abandon confirm (reason can be filled in, same flow as the tomato bar/float window); previously this was wrongly wired to detach (only detaches, doesn't abandon, no confirm) */
    askGiveUp () { this.$store.commit('ui/openTomatoAbandon') },
    /* Start selected pomodoro (same semantics as the in-row tomato button in lists: click again to cancel); selecting lights up the "Now" highlight */
    startSelected () { this.$store.dispatch('tomato/startFocus') },
    toggleDrawer () { this.drawerOpen = !this.drawerOpen }
  },

}
</script>
