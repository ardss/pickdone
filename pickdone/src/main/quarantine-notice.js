'use strict'
// Round-3 stability (2026-09-26): extracted from index.js's whenReady chain. If this startup
// quarantined a corrupt config.json (renamed to config.json.bad), the user must know: settings
// reset for this session and the security lock is disabled until re-enabled. Notice-only — the
// fail-open semantics are unchanged. Best-effort: any failure is a warn, never a crash.
// D15 A4 (2026-10-03): message was hardcoded English while the app is zh-CN-default with full
// locales. Strings live in src/main/i18n.js MESSAGES (the main-process copy's single owner —
// the i18n gate rejects user-visible literals in src/main) and resolve through the existing
// locale source of truth (config.json appLocale, falling back to system language), the same
// mechanism every other main-process notification/dialog uses.
const { Notification, dialog } = require('electron')
const { mt, mtIn } = require('./i18n')

// Message selector: resolve { title, body } for an explicit locale, or from the app's resolved
// locale when omitted. Unknown values fall back to zh-CN (the app's default language).
function noticeMessages (locale) {
  return locale
    ? { title: mtIn(locale, 'appName'), body: mtIn(locale, 'quarantineBody') }
    : { title: mt('appName'), body: mt('quarantineBody') }
}

function showQuarantineNotice (win, log) {
  try {
    const { consumeQuarantineNotice } = require('./config-store')
    if (!consumeQuarantineNotice()) return
    const m = noticeMessages()
    log.warn('[App] config.json was corrupted and quarantined as config.json.bad; security lock disabled until re-enabled')
    let shown = false
    try {
      if (Notification.isSupported()) { new Notification({ title: m.title, body: m.body }).show(); shown = true }
    } catch { /* fall through to the non-modal dialog */ }
    if (!shown) dialog.showMessageBox(win, { type: 'warning', title: m.title, message: m.body, buttons: ['OK'] }).catch(() => {})
  } catch (e) { log.warn('[App] quarantine notice failed:', e && e.message) }
}

module.exports = { showQuarantineNotice, noticeMessages }
