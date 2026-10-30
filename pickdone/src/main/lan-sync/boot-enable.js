'use strict'
/**
 * [H1 2026-10-25, rootcause audit] boot-time sync enable with a bounded retry ladder and a
 * VISIBLE failure (extracted from lan-sync-bootstrap to keep that module under the 800-line
 * structure ratchet — the ratchet's rule is "split, never grow").
 *
 * Contract (the quarantine-notice "degradation = one visible notice" family):
 * - fast arm: BOOT_ENABLE_ATTEMPTS tries, BOOT_ENABLE_RETRY_MS apart (the crash-storm window:
 *   after a SIGKILL the predecessor's socket teardown lags the successor's boot by seconds);
 * - late arm: ONE more attempt after BOOT_ENABLE_LATE_RETRY_MS (stragglers);
 * - visible arm: if the late attempt also fails, the degradation surfaces ONCE — a system
 *   notification (syncDegradedBody, i18n) + a 'sync-degraded' syncEvent for the settings card.
 *   The toggle shows the user's intent (K_ENABLED stays true); getStatus().listening=false
 *   shows the truth; the settings card additionally shows the degradation event.
 */

const BOOT_ENABLE_ATTEMPTS = 3
const BOOT_ENABLE_RETRY_MS = 5000
const BOOT_ENABLE_LATE_RETRY_MS = 60000

/** One visible degradation notice: Notification first, syncEvent always. Best-effort —
 *  a failure here must never crash boot. */
function syncDegradedNotice (log, emitSyncEvent) {
  try {
    const { Notification } = require('electron')
    const { mt } = require('../i18n')
    if (Notification.isSupported()) {
      const n = new Notification({ title: mt('appName'), body: mt('syncDegradedBody') })
      n.on('failed', err => { try { log.warn('[LanSync] degraded notification failed:', err && (err.message || err)) } catch { /* noop */ } })
      n.show()
    }
  } catch { /* best effort — the syncEvent below still carries the signal */ }
  try { emitSyncEvent('sync-degraded', { reason: 'boot-enable-failed' }) } catch { /* no window yet */ }
}

/** Fire-and-forget boot enable ladder (see module doc). Never rejects; never keeps the
 *  process alive (all timers unref'd). */
function bootEnableWithRetry ({ startSync, log, emitSyncEvent }) {
  const bootEnable = async () => {
    for (let attempt = 1; attempt <= BOOT_ENABLE_ATTEMPTS; attempt++) {
      try { await startSync(); return } catch (e) {
        const transient = /EADDRINUSE|failed to bind/i.test(String((e && e.message) || e))
        if (attempt === BOOT_ENABLE_ATTEMPTS || !transient) {
          log.error('[LanSync] startup enable failed:', e.message)
          // Late retry arm: one more round after the storm window, then go visible.
          const t = setTimeout(() => {
            Promise.resolve().then(() => startSync()).then(
              () => log.info('[LanSync] late startup enable succeeded after the storm window'),
              e2 => { log.error('[LanSync] startup enable failed for good:', e2 && e2.message); syncDegradedNotice(log, emitSyncEvent) }
            ).catch(e3 => { log.error('[LanSync] startup enable failed for good:', e3 && e3.message); syncDegradedNotice(log, emitSyncEvent) })
          }, BOOT_ENABLE_LATE_RETRY_MS)
          t.unref?.()
          return
        }
        log.warn(`[LanSync] startup enable attempt ${attempt}/${BOOT_ENABLE_ATTEMPTS} failed (${e.message}) — retrying in ${BOOT_ENABLE_RETRY_MS}ms`)
        await new Promise(r => setTimeout(r, BOOT_ENABLE_RETRY_MS))
      }
    }
  }
  bootEnable()
}

module.exports = { bootEnableWithRetry, syncDegradedNotice, BOOT_ENABLE_ATTEMPTS, BOOT_ENABLE_RETRY_MS, BOOT_ENABLE_LATE_RETRY_MS }
