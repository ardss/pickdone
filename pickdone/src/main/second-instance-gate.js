/* Round-3 stability (2026-09-26, finding-6): the second-instance handler used to call
 * showMainOrLock() unconditionally. When the event arrived before app.whenReady() resolved
 * (cold start with a slow dbRecovery/dbm.init chain), showMainOrLock() fell through to
 * createMainWindow() -> new BrowserWindow, which Electron hard-throws before app ready —
 * the exception escaped the listener and surfaced as a crash dialog on a plain double launch.
 *
 * Extracted here so the gate is unit-testable under plain node (index.js cannot be require()d
 * without executing the app bootstrap). Behavior when ready is unchanged: show synchronously.
 */
function wireSecondInstance (app, show) {
  app.on('second-instance', () => {
    if (app.isReady()) { show(); return }
    // Not ready yet: defer until the ready chain finished, so show() can never reach
    // new BrowserWindow before app ready.
    app.whenReady().then(() => show()).catch(() => {})
  })
}

module.exports = { wireSecondInstance }
