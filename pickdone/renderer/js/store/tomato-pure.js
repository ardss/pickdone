/**
 * tomato-pure — pure helpers split from store/tomato.js (2026-10-24 size-ratchet split
 * queue). No module state, no LS/db access: every function here is pure over its
 * arguments (the same property that made them unit-tested exports). The store
 * imports what it uses and re-exports every name so consumers stay stable.
 */
import { dayjs, FMT } from '../utils/core.js'
import { remainSecOf } from '../utils/tomatoShared.js'

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

/** [W7-R 2026-10-23 P3, pure/unit-tested] parse the focus phase's startedAt back out of a tomatoId.
 *  mintTomatoId('tmt_f_', startedAt) concatenates the phase timestamp followed by an optional
 *  '_' + deviceSalt suffix — the same phase identity the original task-side credit was booked
 *  under (snowWrite's dedupKey = String(startedAt)).
 *  Returns 0 for give-up ('tmt_a_') ids / malformed ids — nothing was bumped for those. */
export function focusStartedAtOf (tomatoId) {
  const s = String(tomatoId || '')
  if (!s.startsWith('tmt_f_')) return 0
  const m = s.slice(6).match(/^(\d+)/)
  const t = m ? Number(m[1]) : 0
  return Number.isFinite(t) && t > 0 ? t : 0
}

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
