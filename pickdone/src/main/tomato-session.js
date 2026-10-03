'use strict'

/**
 * TQ-1 (2026-10-03) — durable main-process ownership of the tomato running session.
 *
 * Root removed: authority-less tomato running state. The main process's ONLY running-session
 * signal used to be the per-second tray-text lease (index.js tomatoLiveText + the 10s freshness
 * TTL in handlers/shared.js isLiveTextFresh) — a DISPLAY artifact. A renderer that died
 * (background-throttled, crashed, float-originated focus that never pushed the main-window-gated
 * update-tomato-taskbar) left nothing durable behind: quitFromTray's focus-active confirm keyed
 * on the stale lease and startup reconciliation voided the expired localStorage phase silently,
 * so a live focus could die unrecorded with no confirm and no ledger row.
 *
 * The contract is now: the renderer reports every FSM transition (start | clear) over the
 * 'tomato-running-session' IPC channel (main window OR float window — a float-originated focus
 * must write the row too, which is exactly the blindness the main-window-gated taskbar push had);
 * main writes/clears the 'tomatoRunningSession' DB meta row on receipt (same meta-row contract as
 * the CLI's cliTomatoState receipt — no schema change). Every quit path consults the durable row
 * instead of the display lease, and startup reconciliation reads it to book-or-void a focus that
 * died with its renderer: the invariant is "a running focus phase is always either recorded or
 * explicitly given up, across any renderer death mode" — never silently dropped.
 *
 * Plain-node testable: every function takes an injected `call(op, params)` db accessor (dbm.call
 * in production); no Electron imports here (same extraction reason as quit-guards.js).
 */

const { FOCUS_MAX_MINUTES } = require('../../shared/limits.mjs') // require(esm) — Node >= 22.12
const { localDayKey } = require('../../shared/date-key.mjs')

const SESSION_KEY = 'tomatoRunningSession'

const RUNNING_STATUSES = new Set(['startTomatoTime', 'startRestTime'])
const START_TRANSITIONS = new Set(['start'])
const CLEAR_TRANSITIONS = new Set(['complete', 'giveUp', 'finishRest', 'clear'])

/** Pure: validate a renderer transition payload into the durable row we are willing to store.
 *  Returns null for anything we refuse (a forged/garbage payload must never write a row). */
function sessionRowFromTransition (payload) {
  if (!payload || typeof payload !== 'object') return null
  const transition = payload.transition
  if (START_TRANSITIONS.has(transition)) {
    const startedAt = Number(payload.startedAt) || 0
    const status = payload.status
    if (!startedAt || startedAt > Date.now() + 60_000 || !RUNNING_STATUSES.has(status)) return null
    return {
      status,
      startedAt,
      attachTaskId: (payload.attachTaskId != null && payload.attachTaskId !== '') ? payload.attachTaskId : null,
      tomatoTime: Math.min(FOCUS_MAX_MINUTES, Math.max(1, Number(payload.tomatoTime) || 25)),
      restTime: Math.max(1, Number(payload.restTime) || 5),
      at: Date.now()
    }
  }
  if (CLEAR_TRANSITIONS.has(transition)) return { status: 'default', startedAt: 0, at: Date.now() }
  return null
}

/** Pure: the startup book-or-void decision for a durable row found at boot.
 *  - no row / idle row          → nothing to do ('none' | already cleared)
 *  - focus, not yet expired     → 'pending' (the renderer's own hydration resumes the phase;
 *                                 voiding early would kill a live phase across a quick restart)
 *  - focus, expired             → 'book' a give-up-shaped record (measured minutes, deterministic
 *                                 id 'tmt_a_<startedAt>' = idempotent upsert) — the phase is
 *                                 recorded, never silently dropped
 *  - rest, expired or not       → 'void' (rest is never a ledger asset; the renderer's own
 *                                 voidExpired contract already treats it as disposable) */
function reconcileDecision (row, now) {
  if (!row || !RUNNING_STATUSES.has(row.status) || !(Number(row.startedAt) > 0)) return { action: 'none' }
  if (row.status === 'startRestTime') return { action: 'void', startedAt: row.startedAt }
  const limitMs = (Number(row.tomatoTime) > 0 ? Number(row.tomatoTime) : 25) * 60_000
  if (now - row.startedAt < limitMs) return { action: 'pending', startedAt: row.startedAt }
  const focusedMin = Math.max(1, Math.min(FOCUS_MAX_MINUTES, Math.round((now - row.startedAt) / 60_000)))
  return { action: 'book', startedAt: row.startedAt, focusDuration: focusedMin }
}

/** Factory: the process-lifetime session tracker. `call(op, params)` = dbm.call in production. */
function createTomatoSession ({ call, log = { warn: () => {}, info: () => {} }, now = () => Date.now() } = {}) {
  if (typeof call !== 'function') throw new Error('createTomatoSession requires a db call accessor')

  const readRow = () => {
    let raw = null
    try { raw = call('getMeta', SESSION_KEY) } catch (e) { return null }
    if (!raw) return null
    try {
      const v = JSON.parse(raw)
      return (v && typeof v === 'object') ? v : null
    } catch (e) {
      // Corrupt row = no durable running state; clear it so it cannot wedge the quit guard.
      try { call('deleteMeta', SESSION_KEY) } catch { /* best-effort */ }
      return null
    }
  }

  const writeRow = row => { call('setMeta', [SESSION_KEY, JSON.stringify(row)]) }
  const clearRow = () => { try { call('deleteMeta', SESSION_KEY) } catch { /* best-effort */ } }

  return {
    /** IPC entry ('tomato-running-session'): renderer FSM transition → durable row write/clear. */
    applyTransition (payload) {
      const row = sessionRowFromTransition(payload)
      if (!row) return false
      try {
        if (RUNNING_STATUSES.has(row.status)) writeRow(row)
        else clearRow()
        return true
      } catch (e) {
        log.warn('[TomatoSession] failed to persist running-session transition:', (payload && payload.transition), e && e.message)
        return false
      }
    },
    /** Durable "is a phase running" — the quit-guard signal (replaces the tray-text lease gate).
     *  The lease stays display-only (tray tooltip text). */
    hasRunningSession () {
      const row = readRow()
      return !!(row && RUNNING_STATUSES.has(row.status) && Number(row.startedAt) > 0)
    },
    /** Startup reconciliation: read the row, book-or-void, clear. Called once per boot after dbm.init. */
    reconcile () {
      const t = now()
      const row = readRow()
      const d = reconcileDecision(row, t)
      if (d.action === 'none' || d.action === 'pending') return d
      if (d.action === 'void') { clearRow(); log.info('[TomatoSession] startup: leftover rest phase voided'); return d }
      // 'book': resolve the attached task at accounting time (it may have been deleted while the
      // renderer was dead) — dead/missing target books as free focus, mirroring the renderer's
      // resolveFocusedTask contract.
      let focusTaskId = null
      let focus = ''
      if (row.attachTaskId != null) {
        try {
          const live = call('getById', row.attachTaskId)
          if (live && live.delete !== true) {
            focusTaskId = live.taskId != null ? live.taskId : row.attachTaskId
            focus = live.taskContent != null ? live.taskContent : ''
          }
        } catch (e) { log.warn('[TomatoSession] attach resolution failed; booking as free focus:', e && e.message) }
      }
      const endTime = t
      const record = {
        tomatoId: 'tmt_a_' + d.startedAt,
        endTime,
        dateKey: localDayKey(endTime),
        focus,
        focusTaskId,
        focusDuration: d.focusDuration,
        rest: row.restTime || 5,
        restDuration: 0,
        succeed: false,
        status: 'local',
        abandonReason: 'startup-reconcile (renderer died mid-focus)'
      }
      try {
        call('tomatoAppendMany', record)
        clearRow()
        log.info('[TomatoSession] startup: dead renderer\'s focus booked as abandoned record, tomatoId=' + record.tomatoId + ' minutes=' + d.focusDuration)
      } catch (e) {
        // Do NOT clear the row on a failed booking: the next boot retries (idempotent upsert on
        // the deterministic tomatoId). Clearing here would be the silent drop this module exists
        // to remove.
        log.warn('[TomatoSession] startup booking failed; durable row kept for the next boot:', e && e.message)
      }
      return d
    },
    /** Quit teardown: the phase is being explicitly ended with the user's knowledge (the confirm
     *  already resolved), so the durable row must not survive into the next boot. */
    clear () { clearRow() }
  }
}

module.exports = { createTomatoSession, sessionRowFromTransition, reconcileDecision, SESSION_KEY }
