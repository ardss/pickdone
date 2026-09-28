/**
 * Pure helpers for running-tomato announcements (renderer side of the contract).
 * These MIRROR src/main/tomato-announce.js (buildAnnounceValue / isStaleAnnounce /
 * remainSecOfAnnounce) — renderer code cannot require the CommonJS main module, so the
 * two implementations are kept in lockstep by tests/unit/store/tomato-remote-announce.test.mjs,
 * which runs the SAME fixtures through both and asserts identical results
 * (contract-mirror pattern, see tests/unit/store/tomato-remote-announce.test.mjs).
 */

// r6: sanitize through the SHARED single source (shared/sanitize-text.mjs — the same
// implementation src/main/sanitize.js ships, pinned equal by the mirror test's hostile
// fixtures). The mirror previously did bare String(): long deviceName/attachTodo fields
// and RTL/bidi injection chars passed unclamped on the renderer announce path while the
// main process clamped to 128/40/120/120 — the "identical" contract was only true for
// short clean fixtures.
import { sanitizeText } from '../../../../shared/sanitize-text.mjs'

/** Announce payload builder — identical semantics to the main-process copy. */
export function buildAnnounceValue ({ deviceId, deviceName, status, startedAt, plannedSec, attachTodoId, attachTodoTitle, at } = {}) {
  const now = Number(at) || Date.now()
  const base = {
    deviceId: sanitizeText(String(deviceId || ''), 128),
    deviceName: sanitizeText(String(deviceName || ''), 40),
    status: status === 'running' ? 'running' : 'idle',
    startedAt: Number(startedAt) || 0,
    plannedSec: Math.max(0, Number(plannedSec) || 0),
    at: now,
  }
  if (base.status === 'running' && attachTodoId) {
    base.attachTodoId = sanitizeText(String(attachTodoId || ''), 120)
    base.attachTodoTitle = sanitizeText(String(attachTodoTitle || ''), 120)
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
