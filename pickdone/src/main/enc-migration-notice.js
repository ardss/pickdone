'use strict'
/**
 * [H5 2026-10-25, rootcause audit] surface the plaintext-fallback session ONCE: the
 * plaintext->encrypted migration failed at init and the session runs UNENCRYPTED while the
 * user believes data is at-rest encrypted. Same shape as quarantine-notice.js (Notification
 * first, non-modal dialog fallback, i18n via the main-process copy's single owner).
 * Consumed by index.js's whenReady chain; the flag itself lives in db.js
 * (consumeEncMigrationDegraded). Extracted to its own module for the structure ratchet
 * ("split, never grow") and for shape-parity with quarantine-notice.
 */
const { Notification, dialog } = require('electron')

function showEncMigrationNotice (win, log) {
  try {
    const dbm = require('./db')
    if (!dbm.consumeEncMigrationDegraded()) return
    const { mt } = require('./i18n')
    const m = { title: mt('appName'), body: mt('encMigrationDegradedBody') }
    log.warn('[App] plaintext->encrypted migration failed earlier: this session runs on a PLAINTEXT db — surfacing one notice')
    let shown = false
    try {
      if (Notification.isSupported()) {
        // Same guard as handlers/system.js: an unhandled Notification 'failed' event crashes main.
        const n = new Notification({ title: m.title, body: m.body })
        n.on('failed', err => { try { log.warn('[App] enc-migration notification failed:', err && (err.message || err)) } catch { /* noop */ } })
        n.show()
        shown = true
      }
    } catch { /* fall through to the non-modal dialog */ }
    if (!shown) dialog.showMessageBox(win, { type: 'warning', title: m.title, message: m.body, buttons: ['OK'] }).catch(() => {})
  } catch (e) { log.warn('[App] enc-migration notice failed:', e && e.message) }
}

module.exports = { showEncMigrationNotice }
