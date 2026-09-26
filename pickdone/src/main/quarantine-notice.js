'use strict'
// Round-3 stability (2026-09-26): extracted from index.js's whenReady chain. If this startup
// quarantined a corrupt config.json (renamed to config.json.bad), the user must know: settings
// reset for this session and the security lock is disabled until re-enabled. Notice-only — the
// fail-open semantics are unchanged. Best-effort: any failure is a warn, never a crash.
const { Notification, dialog } = require('electron')

function showQuarantineNotice (win, log) {
  try {
    const { consumeQuarantineNotice } = require('./config-store')
    if (!consumeQuarantineNotice()) return
    const body = 'Your config file (config.json) was corrupted and could not be read. ' +
      'The previous file was preserved as config.json.bad. Settings are reset for this session ' +
      'and the security lock is disabled until you re-enable it.'
    log.warn('[App] config.json was corrupted and quarantined as config.json.bad; security lock disabled until re-enabled')
    let shown = false
    try {
      if (Notification.isSupported()) { new Notification({ title: 'PickDone', body }).show(); shown = true }
    } catch { /* fall through to the non-modal dialog */ }
    if (!shown) dialog.showMessageBox(win, { type: 'warning', title: 'PickDone', message: body, buttons: ['OK'] }).catch(() => {})
  } catch (e) { log.warn('[App] quarantine notice failed:', e && e.message) }
}

module.exports = { showQuarantineNotice }
