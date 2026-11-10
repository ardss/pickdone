/**
 * capture-port-sentinel — the USER-VISIBLE side of the 7789 port-conflict remediation
 * (J3, qa-r7 P1 handoff). The capture door already falls back to basePort+1 on
 * EADDRINUSE/EACCES; before this module that fallback was a silent info log, so the
 * browser extension kept posting to 7789 — now held by a stranger — and the user never
 * learned why captures stalled. The moved port is now announced on three channels:
 *   1. an error-level log line (journey/CI can pin it),
 *   2. an OS notification with the concrete remediation path,
 *   3. the door answers themselves carry X-PickDone-Door/X-PickDone-Port identity headers
 *      (capture-endpoint/server.js), which the extension popup probe renders with
 *      one-click retry guidance (extension/shared/door-probe.js).
 * Dependency-injected (notification factory) so the unit test can assert the visible
 * payload without Electron.
 */

const CONTRACT = require('./capture-endpoint/contract.cjs')

function announceCapturePort (port, deps = {}) {
  const log = deps.log || { error: () => {}, warn: () => {} }
  const showNotification = deps.showNotification || ((title, body) => {
    try {
      const { Notification } = require('electron')
      if (!Notification.isSupported()) return false
      new Notification({ title, body }).show()
      return true
    } catch (e) {
      log.warn('[capture-port-sentinel] notification failed:', e && e.message)
      return false
    }
  })
  if (port === CONTRACT.CAPTURE_PORT) return { conflict: false, notified: false }
  const title = 'PickDone capture port conflict'
  const body = `Port ${CONTRACT.CAPTURE_PORT} was busy, the capture door moved to ${port}. ` +
    'Browser/VS Code extensions still send to ' + CONTRACT.CAPTURE_PORT + ' — open Settings → Capture for the live address.'
  log.error(`[Init] capture endpoint PORT CONFLICT: contract port ${CONTRACT.CAPTURE_PORT} was busy, the door bound ${port} — browser/VS Code extensions still target ${CONTRACT.CAPTURE_PORT} and MUST be repointed (Settings → Capture shows the live door address)`)
  const notified = showNotification(title, body)
  return { conflict: true, notified }
}

module.exports = { announceCapturePort }

/**
 * Boot wiring for the S4 capture door: pins the actual bound port in the log (the
 * extension journey asserts this line) and hands the port to the sentinel. Never
 * rejects — a door that never binds surfaces as an error log, not an unhandled rejection.
 */
function wireCaptureDoor (door, log) {
  if (!door || !door.ready) return
  door.ready.then(p => {
    log.info(`[Init] capture endpoint listening on 127.0.0.1:${p}`)
    announceCapturePort(p, { log })
  }).catch(e => log.error('[Init] capture endpoint never bound:', e && e.message))
}

module.exports = { announceCapturePort, wireCaptureDoor }
