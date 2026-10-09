/** 番茄计时状态机。账本(专注记录)唯一事实源 = SQLite tomato_records 行表(2026-09-04 根修):
 *  本文件只持有内存副本供渲染,所有增删改走原子 op 落库 + 主进程广播回灌;LS blob 只存计时瞬态(丢了无所谓)。 */
import { dayjs, FMT } from '../utils/core.js'
import { remainSecOf } from '../utils/tomatoShared.js'
import { confirmUrl } from '../utils/mediaRegistry.js'
import { tt } from '../utils/core.js'
import { FOCUS_MAX_MINUTES, REST_MAX_MINUTES } from '../utils/limits.js'
import { commit as commitCommand } from "../utils/commandBus.js"
// F-C3 (maint/dw wave3): the ledger patch is the last hop into the RUNNING countdown — clamp the
// duration keys here as a bottom-line guard even for callers that bypass sanitizeSettingsPatch
// (raw commit('tomato/patch') from float/quick-add windows, main.js CLI hooks).
import { clampNumericSettings } from './settings.js'
// Durability queues (ledger + snow) live in helpers/tomatoPendingQueue.js (structure-size
// ratchet split; behavior-preserving: hydrate still runs at module load via the import).
import { ledgerWrite, snowWrite, hydratePendingQueues } from './helpers/tomatoPendingQueue.js'
hydratePendingQueues()

/** Running-tomato cross-device announce (feature: live remote focus chip). Fire-and-forget;
 * announce failures never break the focus flow (peers' staleness TTL self-heals). */
function announceCrossDevice (ctx, status) {
  try { if (ctx && ctx.dispatch) ctx.dispatch('tomatoAnnounce/announceLocal', { status }) } catch (e) { /* announce is optional */ }
}

/** [maint-0924 A9] in-app aria-live announce for phase flips. $announce lives on the Vue app
 *  (main.js globalProperty) and is unreachable from a store module, so mirror its DOM fallback
 *  directly (layout.vue's .sr-only[aria-live=polite] region). Fire-and-forget, never throws. */
function announceUi (key, params) {
  try {
    const m = tt(key, params)
    const el = document.querySelector('.sr-only[aria-live], [aria-live]')
    if (!el) return
    el.textContent = ''
    requestAnimationFrame(() => { el.textContent = m })
  } catch (e) { /* announce is optional */ }
}

/** TQ-1 (2026-10-03): report an FSM transition to the main process's durable running-session row
 *  ('tomatoRunningSession' meta row via the 'tomato-running-session' channel). This is the
 *  renderer half of the durable-ownership contract: the tray-text lease is display-only, so the
 *  ONLY running-session signal main has is what this writes. Called on every phase boundary from
 *  BOTH windows (main + float) — a float-originated focus must write the row too. Fire-and-forget:
 *  an unreported transition degrades to the previous world (lease-only), never breaks the phase. */
function reportRunningTransition (transition, s) {
  try {
    if (!window.todoAPI || !window.todoAPI.tomatoRunningSession) return
    window.todoAPI.tomatoRunningSession({
      transition,
      status: s.status,
      startedAt: s.startedAt || 0,
      attachTaskId: (s.attachTodo && s.attachTodo.taskId != null) ? s.attachTodo.taskId : null,
      tomatoTime: s.tomatoTime,
      restTime: s.restTime
    })
  } catch (e) { /* the durable row is main-owned; a missed report must not break the phase */ }
}

const LS_KEY = 'tomatoState'
/** Persistence blob format version: incremented on future incompatible field semantics; readers tolerate old unstamped data as v1 */
const SCHEMA_V = 1
/** Cross-window sync ping key: value is an incrementing write sequence number; receivers use it to skip no-change full re-reads/comparisons */
const PING_KEY = 'tomatoSyncPing'

/** Idempotency token slot for completion transitions: only one set of side effects (notification/audio/snow gain) per entry into a running state; concurrent main+float windows count once */
const CLAIM_KEY = 'tomatoLastPhaseDone'
const SALT_KEY = 'tomatoDeviceSalt'

/** Cross-window phase claiming: for the same startedAt, only the first writer produces side effects (notification/audio/accounting).
 *  P2 root fix (was a 1.5s time window): the claim is a state slot — the exact phase string is written into the
 *  shared LS key and any later claimer of the SAME phase loses, regardless of elapsed time. The old
 *  `Date.now() - ts < 1500` window let a background-throttled window's late tick (>1.5s) re-claim the same
 *  completed phase → double snow gain + double notification. startedAt = Date.now() never repeats, so a
 *  permanent per-phase mark can never block a legitimate new phase.
 *  TQ-3 (2026-10-03) root fix: the claim now lives in the SINGLE-WRITER main process
 *  ('tomato-claim-phase' IPC, src/main/phase-claims.js). The shared-LS check-then-set was
 *  non-atomic across the main+float windows and carried an OWNERLESS claim value, so two windows
 *  could both win a phase and a contender's release-on-failure path could delete the owner's live
 *  claim. The main-process CAS returns an owner token; release only deletes on a token match.
 *  A localStorage fallback (same single-window semantics as before) survives only where no
 *  main-process bridge exists (browser hosts / plain-node tests) — never in the desktop app. */
/* [D22 P2] Device-stable salt for freshly minted tomato ids. The minted id used to be
 * 'tmt_<kind>_' + startedAt alone: two devices starting a free focus in the same millisecond
 * produced the SAME id and main's ON CONFLICT fully overwrote the earlier row (no LWW, even a
 * tombstone resurrection). The salt is generated once per device and persisted in localStorage,
 * so ids stay format-safe ('<prefix><startedAt>_<salt>' — same underscore-separated suffix shape
 * as the taskMenu 'tmt_m_...' ids) and are stable across restarts for dedupe. Salted ids are
 * gated behind the real Electron bridge (window.todoAPI.updateSettings — every preload surface
 * has it, ad-hoc store-test stubs do not): plain-node test hosts keep the legacy unsalted format,
 * so existing exact-id assertions remain meaningful. No memoization: mints are
 * rare (one per focus) and reading LS fresh keeps the value honest if the salt is ever rotated. */
function deviceSalt () {
  try {
    if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.updateSettings) return ''
    let s = localStorage.getItem(SALT_KEY)
    if (!s) {
      s = Math.random().toString(36).slice(2, 8)
      localStorage.setItem(SALT_KEY, s)
    }
    return s
  } catch (e) { return '' }
}
export function mintTomatoId (prefix, startedAt) {
  const salt = deviceSalt()
  return prefix + startedAt + (salt ? '_' + salt : '')
}

async function claimPhase (status, startedAt) {
  const phase = status + ':' + (startedAt || 0)
  try {
    if (window.todoAPI && window.todoAPI.tomatoClaimPhase) {
      // The bridge is ipcRenderer.invoke — ASYNC. Reading its return synchronously saw a Promise
      // (always truthy, `.won` undefined) and lost every claim, so completeFocus/finishRest/giveUp
      // aborted at the claim gate forever (2026-10-04 ui-smoke catch). Await the CAS result.
      const res = await window.todoAPI.tomatoClaimPhase(phase)
      return (res && res.won) ? { phase, token: res.token } : null
    }
  } catch (e) { /* bridge failure falls through to the LS fallback; losing the claim is the safe side */ }
  try {
    if (localStorage.getItem(CLAIM_KEY) === phase) return null
    localStorage.setItem(CLAIM_KEY, phase)
  } catch (e) { /* empty */ }
  return { phase, token: null }
}
/** Owner-checked release: with a token (main-process claim) only the owner can delete; with the
 *  LS fallback the value-equality check keeps the old single-window semantics. */
function releasePhaseClaim (claim) {
  if (!claim) return
  if (claim.token != null) {
    try {
      if (window.todoAPI && window.todoAPI.tomatoReleasePhase) window.todoAPI.tomatoReleasePhase(claim.phase, claim.token)
    } catch (e) { /* dying bridge — an orphaned claim only blocks a phase identity that never repeats */ }
    return
  }
  try { if (localStorage.getItem(CLAIM_KEY) === claim.phase) localStorage.removeItem(CLAIM_KEY) } catch (e) { /* empty */ }
}

/** Pure resolver (unit-tested): is the attached task still live at accounting time? The attach happens at
 *  focus start, but the task can be soft-deleted / purged before the focus ends (CLI delete, another window,
 *  an external-write reload) — booking the minutes to a dead taskId loses them on the task side (bumpSnow
 *  writes a row the renderer then ignores/never shows, i.e. silently dropped focus minutes). A dead or
 *  missing target resolves to null = the focus is accounted as free (no task association, no bumpSnow),
 *  removing any dependency on the main process's bumpSnow return value. */
/** U-11 (2026-09-20): idempotent today-counter bump for completeFocus. The counter patch sits in the
 *  same try block as later side effects (sound/notification); a mid-way failure releases the phase
 *  claim and the next tick retries the whole completion — the old unguarded increment then double-bumped
 *  todayTomatoCount for the same focus (same startedAt). The guard keys on the phase identity, mirroring
 *  the claim token, so a retry counts the focus exactly once. Pure (unit-tested): returns the patch to
 *  commit, or null when this focus was already counted. */
export function todayCountPatch (state, startedAt, endTs) {
  if (state._countedFocus === startedAt) return null
  return {
    todayTomatoCount: (state.todayTomatoCount || 0) + 1,
    _countDate: dayjs(endTs).format(FMT.date),
    _countedFocus: startedAt
  }
}

/** D14-B2 (2026-10-01, pure/unit-tested): recompute the today ring count from the mutated in-memory
 *  ledger. removeRecord/updateRecord used to mutate tomatoRecordList without touching
 *  todayTomatoCount — the only recompute lived in recordsReload (recordsReload recomputes), which
 *  the main process's broadcast deliberately EXCLUDES for the initiating window, so a deleted or
 *  re-dated tomato stayed counted (and an edited one miscounted) until restart. */
export function recountToday (records, todayKey) {
  return (records || []).filter(r => r && r.succeed !== false && r.dateKey === todayKey).length
}

export function resolveFocusedTask (attachTodo, todoRows) {
  if (!attachTodo || !attachTodo.taskId) return null
  const row = (todoRows || []).find(t => t && t.taskId === attachTodo.taskId)
  if (!row || row.delete === true) return null
  return { taskId: attachTodo.taskId, taskContent: row.taskContent != null ? row.taskContent : attachTodo.taskContent }
}

/** Todo-module row pool for accounting-time attach validation. In a real Vuex action `this` is the
 *  store, so the todo module lives on `rootState`; fake-ctx tests (and defensive symmetry) may only
 *  carry it on `state`. Missing module or lists resolve to an empty pool = attach fails as free focus. */
export function focusTodoPool (storeLike) {
  const todoMod = (storeLike.rootState && storeLike.rootState.todo) || (storeLike.state && storeLike.state.todo) || {}
  return [...(todoMod.todoList || []), ...(todoMod.recycleList || [])]
}

/** D15-B14 (2026-10-03): module-level store reference so a MUTATION (which gets no store) can still
 *  resolve the todo row pool. updateRecordTask must keep the denormalized `focus` name text in sync
 *  with focusTaskId in the SAME write — the old mutation relinked the id and left the old task's
 *  name text stale in the ledger row and every display surface (renames/relinks never propagated).
 *  Seeded by the initFromDb action at startup (actions receive the store as `this`); tests can seed
 *  it via the exported seam. Unseeded (headless) → empty pool → name resolves to '' on relink,
 *  never to a stale foreign task's name. */
let _todoPoolStore = null
export function _setTodoPoolStore (s) { _todoPoolStore = s || null }

const DEF = {
  status: 'default', attachTodo: null, todayTomatoCount: 0, tomatoRecordList: [],
  tomatoTime: 25, restTime: 5, enableNotification: true,
  // F12 (2026-09-24): dead floating-window default removed — zero consumers repo-wide; float
  // visibility and the 'user closed' marker live in main-process tomato-float.js
  // (todo DB meta 'tomatoFloatClosedByUser'; see tomato-float hide/show/undock + renderer main.js auto-show).
  // D15-B11 (2026-10-03): enableBeep / preTomatoTimes / preRestTimes removed the same way — they
  // were written, synced (LS blob) and defaulted but had ZERO consumers repo-wide
  // (notify-sound.js never consulted them); they only kept dead bytes flowing through every
  // persist/sync round. loadState() strips their residue out of old blobs.
  whiteNoiseAudio: '',
  remainSec: 1500, startedAt: 0,
  // Wall-clock stamp of the last STATUS transition (patch sets it when status changes). Cross-window
  // sync compares these so a throttled peer's stale blob can never resurrect a phase the local
  // window already transitioned past (2026-09-27: float-window stale write rolled the main window's
  // focus->rest flip back to 'startTomatoTime', then the recorded claim blocked every retry tick —
  // the phase wedged until the 24h rollover).
  phaseTs: 0
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
      // [d21-A17] the reset is STARTUP-only: gate it on the same voidExpired condition the phase
      // voiding above uses. The cross-window re-read (voidExpired=false) must not zero the count
      // just because the blob was written yesterday — the owning window rolls the count itself.
      const today = window.dayjs().format(FMT.date)
      if (voidExpired && merged._countDate !== today) { merged.todayTomatoCount = 0; merged._countDate = today }
      // 账本已迁行表:blob 里的历史记录字段直接忽略(内存副本由 recordsLoad 从 DB 装载)
      if (Array.isArray(merged.tomatoRecordList)) merged.tomatoRecordList = []
      delete merged.unSyncTomatoRecordList
      // D15-B11: dead preference keys (zero consumers) are stripped from old blobs instead of
      // lingering forever via the Object.assign merge — same residue-sweep contract as above.
      delete merged.enableBeep; delete merged.preTomatoTimes; delete merged.preRestTimes
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

/** TQ-6 (2026-10-03): the transient LS blob is a LOUD-degradation surface, not a fail-silent one.
 *  persistState runs on every mutation, so a quota failure must not throw into unrelated UI —
 *  but the old safeSet call returned a boolean NOBODY consumed, so an unhealthy mirror was
 *  invisible. The degraded flag latches for the process lifetime: one look, one surface. */
let _mirrorDegraded = false
export function tomatoMirrorDegraded () { return _mirrorDegraded }
function persistState (state) {
  // Write sequence number: increments once per real disk flush; the ping carries only the sequence, and receivers skip the full re-read when the sequence matches
  state._syncSeq = (state._syncSeq || 0) + 1
  state.schemaV = SCHEMA_V
  // 账本字段从 blob 中剔除(唯一源=DB 行表),blob 只承载计时瞬态与偏好
  const blob = Object.assign({}, state, { tomatoRecordList: [], _recordsInDb: true })
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(blob))
  } catch (e) {
    _mirrorDegraded = true
    console.error('[tomato] transient state persist FAILED (degraded; in-memory state continues, peers may diverge):', e)
  }
  const ping = newPingToken(state._syncSeq)
  try { window.localStorage.setItem(PING_KEY, ping) } catch (e) {
    _mirrorDegraded = true
    console.error('[tomato] cross-window sync ping write failed (peer windows will not re-read):', e)
  }
  lastAppliedPing = ping // This window's own write counts as applied
}

/** 账本原子 op 落库(幂等:确定性 tomatoId);失败打日志不静默——账本是核心资产。
 *  退出冲刷:pending 账本写挂到 app-quitting-flush(完成番茄后立刻退出是丢账最高频场景,三轮深审发布 blocker);
 *  失败留在重试队列,下一次任意账本写时重放(锁屏/瞬时 IO 失败自愈)。 */


/** maint/d11-r4: single source for the tomato countdown's remaining seconds. Five hand-written
 *  copies (TomatoBar clock/remainSecNow/pushTaskbar, TomatoPanel, TomatoFloatPage) drifted-able —
 *  any rounding/clamp change on one end made float window and panel visibly disagree per second.
 *  Running: delegates to the pre-existing single source remainSecOf (tomatoShared) — floor+clamp
 *  and the rest fallback (restTime || 5, NOT 25) stay identical to every other consumer.
 *  Idle: full tomatoTime (||25; rest phase ||5, matching remainSecOf's defaults).
 *  `now` is injected so callers keep their reactive tick (Date.now() in a Vuex getter is not
 *  reactive — see P1-6). */
export function remainingSecOfState (s, now) {
  if (!s) return 25 * 60
  const running = remainSecOf(s.status, s.startedAt, s.tomatoTime, s.restTime, Number(now) || Date.now())
  if (running !== null) return running
  // Idle fallback — same defaults as remainSecOf: focus ||25, rest ||5 (r5: the rest half used to
  // fall back to 25, making a missing restTime show 25:00 in float/panel vs 5:00 in TodayXView).
  return ((s.status === 'startRestTime' ? s.restTime : s.tomatoTime) || (s.status === 'startRestTime' ? 5 : 25)) * 60
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
      // F-C3: duration keys (TOMATO_LEDGER_KEYS family) are clamped at this final hop — an unclamped
      // inbound value (e.g. tomatoTime 9999 from an unsanitized path) used to drive the running
      // countdown and get persisted to LS + db.settingsState verbatim.
      if (p && p.status && p.status !== s.status) s.phaseTs = Date.now()
      Object.assign(s, clampNumericSettings(p))
      persistState(s)
    },
    /** Correct a focus record's linked task (user drags a task onto a timeline record segment / removes the link): only metadata changes; facts like time/duration untouched */
    updateRecordTask (s, { tomatoId, focusTaskId }) {
      const rec = (s.tomatoRecordList || []).find(r => r && r.tomatoId === tomatoId)
      if (!rec || rec.focusTaskId === focusTaskId) return
      rec.focusTaskId = focusTaskId
      // D15-B14: the ledger row carries a DENORMALIZED name text (`focus`) — the old relink left
      // the previous task's name stale in the row and on every display surface. Resolve the live
      // taskContent in the SAME write (deleted/missing target → '' = the free-focus display
      // convention used at booking time), so the in-memory row, the DB row and the reload echo
      // all agree. Read-time derivation was rejected: three surfaces read rec.focus and the row
      // is the durable asset — fixing the write once is the class-complete fix.
      const focused = resolveFocusedTask({ taskId: focusTaskId }, focusTodoPool(_todoPoolStore || {}))
      rec.focus = (focused && focused.taskContent != null) ? focused.taskContent : ''
      s.tomatoRecordList = [...s.tomatoRecordList]
      ledgerWrite('tomatoUpdateById', { tomatoId, patch: { focusTaskId, focus: rec.focus } })
      persistState(s)
    },
    /** Entry card: correct the start-end/duration/status of already-recorded facts — the ledger is correctable, corrections go through minute-level patches */
    updateRecord (s, { tomatoId, patch }) {
      const rec = (s.tomatoRecordList || []).find(r => r && r.tomatoId === tomatoId)
      if (!rec) return
      // Invalid endTime (<=0/NaN) rejects that field outright: the DB layer unconditionally derives
      // dateKey from endTime, so a 0 would fall into the 1970 bucket (ghost data in every stat)
      if (patch.endTime != null) {
        const t = Math.round(Number(patch.endTime))
        if (Number.isFinite(t) && t > 0) {
          rec.endTime = t
          // After changing endTime, re-derive dateKey: the rail/stats both bucket by dateKey; without re-deriving, it becomes ghost data that "vanishes from the day it was moved away from"
          rec.dateKey = dayjs(t).format(FMT.date)
        } else {
          // G1: a rejected field must not pass silently — the caller believes the whole patch applied
          console.warn('[tomato] updateRecord: invalid endTime ignored (field skipped, rest applied) tomatoId=' + tomatoId + ' endTime=' + String(patch.endTime))
        }
      }
      // clamp 1..FOCUS_MAX_MINUTES = the DB-layer single source (db.js _recToRow via shared/limits.mjs):
      // a UI-side cap above it would show values the DB silently drops on next reload (memory says 720, ledger says 600)
      if (patch.focusDuration != null) rec.focusDuration = Math.max(1, Math.min(FOCUS_MAX_MINUTES, Math.round(patch.focusDuration)))
      // H1 (2026-09-16): rest cap unified to REST_MAX_MINUTES (shared/limits.mjs), same source as
      // the DB layer's clamp (_recToRow restDuration). The old inline 120 silently truncated a
      // 300-minute rest on any entry-card patch — memory said 120, ledger said 600, reload diverged.
      if (patch.restDuration != null) rec.restDuration = Math.max(0, Math.min(REST_MAX_MINUTES, Math.round(patch.restDuration)))
      if (patch.succeed != null) rec.succeed = !!patch.succeed
      s.tomatoRecordList = [...s.tomatoRecordList]
      // D14-B2: the mutated list is the truth — re-derive the today count inline (the broadcast
      // echo that would otherwise fix it excludes this window, so drift persisted until restart)
      const todayKey = dayjs().format(FMT.date)
      s.todayTomatoCount = recountToday(s.tomatoRecordList, todayKey)
      s._countDate = todayKey
      ledgerWrite('tomatoUpdateById', {
        tomatoId,
        patch: { endTime: rec.endTime, dateKey: rec.dateKey, focusDuration: rec.focusDuration, restDuration: rec.restDuration, succeed: rec.succeed }
      })
      persistState(s)
    },
    /** Entry card: delete one record (mistaken backfill/test data); irreversible, confirmed at the entry point */
    removeRecord (s, tomatoId) {
      s.tomatoRecordList = (s.tomatoRecordList || []).filter(r => !r || r.tomatoId !== tomatoId)
      // D14-B2: same initiating-window recompute as updateRecord (see recountToday)
      const todayKey = dayjs().format(FMT.date)
      s.todayTomatoCount = recountToday(s.tomatoRecordList, todayKey)
      s._countDate = todayKey
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
      const fresh = loadState(false)
      // Per-window keys excluded from the cross-window merge (2026-10-09): todayTomatoCount /
      // _countDate / _countedFocus are derived from THIS window's ledger copy + its idempotent
      // count guards — every window recomputes them itself (recordsReload, recountToday,
      // todayCountPatch), so carrying a stale peer blob's counter over reset the main window's
      // ring count until the next tick/reload. attachTodo is a per-window UI choice: it is set
      // only by this window's attachTask mutation (:670) and is never announced/broadcast to
      // peers — excluding it keeps the float window's attach from clobbering the main window's
      // (and vice versa); resolveFocusedTask re-validates at accounting time anyway.
      const LOCAL_KEYS = ['todayTomatoCount', '_countDate', '_countedFocus', 'attachTodo']
      const withoutLocal = blob => Object.fromEntries(Object.entries(blob).filter(([k]) => !LOCAL_KEYS.includes(k)))
      if ((fresh.phaseTs || 0) < (s.phaseTs || 0)) {
        // Stale-peer guard: the peer's blob describes a phase OLDER than one this window already
        // transitioned past (throttled float writing mid-focus state after the main window flipped).
        // Applying it would roll the phase back; and with the phase claim already recorded, every
        // retry tick would no-op — a permanent wedge. Preferences still sync; the phase stays local.
        const PHASE_KEYS = ['status', 'startedAt', 'remainSec', 'phaseTs']
        const prefs = Object.fromEntries(Object.entries(withoutLocal(fresh)).filter(([k]) => !PHASE_KEYS.includes(k)))
        Object.assign(s, prefs)
      } else {
        Object.assign(s, withoutLocal(fresh))
      }
      s.tomatoRecordList = records
    }
  },
  actions: {
    /** 启动:一次性迁移旧 meta blob(如存在且表空),然后整载行表 */
    async initFromDb ({ commit }) {
      // D15-B14: seed the mutation-side todo-pool reference (actions get the store as `this`;
      // mutations don't — see _setTodoPoolStore). Also re-seeded by every recordsReload so a
      // pool rebuilt by todo/init is always the one the resolver reads.
      try { _setTodoPoolStore(this) } catch (e) { /* store unavailable in tests */ }
      try { await commitCommand('tomato', 'migrateFromMeta') } catch (e) { console.warn('[tomato] meta 迁移跳过/失败(不影响已迁移库):', e && e.message) }
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
      // D15 (maint/deep-r2): removed rows may include TODAY's — recompute the ring count from the
      // mutated list. The initiating window never receives a recordsReload recompute for its own
      // write (same defect class as D14-B2 removeRecord/updateRecord), so the count stayed stale
      // until an unrelated broadcast.
      const todayKeyAfter = dayjs().format(FMT.date)
      commit('patch', { todayTomatoCount: recountToday(state.tomatoRecordList, todayKeyAfter), _countDate: todayKeyAfter })
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
      reportRunningTransition('start', state) // TQ-1: durable row (main + float windows both report)
      announceCrossDevice(this, 'running')
    },
    async giveUp ({ state, commit, dispatch }, { record = true, reason = '' } = {}) {
      let s = state
      // 本窗副本陈旧防改:本窗为 default 而共享 LS 显示专注进行中(他窗启动、storage 事件未达)时,
      // 旧写法会走到底部盲写 default 归零,把他窗正在进行的专注瞬态杀掉且零记录(2026-09-04 二轮深审 P1)
      if (s.status === 'default') {
        const fresh = loadState(false)
        if (fresh.status === 'startTomatoTime' && fresh.startedAt) s = fresh
        else if (fresh.status === 'startRestTime' && fresh.startedAt) {
          // 他窗已进入休息而本窗副本还是 default:giveUp 的"取消专注"意图已失效,不能盲写 default
          // 杀掉刚开的休息(与下方 claimed 分支同款竞态,此前只修了 startTomatoTime 一半)——跟随共享状态返回
          commit('patch', { status: fresh.status, startedAt: fresh.startedAt, remainSec: fresh.remainSec })
          return
        }
      }
      const running = s.status === 'startTomatoTime' && s.startedAt
      // Cross-window claim: when the user clicks "give up" at the exact expiry moment while the shared tick is completing, only the side that claimed first records (prevents succeed+abandon double records for the same focus)
      const claim = running && record
        ? await claimPhase('startTomatoTime', s.startedAt)
        : {}
      if (running && record && !claim) {
        // 已被他窗完成/认领:不能盲写 default 归零——他窗此刻可能已进入休息(浮窗显示滞后 ≤1 拍的经典竞态),
        // 正确动作是重读共享瞬态跟随他窗状态(2026-09-04 深审 P1 实锤:旧写法会静默取消刚开始的休息)
        const fresh = loadState(false)
        commit('patch', { status: fresh.status, startedAt: fresh.startedAt, remainSec: fresh.remainSec })
        return
      }
      if (running && record) {
        // Measured duration, not the current setting (unified with completeFocus): a mid-focus
        // duration change used to cap the booked minutes at the NEW smaller setting, skewing the ledger
        // Rounding unified with completeFocus (Math.round): floor vs round disagreed at the sub-minute
        // boundary so a 25:40 focus booked 25 min on abandon but 26 min on complete. Both clamp FOCUS_MAX_MINUTES.
        // Sub-minute clamp fix (2026-10-09): a 2-second misclick used to book Math.max(1, ...) = a
        // phantom focus MINUTE. Task-side counters already exclude succeed===false rows, but the DAY
        // stats sum focusDuration unconditionally, so every instant-abandon inflated the day's focus
        // total by 1. Book sub-minute abandons (rounded below 1) as focusDuration: 0 — the db layer's
        // _recToRow lower bound is 0 by design (P3 2026-09-17: "a bad value must not be inflated into
        // a phantom focus minute"), so the row still lands with its abandonReason audit trail; choosing
        // 0 over filtering succeed===false in the stats keeps the ledger row and the day totals
        // consistent (row-sum == stats-sum for every date).
        const rawMin = Math.round((Date.now() - s.startedAt) / 60000)
        const focusedMin = Math.min(FOCUS_MAX_MINUTES, Math.max(0, rawMin))
        const focused = resolveFocusedTask(s.attachTodo, focusTodoPool(this))
        commit('addRecord', {
          // Deterministic id: cross-window dedupe as a backstop so the same give-up records only once
          // Accounting basis = endTime (unified with completeFocus/stats/rail)
          // [D22 P2] device salt mixed in — same-ms cross-device starts no longer collide
          tomatoId: mintTomatoId('tmt_a_', s.startedAt), endTime: Date.now(), dateKey: dayjs(Date.now()).format(FMT.date),
          focus: focused ? focused.taskContent : '', focusTaskId: focused ? focused.taskId : null,
          focusDuration: focusedMin, rest: s.restTime, restDuration: 0, succeed: false, status: 'local',
          abandonReason: (reason || '').trim()
        })
        dispatch('todo/writeCriticalBackup', null, { root: true })
      }
      commit('patch', { status: 'default', startedAt: 0, remainSec: s.tomatoTime * 60 })
      reportRunningTransition('clear', s) // TQ-1: the phase was explicitly given up — release the durable row
      announceCrossDevice(this, 'idle')
    },
    async completeFocus ({ state, commit, rootState, dispatch }) {
      const s = state
      // State precheck (mirrors startFocus): an anomalous call with no running focus must not mint a free tomato
      if (s.status !== 'startTomatoTime' || !s.startedAt) return
      // Idempotency token: only one set of side effects per focus. Cross-window claim (including the give-up side) + deterministic id as double insurance
      const claim = await claimPhase('startTomatoTime', s.startedAt)
      if (!claim) return
      // G1: once claimed, any failure between here and addRecord/saveSnowGain would otherwise leave the
      // phase permanently claimed with no record — the tomato is lost with no retry possible. On failure
      // release the claim (owner-checked: only OUR token/phase, so a peer's claim is never touched)
      // so the next tick can re-complete.
      const startedAt = s.startedAt
      const releaseClaim = () => releasePhaseClaim(claim)
      const endTs = Date.now()
      // Measured duration, not the current setting: a mid-focus duration change would otherwise skew the ledger (unified with giveUp's elapsed basis)
      const focusMin = Math.max(1, Math.min(FOCUS_MAX_MINUTES, Math.round((endTs - startedAt) / 60000)))
      // Accounting-time attach validation (root fix): a task deleted after focus start resolves to null →
      // the focus is booked as free (no focusTaskId, no bumpSnow) instead of firing a fire-and-forget
      // bumpSnow at a dead taskId whose minutes silently vanish
      // G1 (N1): resolveFocusedTask/loadState sit between the claim and the guarded try below — a throw
      // here (malformed attachTodo / corrupted LS) would hold the claim forever, exactly the stuck-tomato
      // bug this fix wave eliminated. Wrap the whole verification stretch in the same release-on-failure guard.
      let focused = null
      try {
        focused = resolveFocusedTask(s.attachTodo, focusTodoPool(this))
      } catch (e) { releaseClaim(); throw e }
      // 本窗 todoList 池可能陈旧(他窗/CLI 删除未同步到本窗):db 层 bumpSnow 的 `AND deleted=0` 会
      // changes=0 静默丢积分。用廉价读 op getById(任意窗可调、含已删行)二次核验;已删/不存在按
      // free focus 记账。核验通道本身失败则保持本窗判定(不因 IPC 故障丢记账)。
      if (focused && window.todoAPI && window.todoAPI.dbCall) {
        try {
          const live = await window.todoAPI.dbCall('getById', focused.taskId)
          if (!live || live.delete === true) focused = null
        } catch (e) { /* empty */ }
        try {
        // G1 (R2-4): the await window lets a concurrent giveUp(record=false) flip the shared phase back to
        // default. Re-verify against the shared transient before booking; if this window no longer owns the
        // phase, abandon the completion (release the claim, follow the give-up side — no rest, no points).
        const fresh = loadState(false)
        if (!fresh || fresh.status !== 'startTomatoTime' || fresh.startedAt !== startedAt) {
          releaseClaim()
          console.info('[tomato] completeFocus aborted after verify await: phase was given up concurrently (startedAt', startedAt + ')')
          return
        }
        } catch (e) { releaseClaim(); throw e }
      }
      try {
        commit('addRecord', {
          // Accounting basis unified = endTime: stats (metrics)/rail (railSegs)/entry-card corrections (updateRecord) all use endTime
          // [D22 P2] device salt mixed in (same-ms cross-device collision, same as giveUp)
          tomatoId: mintTomatoId('tmt_f_', startedAt), endTime: endTs, dateKey: dayjs(endTs).format(FMT.date),
          focus: focused ? focused.taskContent : '', focusTaskId: focused ? focused.taskId : null,
          focusDuration: focusMin, rest: s.restTime, restDuration: s.restTime, succeed: true, status: 'local'
        })
        {
          // 计入完成时刻所在日,与 stats/时间轴的 endTime 口径一致(2026-09-04 清理:原跨午夜判断是 endTs 与自身比较的恒真式,已删)
          // U-11: idempotent per startedAt — the retry path (claim released after a mid-way failure)
          // must not double-bump todayTomatoCount for the same focus
          const countPatch = todayCountPatch(s, startedAt, endTs)
          if (countPatch) commit('patch', countPatch)
        }
        // maint-d7: dedupKey = phase identity (String(startedAt)) — a completion retry (claim released
        // after a mid-way failure) re-dispatches saveSnowGain; without the key the same focus double-
        // patched the snow total and re-queued the delta (mirrors countPatch's startedAt guard above)
        dispatch('auth/saveSnowGain', { gain: focusMin, dedupKey: String(startedAt) }, { root: true })
        if (focused) {
          // Queued write with retry (was fire-and-forget with an empty catch — a transient failure
          // silently dropped the task's focus credit)
          // dedupKey = phase identity: the db layer's bumpSnow honors it, so a replay (retry queue
          // or quit-flush) of the same focus can never double-credit the task
          snowWrite({ taskId: focused.taskId, minutes: focusMin, dedupKey: String(startedAt) })
          // bumpSnow is a todo-row write issued as a raw dbCall outside the todo/* actions, so store/index.js's
          // WRITE_ACTIONS stamping never fires for it → the todos-changed broadcast echo of this write misses the
          // 1500ms echo-suppression window and todo/init's historyClear wipes the undo stack. Stamp it here,
          // same as the subscribeAction after-hook does for todo/* writes.
          try { commit('todo/stampLocalWrite', null, { root: true }) } catch (e) { /* store unavailable in tests */ }
        }
        dispatch('todo/writeCriticalBackup', null, { root: true })
        try { new Audio(confirmUrl(rootState.settings.completeSound)).play().catch(() => {}) } catch (e) { /* empty */ }
        if (s.enableNotification !== false) { try { window.todoAPI.notification({ title: tt('statsA.core.tomatoDoneTitle'), body: tt('statsA.core.tomatoDoneBody', { n: focusMin }) }) } catch (e) { /* locked screen rejects the channel — fire-and-forget */ } }
        commit('patch', { status: 'startRestTime', startedAt: Date.now(), remainSec: s.restTime * 60, _countDate: dayjs().format(FMT.date) })
        // TQ-1: the focus phase completed; the durable row now tracks the rest phase (also a
        // running phase for the quit confirm; rest itself is never a ledger asset).
        reportRunningTransition('start', s)
        // Focus complete: announce idle right away so peers' chips stop counting (display-only;
        // the rest phase is local and intentionally not broadcast).
        announceCrossDevice(this, 'idle')
        // [maint-0924 A9] read-screen / in-app feedback for the phase flip (focus done -> rest N minutes)
        announceUi('statsH.tomato.focusToRestAnnounce', { n: s.restTime })
      } catch (e) {
        // G1: booking failed mid-transition — release the phase claim so the next tick can retry the
        // completion instead of the tomato being lost forever behind a permanent claim mark.
        releaseClaim()
        console.error('[tomato] completeFocus failed after claiming; claim released for retry:', e)
      }
    },
    async finishRest ({ state, commit }) {
      const claim = await claimPhase('startRestTime', state.startedAt)
      if (!claim) return
      if (state.enableNotification !== false) { try { window.todoAPI.notification({ title: tt('statsA.core.restOverTitle'), body: tt('statsA.core.restOverBody') }) } catch (e) { /* locked screen rejects the channel — fire-and-forget */ } }
      commit('patch', { status: 'default', startedAt: 0, remainSec: state.tomatoTime * 60 })
      reportRunningTransition('clear', state) // TQ-1: rest finished — release the durable row
      // [maint-0924 A9] phase flip feedback: rest over, back to ready
      announceUi('statsH.tomato.restOverAnnounce')
    },
    attach ({ commit, state }, taskId) {
      const t = taskId ? this.state.todo.todoList.find(x => x.taskId === taskId) : null
      commit('patch', { attachTodo: t ? { taskId: t.taskId, taskContent: t.taskContent } : null })
      // Attach change during a running focus: re-announce so peers' chips show the new link
      announceCrossDevice(this, state.status === 'startTomatoTime' ? 'running' : 'idle')
    }

  }
}
