import { commit as commitCommand } from "./commandBus.js"
import { isAuxWindow } from "./auxWindow.js"
/**
 * localStorage → SQLite persistence mirror — the three "master data that should live in the DB" states all go through here:
 *   db.settingsState (all settings) / db.habitsState (habit check-ins) / (db.tomatoState 已退役:账本迁 tomato_records 行表,mirror 仅剩 settings/habits)
 * Model: localStorage is the live runtime copy and cross-window sync channel; each debounced mirror write goes to a DB meta row; on startup the DB takes precedence for restore.
 * A one-time migration achieves durability: after the first mirror write the DB is the persistent copy, so data survives even if LS is cleared.
 */
const DEBOUNCE_MS = 2000
/** Exponential backoff for failed setMeta retries: 2s → 4s → … capped at 60s, abandoned after maxAttempts */
const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000
const RETRY_MAX_ATTEMPTS = 10
/** Test hook: unit tests shrink the delays to keep the suite fast (prod code never touches this) */
export const _timing = { debounceMs: DEBOUNCE_MS, retryBaseMs: RETRY_BASE_MS, retryMaxMs: RETRY_MAX_MS, maxAttempts: RETRY_MAX_ATTEMPTS }

const timers = {}
const pendings = {} // Blobs pending within the debounce window (used by quit flush)
const newest = {} // Newest blob ever queued per key — a late rejection of an older write must never clobber it
const attempts = {} // Consecutive failure count per key (drives the backoff and the give-up)

function scheduleTimer (metaKey, delay) {
  if (timers[metaKey]) return
  timers[metaKey] = setTimeout(() => { delete timers[metaKey]; flushKey(metaKey) }, delay)
}

/** One flush attempt for a key: hand the pending blob to writeNow; the pending slot is only released
 *  once the write could actually be initiated (early-exit environments keep the blob queued). */
function flushKey (metaKey) {
  const b = pendings[metaKey]
  if (b === undefined) return
  if (writeNow(metaKey, b)) {
    delete pendings[metaKey]
  } else {
    // Degraded host / aux window: keep the blob pending; a later mirrorToDb call will retry it.
    // No retry timer here — that environment never becomes writable on its own.
  }
}

function scheduleRetry (metaKey, blob) {
  // Stale-rejection guard: if a NEWER blob has been queued for this key since this write was issued,
  // the newer blob already represents the current state — re-queueing the old one would roll the
  // mirror back (write#1 rejects after write#2 landed). Drop the stale failure instead.
  if (newest[metaKey] !== blob) {
    console.info('[dbMirror] stale setMeta failure ignored (a newer blob already superseded it):', metaKey)
    return
  }
  const n = (attempts[metaKey] || 0) + 1
  if (n > _timing.maxAttempts) {
    // Give up after 10 consecutive failures: infinite no-backoff hammering otherwise spins forever
    delete pendings[metaKey]; delete newest[metaKey]; delete attempts[metaKey]
    console.error('[dbMirror] setMeta for', metaKey, 'failed', _timing.maxAttempts, 'times — giving up on this blob (data still live in localStorage)')
    return
  }
  attempts[metaKey] = n
  const delay = Math.min(_timing.retryMaxMs, _timing.retryBaseMs * 2 ** (n - 1))
  pendings[metaKey] = blob
  console.warn('[dbMirror] setMeta failed (attempt', n, '), retrying in', delay, 'ms:', metaKey)
  scheduleTimer(metaKey, delay)
}

/** Initiate one DB write; returns true when the write was actually handed to the DB bridge
 *  (the promise may still reject later — scheduleRetry handles that), false when the environment
 *  made writing impossible (blob stays queued in pendings). */
function writeNow (metaKey, blob) {
  newest[metaKey] = blob
  try {
    if (!window.todoAPI?.dbCall) return false
    // setMeta is now a main-window-only op (to prevent a compromised aux window from batch-modifying meta); aux windows (float/quick-add) don't write the DB directly —
    // LS is the cross-window sync channel; after the main window receives state via the storage event, the main window's mirror persists it
    // Aux-window gate now goes through the shared isAuxWindow() helper (same regex lived hand-copied in several files — one source of truth)
    if (isAuxWindow()) return false
    commitCommand("meta", "put", [metaKey, JSON.stringify(blob)])
      // Success resets the backoff/give-up counter — but only when THIS blob is still the newest
      // one for the key: a late success of an older write must not clear the retry budget of the
      // newer blob's pending failure cycle (mirror of scheduleRetry's stale-rejection guard).
      .then(() => { if (newest[metaKey] === blob) delete attempts[metaKey] })
      .catch(() => scheduleRetry(metaKey, blob))
    return true
  } catch (e) {
    // degraded host (no todoAPI): previously swallowed too — surface it at least
    console.warn('[dbMirror] setMeta threw:', metaKey, e)
    return false
  }
}

export function mirrorToDb (metaKey, blob, immediate = false) {
  pendings[metaKey] = blob
  newest[metaKey] = blob
  attempts[metaKey] = 0 // a fresh user write gets a fresh retry budget
  if (immediate) {
    // Compensation path (LS write failure etc.): skip the debounce and persist immediately, otherwise failing again within the 2s window = data exists only in memory
    clearTimeout(timers[metaKey]); delete timers[metaKey]
    flushKey(metaKey)
    return
  }
  clearTimeout(timers[metaKey])
  timers[metaKey] = setTimeout(() => { delete timers[metaKey]; flushKey(metaKey) }, _timing.debounceMs)
}

// Quit flush: main process before-quit broadcast (mirrors pending in the debounce window are flushed to disk immediately, otherwise quit/crash loses the last write)
if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.onAppQuittingFlush) {
  window.todoAPI.onAppQuittingFlush(() => {
    for (const k of Object.keys(timers)) { clearTimeout(timers[k]); delete timers[k] }
    for (const k of Object.keys(pendings)) {
      const b = pendings[k]
      if (b === undefined) { delete pendings[k]; continue }
      // D5 (2026-09-20): the pending blob is only released when the write was actually handed to the
      // bridge — mirroring flushKey's semantics. The old code deleted the pending BEFORE writeNow, so
      // on a no-bridge/aux-window host the blob vanished instead of surviving for a later retry.
      if (writeNow(k, b)) delete pendings[k]
    }
  })
}

export async function restoreFromDb (metaKey) {
  try {
    if (!window.todoAPI?.dbCall) return null
    const raw = await window.todoAPI.dbCall('getMeta', metaKey)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
