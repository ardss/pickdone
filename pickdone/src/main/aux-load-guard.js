/**
 * aux-load-guard — shared did-fail-load self-heal for the auxiliary windows (tomato float / quick-add).
 * F16 + refactor (2026-09-24): the retry logic used to live inline in tomato-float.js only; quick-add.js
 * had zero did-fail-load handling, so a failed page load left the window alive on the error page and the
 * toggle's reuse branch kept show()+send-ing into the dead window (typed input silently lost). This module
 * is the single source for both windows (a third copy had already drifted once):
 *   1. main-frame load failure → retry up to `retries` times with a linear backoff (400ms × n);
 *   2. retries exhausted → destroy the window; the 'closed' handler resets `win=null` and the next
 *      show()/toggle() lazily recreates a fresh instance (each window keeps its own closed-path state
 *      reset — this module deliberately does not know about it).
 * Renderer crashes (render-process-gone) stay per-window: their policies differ (float reopens, quick-add
 * does not) and they predate this module.
 *
 * W16 (2026-10-28): did-finish-load / ready-to-show proved to be a FAKE health signal — on real
 * hardware the float repeatedly ended up "window alive, load succeeded, card invisible". The guard
 * now additionally WATCHES a renderer render-health handshake: after every successful main-frame
 * load it arms a one-shot timer; when the caller's `isHandshakeHealthy` still says "no handshake"
 * at fire time, `onHandshakeTimeout` runs (the float routes that into its bounded rebuild path).
 * A handshake that does arrive within the window proves the page's Vue component actually mounted
 * its card DOM — the only health signal that distinguishes "page not initialized / component render
 * failure / blank paint" from a truly healthy float (see tomato-float.diagnose() for the layered probe).
 */
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

/**
 * Attach the load-failure guard to an aux window.
 * @param {Electron.BrowserWindow} win          the window (created by the caller)
 * @param {object} opts
 * @param {string}   opts.url                   full URL to (re)load
 * @param {string}   opts.routeMark             substring the failing URL must contain (route marker, e.g. '__tomato-float')
 * @param {string}   [opts.tag='AuxWindow']     log prefix
 * @param {number}   [opts.retries=5]           max retries before destroy
 * @param {number}   [opts.backoffMs=400]       linear backoff base (delay = backoffMs × attempt)
 * @param {Function} [opts.onRetry]             called before each reload (e.g. float stops its hit poll)
 * @param {Function} [opts.onExhausted]         called before destroy (last-chance cleanup)
 * @param {number}   [opts.handshakeTimeoutMs=10000] W16: how long to wait for the render handshake after did-finish-load
 * @param {Function} [opts.isHandshakeHealthy]  W16: (armedAt:number) => boolean — did a renderer handshake arrive since this load armed?
 * @param {Function} [opts.onHandshakeTimeout]  W16: called when the handshake is missing at timer fire (bounded rebuild belongs to the caller)
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000

function attachLoadGuard (win, opts) {
  const { url, routeMark } = opts
  const tag = opts.tag || 'AuxWindow'
  let exhaustionReported = false // W23: one structured recovery report per guard instance (see exhausted branch)
  const maxRetries = opts.retries != null ? opts.retries : 5
  const backoffMs = opts.backoffMs != null ? opts.backoffMs : 400
  let retries = 0
  // QC 2026-10-09 (D21 timer-lifecycle parity with windows.js): the backoff retry timer used to be
  // untracked — a timer armed just before the window closed fired against a destroyed window
  // (guarded by isDestroyed, but the timer itself leaked across destroy-then-recreate) and a
  // successful load left a stale pending retry that could double-fire loadURL. Track it and clear
  // on 'closed' and on 'did-finish-load'.
  let retryTimer = null
  const clearRetryTimer = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } }
  // W16: the render-handshake watch timer — same lifecycle rule as the retry timer above (a timer
  // armed by a window must die with that window, not fire against a destroyed one).
  let handshakeTimer = null
  const clearHandshakeTimer = () => { if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null } }
  /** W16: after each successful main-frame load, watch for the renderer's "card DOM mounted" handshake. */
  const armHandshakeWatch = () => {
    if (typeof opts.onHandshakeTimeout !== 'function') return
    clearHandshakeTimer()
    const armedAt = Date.now()
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null
      try {
        if (!win || win.isDestroyed()) return
        const healthy = typeof opts.isHandshakeHealthy === 'function' ? !!opts.isHandshakeHealthy(armedAt) : true
        if (healthy) return
        log.warn(`[${tag}] render handshake missing within ${opts.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS}ms of did-finish-load — treating load as unhealthy`)
        opts.onHandshakeTimeout()
      } catch (err) { try { log.warn(`[${tag}] handshake check failed`, err) } catch { /* logging is best-effort */ } }
    }, opts.handshakeTimeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS)
  }
  win.on('closed', () => { clearRetryTimer(); clearHandshakeTimer() })
  win.webContents.on('did-finish-load', () => { clearRetryTimer(); retries = 0; armHandshakeWatch() })
  win.webContents.on('did-fail-load', (e, code, desc, failUrl, isMain) => {
    if (!isMain) return // subframe/redirect noise never counts
    if (!String(failUrl).includes(routeMark)) return
    // P3 (2026-10-30): a main-frame failure must also kill the W16 handshake watch armed by a
    // previous did-finish-load — otherwise the retry chain (reload up to maxRetries) and the
    // handshake-timeout path can run CONCURRENTLY: the stale watch fires mid-backoff, reads
    // "no handshake" (the page is down, of course) and triggers a rebuild on top of the retry.
    clearHandshakeTimer()
    if (retries < maxRetries) {
      retries++
      if (opts.onRetry) { try { opts.onRetry() } catch (err) { /* cleanup must not break the retry chain */ } }
      log.warn(`[${tag}] 页面加载失败，重试`, retries, code, desc)
      clearRetryTimer()
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (win && !win.isDestroyed()) win.loadURL(url).catch(() => {})
      }, backoffMs * retries)
      return
    }
    // Retries exhausted: a dead error-page window is invisible to the user yet still always-on-top
    // (and for the float: still hit-polled) until restart. Destroy it — 'closed' resets the owner's
    // win reference and the next show()/toggle() lazily recreates a fresh window.
    log.error(`[${tag}] 页面加载重试耗尽，销毁窗口等待下次唤起重建`, code, desc)
    // W23 (P2, 2026-10-31): exhaustion used to be pure console silence (the log.error above only
    // reaches the log file). Report it once per guard instance over the SAME recovery channel the
    // W16 handshake timeout uses (the existing 'float-recovery-exhausted' syncEvent type — no new
    // enum entry, so the r4 set-equality gate stays intact), with a code that names the cause.
    // Renderer side (syncDegradedToast) surfaces it; lazy-require keeps aux windows without a
    // live sync bootstrap working, and every failure here is best-effort by design.
    if (!exhaustionReported) {
      exhaustionReported = true
      try {
        const bootstrap = require('./lan-sync-bootstrap')
        if (typeof bootstrap.emitSyncEvent === 'function') bootstrap.emitSyncEvent('float-recovery-exhausted', { code: 'load-guard-retries-exhausted' })
        else throw new Error('emitSyncEvent unavailable')
      } catch (e) {
        try {
          const { getMainWindow } = require('./window-ref')
          const mw = getMainWindow()
          if (mw && !mw.isDestroyed()) mw.webContents.send('syncEvent', { type: 'float-recovery-exhausted', code: 'load-guard-retries-exhausted', at: Date.now() })
        } catch (e2) { /* renderer notification is best-effort */ }
      }
    }
    if (opts.onExhausted) { try { opts.onExhausted() } catch (err) { /* already best-effort */ } }
    try { if (win && !win.isDestroyed()) win.destroy() } catch (err) { /* already gone */ }
  })
}

module.exports = { attachLoadGuard }
