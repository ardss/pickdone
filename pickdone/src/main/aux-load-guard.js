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
 */
const log = require('electron-log')

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
 */
function attachLoadGuard (win, opts) {
  const { url, routeMark } = opts
  const tag = opts.tag || 'AuxWindow'
  const maxRetries = opts.retries != null ? opts.retries : 5
  const backoffMs = opts.backoffMs != null ? opts.backoffMs : 400
  let retries = 0
  win.webContents.on('did-finish-load', () => { retries = 0 })
  win.webContents.on('did-fail-load', (e, code, desc, failUrl, isMain) => {
    if (!isMain) return // subframe/redirect noise never counts
    if (!String(failUrl).includes(routeMark)) return
    if (retries < maxRetries) {
      retries++
      if (opts.onRetry) { try { opts.onRetry() } catch (err) { /* cleanup must not break the retry chain */ } }
      log.warn(`[${tag}] 页面加载失败，重试`, retries, code, desc)
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.loadURL(url).catch(() => {})
      }, backoffMs * retries)
      return
    }
    // Retries exhausted: a dead error-page window is invisible to the user yet still always-on-top
    // (and for the float: still hit-polled) until restart. Destroy it — 'closed' resets the owner's
    // win reference and the next show()/toggle() lazily recreates a fresh window.
    log.error(`[${tag}] 页面加载重试耗尽，销毁窗口等待下次唤起重建`, code, desc)
    if (opts.onExhausted) { try { opts.onExhausted() } catch (err) { /* already best-effort */ } }
    try { if (win && !win.isDestroyed()) win.destroy() } catch (err) { /* already gone */ }
  })
}

module.exports = { attachLoadGuard }
