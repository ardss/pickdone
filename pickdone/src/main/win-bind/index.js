/** T7 win-bind IPC handler domain — the five dedicated win-bind:* channels (frozen contract).
 *  Shape: (ctx) => ({ channel: fn }), merged by src/main/index.js registerIpc Object.assign
 *  (handlers/tomato.js:10 form). ctx from registerIpc hctx: { log, isLocked, getMainWindow }.
 *
 *  Every channel is main-window-gated AND lock-gated (tomato.js:192-197 form): while the
 *  security lock is active no probe and no activation runs.
 *  Dedicated channels (NOT dbCall) — the renderer's whole win-bind surface is these five
 *  invoke channels + one 'win-bind-changed' subscription event, so the dbCall three-way
 *  whitelist stays untouched (purgeRecycleBin dedicated-channel precedent, preload:38-39).
 *
 *  Lazy adapter: nothing spawns until the first win-bind:* call (then the resident PS child
 *  boots behind the ping handshake — see adapter.js). ctx.__winBindDeps injects fakes for
 *  unit tests; ctx.broadcastWinBindChanged overrides the default all-windows broadcast. */
'use strict'
const { makeAssertMainWindow } = require('../handlers/shared')
const { createWinAdapter } = require('./adapter')
const createWinBindStore = require('./store')
const { decideIdentify, resolveBinding, makeRef } = require('./pure/match')

/** The one adapter instance shared by all channels (created lazily). Module-level so the
 *  quit chain can dispose it without reaching into a handler closure. */
let liveAdapter = null

function ensureAdapter () {
  if (!liveAdapter) liveAdapter = createWinAdapter()
  return liveAdapter
}

/** Default broadcast: push 'win-bind-changed' {reason:'bind'|'unbind', taskId} to every live
 *  window so multi-window badge state stays in sync (onMigrateProgress-style subscription,
 *  preload side; no handler channel involved). */
function defaultBroadcast (payload) {
  try {
    const { BrowserWindow } = require('electron') // lazy: tests never hit this branch
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) w.webContents.send('win-bind-changed', payload)
      } catch { /* window dying mid-send */ }
    }
  } catch { /* no electron in this process */ }
}

function isValidRef (ref) {
  return !!ref && typeof ref === 'object' &&
    typeof ref.processName === 'string' && typeof ref.execPath === 'string' && typeof ref.title === 'string' &&
    Number.isFinite(ref.pidHint) && Number.isFinite(ref.hwnd)
}

module.exports = function winBindHandlers (ctx) {
  const log = ctx.log || console
  const assertMainWindow = makeAssertMainWindow(ctx.getMainWindow)
  const injected = ctx.__winBindDeps || {}
  const adapter = injected.adapter || null
  const store = injected.store || createWinBindStore({ log })
  const broadcast = ctx.broadcastWinBindChanged || defaultBroadcast
  const getAdapter = () => adapter || ensureAdapter()

  const assertUnlocked = () => {
    if (ctx.isLocked && ctx.isLocked()) throw new Error('forbidden: app is locked')
  }

  return {
    // F1 identify: zero args from the renderer — PS owns the cursor. Adapter failure of any
    // kind (spawn, protocol, timeout) collapses to ADAPTER_ERROR; identify never throws.
    'win-bind:identify': async (e) => {
      assertMainWindow(e)
      assertUnlocked()
      let probe
      try {
        probe = await getAdapter().probeUnderCursor()
      } catch (err) {
        try { log.warn('[win-bind] identify probe failed:', err && err.message) } catch { /* best-effort */ }
        return { window: null, reason: 'ADAPTER_ERROR' }
      }
      return decideIdentify({ raw: probe && probe.raw, buttonDown: probe ? probe.buttonDown : null, ownPid: process.pid })
    },

    // Bind: validate → re-verify against a FRESH snapshot (hwnd+pid must both match and the
    // window must not be ours — a forged or closed window is STALE_REF, double protection) →
    // persist the fresh normalized ref (makeRef caps + normProcName, renderer strings are not
    // trusted verbatim) with the bind-time stamp → broadcast.
    'win-bind:bind': async (e, taskId, ref) => {
      assertMainWindow(e)
      assertUnlocked()
      if (typeof taskId !== 'string' || taskId.length < 1 || taskId.length > 128 || !isValidRef(ref)) {
        return { ok: false, reason: 'BAD_ARGS' }
      }
      let wins
      try {
        wins = await getAdapter().enumerate()
      } catch (err) {
        // BindResult has no ADAPTER_ERROR member; an unverifiable ref is fail-closed = stale.
        try { log.warn('[win-bind] bind verify enumerate failed:', err && err.message) } catch { /* best-effort */ }
        return { ok: false, reason: 'STALE_REF' }
      }
      const hit = (wins || []).find(w => w && w.hwnd === ref.hwnd && w.pid === ref.pidHint && w.pid !== process.pid)
      if (!hit) return { ok: false, reason: 'STALE_REF' }
      const binding = { taskId, ref: Object.assign(makeRef(hit), { boundAt: Date.now() }) }
      if (!store.put(binding)) return { ok: false, reason: 'STORE_ERROR' }
      try { broadcast({ reason: 'bind', taskId }) } catch { /* broadcast is best-effort */ }
      return { ok: true, binding }
    },

    // Activate: store → fresh snapshot → pure ladder → activate hwnd; foreground check runs
    // inside PS (SetForegroundWindow + GetForegroundWindow re-verify; FlashWindow degrade).
    'win-bind:activate': async (e, taskId) => {
      assertMainWindow(e)
      assertUnlocked()
      const binding = store.get(typeof taskId === 'string' ? taskId : '')
      if (!binding) return { ok: false, reason: 'NO_BINDING' }
      let wins
      try {
        wins = await getAdapter().enumerate()
      } catch (err) {
        try { log.warn('[win-bind] activate enumerate failed:', err && err.message) } catch { /* best-effort */ }
        return { ok: false, reason: 'ADAPTER_ERROR' }
      }
      const res = resolveBinding(binding, wins || [], process.pid)
      if (res.status === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' }
      if (res.status === 'AMBIGUOUS') return { ok: false, reason: 'AMBIGUOUS', candidates: res.candidates }
      let act
      try {
        act = await getAdapter().activateHwnd(res.hwnd)
      } catch (err) {
        try { log.warn('[win-bind] activate failed:', err && err.message) } catch { /* best-effort */ }
        return { ok: false, reason: 'ACTIVATE_FAILED', flashed: false }
      }
      if (act && act.foregroundNow) return { ok: true }
      return { ok: false, reason: 'ACTIVATE_FAILED', flashed: !!(act && act.flashed) }
    },

    // Unbind: idempotent by construction (store.remove is), never throws.
    'win-bind:unbind': async (e, taskId) => {
      assertMainWindow(e)
      assertUnlocked()
      const removed = store.remove(typeof taskId === 'string' ? taskId : '')
      try { broadcast({ reason: 'unbind', taskId: typeof taskId === 'string' ? taskId : '' }) } catch { /* best-effort */ }
      return { ok: true, removed }
    },

    // List: hydration pull; the renderer filters orphan bindings by its known taskIds
    // (frozen contract: main does NOT GC orphans).
    'win-bind:list': async (e) => {
      assertMainWindow(e)
      assertUnlocked()
      return { bindings: store.list() }
    }
  }
}

/** Kill the resident PS child on app quit — wired into the will-quit flushNow chain by
 *  src/main/index.js (try/catch there). Safe to call any number of times. */
module.exports.disposeForQuit = function disposeForQuit () {
  try { if (liveAdapter) liveAdapter.dispose() } catch { /* best-effort */ }
  liveAdapter = null
}
