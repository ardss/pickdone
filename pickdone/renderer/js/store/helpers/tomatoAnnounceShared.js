/**
 * Pure helpers for running-tomato announcements (renderer side of the contract).
 * These MIRROR src/main/tomato-announce.js (buildAnnounceValue / isStaleAnnounce /
 * remainSecOfAnnounce) — renderer code cannot require the CommonJS main module, so the
 * two implementations are kept in lockstep by tests/unit/store/tomato-remote-announce.test.mjs,
 * which runs the SAME fixtures through both and asserts identical results
 * (contract-mirror pattern, see tests/unit/contract-mirrors.test.mjs).
 */

/** Announce payload builder — identical semantics to the main-process copy. */
export function buildAnnounceValue ({ deviceId, deviceName, status, startedAt, plannedSec, attachTodoId, attachTodoTitle, at } = {}) {
  const now = Number(at) || Date.now()
  const base = {
    deviceId: String(deviceId || ''),
    deviceName: String(deviceName || ''),
    status: status === 'running' ? 'running' : 'idle',
    startedAt: Number(startedAt) || 0,
    plannedSec: Math.max(0, Number(plannedSec) || 0),
    at: now,
  }
  if (base.status === 'running' && attachTodoId) {
    base.attachTodoId = String(attachTodoId)
    base.attachTodoTitle = String(attachTodoTitle || '')
  }
  return base
}

const STALE_AGE_FACTOR = 2

/** Staleness rule — identical semantics to the main-process copy (TTL self-healing). */
export function isStaleAnnounce (v, now = Date.now()) {
  if (!v || v.status !== 'running' || !v.startedAt || !v.plannedSec) return true
  const plannedMs = v.plannedSec * 1000
  if (v.startedAt + plannedMs < now) return true
  return now - (v.at || v.startedAt) > plannedMs * STALE_AGE_FACTOR
}

/** Remaining seconds of a running announce (floor) — identical to the main-process copy. */
export function remainSecOfAnnounce (v, now = Date.now()) {
  if (!v || v.status !== 'running' || !v.startedAt || !v.plannedSec) return 0
  return Math.max(0, Math.floor((v.startedAt + v.plannedSec * 1000 - now) / 1000))
}
