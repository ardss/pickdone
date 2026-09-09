/** 番茄计时状态机。账本(专注记录)唯一事实源 = SQLite tomato_records 行表(2026-09-04 根修):
 *  本文件只持有内存副本供渲染,所有增删改走原子 op 落库 + 主进程广播回灌;LS blob 只存计时瞬态(丢了无所谓)。 */
import { dayjs, safeSet, FMT } from '../utils/core.js'
import { remainSecOf } from '../utils/tomatoShared.js'
import { confirmUrl } from '../utils/mediaRegistry.js'
import { tt } from '../utils/core.js'

const LS_KEY = 'tomatoState'
/** Persistence blob format version: incremented on future incompatible field semantics; readers tolerate old unstamped data as v1 */
const SCHEMA_V = 1
/** Cross-window sync ping key: value is an incrementing write sequence number; receivers use it to skip no-change full re-reads/comparisons */
const PING_KEY = 'tomatoSyncPing'

/** Idempotency token slot for completion transitions: only one set of side effects (notification/audio/snow gain) per entry into a running state; concurrent main+float windows count once */
const CLAIM_KEY = 'tomatoLastPhaseDone'

/** Cross-window phase claiming: for the same startedAt, only the first writer produces side effects (notification/audio/accounting).
 *  Value shape phase|ms: same phase within 1.5s is considered already claimed (narrowing the dual-window get→set race window), otherwise the claim is overwritten. */
function claimPhase (status, startedAt) {
  const phase = status + ':' + (startedAt || 0)
  try {
    const cur = String(localStorage.getItem(CLAIM_KEY) || '')
    const i = cur.lastIndexOf('|')
    if (i > 0 && cur.slice(0, i) === phase && Date.now() - Number(cur.slice(i + 1) || 0) < 1500) return false
  } catch (e) { /* empty */ }
  try { localStorage.setItem(CLAIM_KEY, phase + '|' + Date.now()) } catch (e) { /* empty */ }
  return true
}

const DEF = {
  status: 'default', attachTodo: null, todayTomatoCount: 0, tomatoRecordList: [],
  tomatoTime: 25, restTime: 5, enableNotification: true, enableBeep: true,
  whiteNoiseAudio: '', isEnabledFloatingWindow: false,
  preTomatoTimes: [25], preRestTimes: [5],
  remainSec: 1500, startedAt: 0
}

function loadState (voidExpired = true) {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY))
    if (v && typeof v === 'object') {
      const merged = Object.assign({}, DEF, v)
      // 版本守卫真正接线(此前只写不读=仪式代码):未来版本 blob 拒载回退默认,防降级读取错语义
      if ((merged.schemaV || 1) > SCHEMA_V) return Object.assign({}, DEF)
      const statusMap = { focusing: 'startTomatoTime', resting: 'startRestTime', paused: 'default' }
      if (statusMap[merged.status]) merged.status = statusMap[merged.status]
      // Day rollover reset: startedAt older than 24h or an inactive period → back to default
      if (merged.startedAt && Date.now() - merged.startedAt > 24 * 3600000) {
        merged.status = 'default'; merged.startedAt = 0
      }
      // Only at process startup: an expired in-progress phase is voided outright (no retroactive tomato), preventing "focused last night, free tomato this morning".
      // Cross-window sync (voidExpired=false) must not void — otherwise it would race ahead of the shared tick and silently zero out a focus that should be recorded
      if (voidExpired) {
        if (merged.status === 'startTomatoTime' && Date.now() - merged.startedAt >= merged.tomatoTime * 60000) {
          merged.status = 'default'; merged.startedAt = 0
        }
        if (merged.status === 'startRestTime' && Date.now() - merged.startedAt >= merged.restTime * 60000) {
          merged.status = 'default'; merged.startedAt = 0
        }
      }
      if (merged.status !== 'startTomatoTime' && merged.status !== 'startRestTime') {
        merged.status = 'default'; merged.startedAt = 0
      }
      // Today's tomato count resets across days (window.dayjs is globally available in the renderer)
      const today = window.dayjs().format(FMT.date)
      if (merged._countDate !== today) { merged.todayTomatoCount = 0; merged._countDate = today }
      // 账本已迁行表:blob 里的历史记录字段直接忽略(内存副本由 recordsLoad 从 DB 装载)
      if (Array.isArray(merged.tomatoRecordList)) merged.tomatoRecordList = []
      delete merged.unSyncTomatoRecordList
      return merged
    }
  } catch (e) { /* empty */ }
  return Object.assign({}, DEF)
}

/** Cross-window sync token: each persist generates a unique ping value; the receiver records the "applied" token and skips the full re-read when it matches. */
let lastAppliedPing = null
function newPingToken (seq) {
  return Date.now().toString(36) + ':' + (seq || 0) + ':' + Math.random().toString(36).slice(2, 8)
}

function persistState (state) {
  // Write sequence number: increments once per real disk flush; the ping carries only the sequence, and receivers skip the full re-read when the sequence matches
  state._syncSeq = (state._syncSeq || 0) + 1
  state.schemaV = SCHEMA_V
  // 账本字段从 blob 中剔除(唯一源=DB 行表),blob 只承载计时瞬态与偏好
  const blob = Object.assign({}, state, { tomatoRecordList: [], _recordsInDb: true })
  safeSet(LS_KEY, JSON.stringify(blob))
  const ping = newPingToken(state._syncSeq)
  try { window.localStorage.setItem(PING_KEY, ping) } catch (e) { /* empty */ }
  lastAppliedPing = ping // This window's own write counts as applied
}

/** 账本原子 op 落库(幂等:确定性 tomatoId);失败打日志不静默——账本是核心资产。
 *  退出冲刷:pending 账本写挂到 app-quitting-flush(完成番茄后立刻退出是丢账最高频场景,三轮深审发布 blocker);
 *  失败留在重试队列,下一次任意账本写时重放(锁屏/瞬时 IO 失败自愈)。 */
const _pendingLedger = []
let _flushHooked = false
/** Replay still-pending entries; each is only removed from the queue on success (ledger ops are idempotent upserts, so a duplicate in-flight retry is safe) */
function replayPendingLedger () {
  for (const entry of [..._pendingLedger]) {
    Promise.resolve(window.todoAPI && window.todoAPI.dbCall(entry.op, entry.params))
      .then(() => { const i = _pendingLedger.indexOf(entry); if (i >= 0) _pendingLedger.splice(i, 1) })
      .catch(e => console.error('[tomato] ledger DB write failed (queued for retry):', entry.op, e))
  }
}
function ledgerWrite (op, params) {
  const entry = { op, params }
  _pendingLedger.push(entry)
  // Retry queue: replay any still-pending entries (incl. this one) before/with the new write
  replayPendingLedger()
  hookQuitFlush()
}
function flushPendingLedger () {
  const list = _pendingLedger.splice(0, _pendingLedger.length)
  for (const it of list) {
    Promise.resolve(window.todoAPI && window.todoAPI.dbCall(it.op, it.params))
      .catch(e => {
        console.error('[tomato] ledger flush failed at quit:', it.op, e)
        // Put the failed entry back at the queue head so the next ledger write replays it (no silent loss)
        _pendingLedger.unshift(it)
      })
  }
}
function hookQuitFlush () {
  if (_flushHooked || !window.todoAPI || !window.todoAPI.onAppQuittingFlush) return
  _flushHooked = true
  window.todoAPI.onAppQuittingFlush(() => flushPendingLedger())
}

export default {
  namespaced: true,
  state: loadState(),
  /** Task→actual tomato count lookup: build the Map once, component lookups are O(1). Abandoned (succeed===false) not counted */
  getters: {
    actualCountByTask (s) {
      const m = new Map()
      for (const r of (s.tomatoRecordList || [])) {
        if (!r || !r.focusTaskId || r.succeed === false) continue
        m.set(r.focusTaskId, (m.get(r.focusTaskId) || 0) + 1)
      }
      return m
    },
    /** Records grouped by dateKey lookup (consumers like TomatoPanel's today ledger) */
    recordsByDate (s) {
      const m = new Map()
      for (const r of (s.tomatoRecordList || [])) {
        if (!r || !r.dateKey) continue
        if (!m.has(r.dateKey)) m.set(r.dateKey, [])
        m.get(r.dateKey).push(r)
      }
      return m
    }
  },
  mutations: {
    patch (s, p) {
      Object.assign(s, p)
      persistState(s)
    },
    /** Correct a focus record's linked task (user drags a task onto a timeline record segment / removes the link): only metadata changes; facts like time/duration untouched */
    updateRecordTask (s, { tomatoId, focusTaskId }) {
      const rec = (s.tomatoRecordList || []).find(r => r && r.tomatoId === tomatoId)
      if (!rec || rec.focusTaskId === focusTaskId) return
      rec.focusTaskId = focusTaskId
      s.tomatoRecordList = [...s.tomatoRecordList]
      ledgerWrite('tomatoUpdateById', { tomatoId, patch: { focusTaskId } })
      persistState(s)
    },
    /** Entry card: correct the start-end/duration/status of already-recorded facts — the ledger is correctable, corrections go through minute-level patches */
    updateRecord (s, { tomatoId, patch }) {
      const rec = (s.tomatoRecordList || []).find(r => r && r.tomatoId === tomatoId)
      if (!rec) return
      if (patch.endTime != null) rec.endTime = Math.max(0, Math.round(patch.endTime))
      // After changing endTime, re-derive dateKey: the rail/stats both bucket by dateKey; without re-deriving, it becomes ghost data that "vanishes from the day it was moved away from"
      if (patch.endTime != null && rec.endTime > 0) rec.dateKey = dayjs(rec.endTime).format(FMT.date)
      // clamp 1..600 = the DB-layer single source (db.js _recToRow): a UI-side cap above it would show
      // values the DB silently drops on next reload (memory says 720, ledger says 600)
      if (patch.focusDuration != null) rec.focusDuration = Math.max(1, Math.min(600, Math.round(patch.focusDuration)))
      if (patch.restDuration != null) rec.restDuration = Math.max(0, Math.min(120, Math.round(patch.restDuration)))
      if (patch.succeed != null) rec.succeed = !!patch.succeed
      s.tomatoRecordList = [...s.tomatoRecordList]
      ledgerWrite('tomatoUpdateById', {
        tomatoId,
        patch: { endTime: rec.endTime, dateKey: rec.dateKey, focusDuration: rec.focusDuration, restDuration: rec.restDuration, succeed: rec.succeed }
      })
      persistState(s)
    },
    /** Entry card: delete one record (mistaken backfill/test data); irreversible, confirmed at the entry point */
    removeRecord (s, tomatoId) {
      s.tomatoRecordList = (s.tomatoRecordList || []).filter(r => !r || r.tomatoId !== tomatoId)
      ledgerWrite('tomatoRemoveByIds', [tomatoId])
      persistState(s)
    },
    addRecord (s, r) {
      // Idempotent dedupe: when multiple windows concurrently run the same completion transition, the deterministic tomatoId guarantees a single record
      if (r && r.tomatoId && (s.tomatoRecordList || []).some(x => x.tomatoId === r.tomatoId)) return
      s.tomatoRecordList = [r, ...(s.tomatoRecordList || [])]
      ledgerWrite('tomatoAppendMany', r)
      persistState(s)
    },
    /** 账本从行表整载(启动/收到广播时);DB 是唯一源,直接替换内存副本 */
    recordsReplace (s, list) {
      if (Array.isArray(list)) {
        // 最后一道防线:同 id 重复行(历史脏数据/迁移产物)不进 UI;保留首现次序(DB 已按 endTime DESC)
        const seen = new Set()
        s.tomatoRecordList = list.filter(r => { const id = r && r.tomatoId; if (!id || seen.has(id)) return false; seen.add(id); return true })
      }
    },
    /** Cross-window sync: float/main windows each have an independent Vuex instance; after the peer writes localStorage, the storage event triggers a re-read.
        voidExpired=false: sync doesn't void expired phases; the shared tick handles flipping/accounting.
        账本不在 blob 里:同步只覆盖瞬态,内存账本副本保持不动(由 recordsReplace 沿 DB 广播维护)。 */
    syncFromStorage (s) {
      let ping = null
      try { ping = localStorage.getItem(PING_KEY) } catch (e) { /* empty */ }
      if (ping == null || ping === lastAppliedPing) return
      lastAppliedPing = ping
      const records = s.tomatoRecordList
      Object.assign(s, loadState(false))
      s.tomatoRecordList = records
    }
  },
  actions: {
    /** 启动:一次性迁移旧 meta blob(如存在且表空),然后整载行表 */
    async initFromDb ({ commit }) {
      try { await window.todoAPI.dbCall('tomatoMigrateFromMeta') } catch (e) { console.warn('[tomato] meta 迁移跳过/失败(不影响已迁移库):', e && e.message) }
      return commit('recordsReplace', await window.todoAPI.dbCall('tomatoAll'))
    },
    /** 收到 tomato-records-changed 广播:从 DB 重载账本(其他窗/CLI 落了账) */
    async recordsReload ({ commit }) {
      let rows = null
      try {
        rows = await window.todoAPI.dbCall('tomatoAll')
      } catch (e) {
        // Keep the in-memory copy untouched on failure instead of silently discarding the reload
        console.error('[tomato] ledger reload failed:', e)
        return
      }
      commit('recordsReplace', rows)
      // todayTomatoCount 是 blob 残留计数器(本窗 completeFocus 与 Modal saveAdd 都会写)——重载时按账本重算收敛口径,派生态不手写
      const today = dayjs().format(FMT.date)
      const n = (rows || []).filter(r => r && r.succeed !== false && r.dateKey === today).length
      commit('patch', { todayTomatoCount: n, _countDate: today })
    },
    /** Remove records by tomatoId prefix (for clearing demo data)。
     *  先从 DB 重载再筛 id:内存副本可能落后于行表(广播未达/竞态),按旧副本筛会漏删 DB 行(2026-09-04 审查 P2-5) */
    async removeRecordsByIdPrefix ({ state, commit }, prefix) {
      let rows = null
      try {
        rows = await window.todoAPI.dbCall('tomatoAll')
      } catch (e) {
        // 与 recordsReload 同口径:重载失败时保留内存副本并中止删除(避免按陈旧副本漏删 DB 行/误删内存行)
        console.error('[tomato] ledger reload failed, skip prefix removal:', e)
        return
      }
      commit('recordsReplace', rows)
      const ids = (state.tomatoRecordList || [])
        .filter(r => String((r && r.tomatoId) || '').startsWith(prefix))
        .map(r => r.tomatoId)
      if (ids.length) ledgerWrite('tomatoRemoveByIds', ids)
      commit('recordsReplace', (state.tomatoRecordList || []).filter(r => !ids.includes(r.tomatoId)))
    },
    /** Shared completion decision: dispatched every second by every window (including the float); on expiry it flips/records, idempotency guaranteed by token + deterministic id.
        Does not write back remainSec (the display layer derives it from startedAt, avoiding per-second disk writes + cross-window broadcast storms).
        Wall clock keeps running through lid-close/sleep: on return, expiry completes and records normally with no special handling (finalized by users 2026-08-29). */
    tick ({ state, commit, dispatch }) {
      const s = state
      const todayKey = dayjs().format(FMT.date)
      if (s.todayTomatoCount && s._countDate !== todayKey) {
        commit('patch', { todayTomatoCount: 0, _countDate: todayKey })
      }
      const remain = remainSecOf(s.status, s.startedAt, s.tomatoTime, s.restTime, Date.now())
      if (remain === null || remain > 0) return
      if (s.status === 'startTomatoTime') dispatch('completeFocus')
      else dispatch('finishRest')
    },
    startFocus ({ state, commit }) {
      if (state.status !== 'default') return // triggering during focus/rest = illegal transition, prevents silently zeroing already-focused time
      commit('patch', { status: 'startTomatoTime', startedAt: Date.now(), remainSec: state.tomatoTime * 60 })
    },
    giveUp ({ state, commit, dispatch }, { record = true, reason = '' } = {}) {
      let s = state
      // 本窗副本陈旧防改:本窗为 default 而共享 LS 显示专注进行中(他窗启动、storage 事件未达)时,
      // 旧写法会走到底部盲写 default 归零,把他窗正在进行的专注瞬态杀掉且零记录(2026-09-04 二轮深审 P1)
      if (s.status === 'default') {
        const fresh = loadState(false)
        if (fresh.status === 'startTomatoTime' && fresh.startedAt) s = fresh
      }
      const running = s.status === 'startTomatoTime' && s.startedAt
      // Cross-window claim: when the user clicks "give up" at the exact expiry moment while the shared tick is completing, only the side that claimed first records (prevents succeed+abandon double records for the same focus)
      const claimed = running && record
        ? claimPhase('startTomatoTime', s.startedAt)
        : true
      if (running && record && !claimed) {
        // 已被他窗完成/认领:不能盲写 default 归零——他窗此刻可能已进入休息(浮窗显示滞后 ≤1 拍的经典竞态),
        // 正确动作是重读共享瞬态跟随他窗状态(2026-09-04 深审 P1 实锤:旧写法会静默取消刚开始的休息)
        const fresh = loadState(false)
        commit('patch', { status: fresh.status, startedAt: fresh.startedAt, remainSec: fresh.remainSec })
        return
      }
      if (running && record) {
        const focusedMin = Math.max(1, Math.min(s.tomatoTime, Math.floor((Date.now() - s.startedAt) / 60000)))
        commit('addRecord', {
          // Deterministic id: cross-window dedupe as a backstop so the same give-up records only once
          // Accounting basis = endTime (unified with completeFocus/stats/rail)
          tomatoId: 'tmt_a_' + s.startedAt, endTime: Date.now(), dateKey: dayjs(Date.now()).format(FMT.date),
          focus: s.attachTodo ? s.attachTodo.taskContent : '', focusTaskId: s.attachTodo ? s.attachTodo.taskId : null,
          focusDuration: focusedMin, rest: s.restTime, restDuration: 0, succeed: false, status: 'local',
          abandonReason: (reason || '').trim()
        })
        dispatch('todo/writeCriticalBackup', null, { root: true })
      }
      commit('patch', { status: 'default', startedAt: 0, remainSec: s.tomatoTime * 60 })
    },
    completeFocus ({ state, commit, rootState, dispatch }) {
      const s = state
      // State precheck (mirrors startFocus): an anomalous call with no running focus must not mint a free tomato
      if (s.status !== 'startTomatoTime' || !s.startedAt) return
      // Idempotency token: only one set of side effects per focus. Cross-window claim (including the give-up side) + deterministic id as double insurance
      if (!claimPhase('startTomatoTime', s.startedAt)) return
      const endTs = Date.now()
      // Measured duration, not the current setting: a mid-focus duration change would otherwise skew the ledger (unified with giveUp's elapsed basis)
      const focusMin = Math.max(1, Math.min(600, Math.round((endTs - s.startedAt) / 60000)))
      commit('addRecord', {
        // Accounting basis unified = endTime: stats (metrics)/rail (railSegs)/entry-card corrections (updateRecord) all use endTime
        tomatoId: 'tmt_f_' + s.startedAt, endTime: endTs, dateKey: dayjs(endTs).format(FMT.date),
        focus: s.attachTodo ? s.attachTodo.taskContent : '', focusTaskId: s.attachTodo ? s.attachTodo.taskId : null,
        focusDuration: focusMin, rest: s.restTime, restDuration: s.restTime, succeed: true, status: 'local'
      })
      {
        // 计入完成时刻所在日,与 stats/时间轴的 endTime 口径一致(2026-09-04 清理:原跨午夜判断是 endTs 与自身比较的恒真式,已删)
        commit('patch', { todayTomatoCount: (s.todayTomatoCount || 0) + 1, _countDate: dayjs(endTs).format(FMT.date) })
      }
      dispatch('auth/saveSnowGain', focusMin, { root: true })
      if (s.attachTodo && s.attachTodo.taskId) {
        window.todoAPI?.dbCall?.('bumpSnow', { taskId: s.attachTodo.taskId, minutes: focusMin })?.catch?.(() => {})
        // bumpSnow is a todo-row write issued as a raw dbCall outside the todo/* actions, so store/index.js's
        // WRITE_ACTIONS stamping never fires for it → the todos-changed broadcast echo of this write misses the
        // 1500ms echo-suppression window and todo/init's historyClear wipes the undo stack. Stamp it here,
        // same as the subscribeAction after-hook does for todo/* writes.
        try { this.state.todo._lastLocalWriteAt = Date.now() } catch (e) { /* store unavailable in tests */ }
      }
      dispatch('todo/writeCriticalBackup', null, { root: true })
      try { new Audio(confirmUrl(rootState.settings.completeSound)).play().catch(() => {}) } catch (e) { /* empty */ }
      if (s.enableNotification !== false) window.todoAPI.notification({ title: tt('statsA.core.tomatoDoneTitle'), body: tt('statsA.core.tomatoDoneBody', { n: focusMin }) })
      commit('patch', { status: 'startRestTime', startedAt: Date.now(), remainSec: s.restTime * 60, _countDate: dayjs().format(FMT.date) })
    },
    finishRest ({ state, commit }) {
      if (!claimPhase('startRestTime', state.startedAt)) return
      if (state.enableNotification !== false) window.todoAPI.notification({ title: tt('statsA.core.restOverTitle'), body: tt('statsA.core.restOverBody') })
      commit('patch', { status: 'default', startedAt: 0, remainSec: state.tomatoTime * 60 })
    },
    attach ({ commit }, taskId) {
      const t = taskId ? this.state.todo.todoList.find(x => x.taskId === taskId) : null
      commit('patch', { attachTodo: t ? { taskId: t.taskId, taskContent: t.taskContent } : null })
    }

  }
}
