'use strict'
// Round-3 stability (2026-09-26): extracted from index.js's whenReady chain. If this startup
// quarantined a corrupt config.json (renamed to config.json.bad), the user must know: settings
// reset for this session and the security lock is disabled until re-enabled. Notice-only — the
// fail-open semantics are unchanged. Best-effort: any failure is a warn, never a crash.
// D15 A4 (2026-10-03): message was hardcoded English while the app is zh-CN-default with full
// locales. Now resolved through the main process's existing locale source of truth
// (src/main/i18n.js currentLocale — config.json appLocale, falling back to system language),
// the same mechanism every other main-process notification/dialog uses. The strings live here
// (not in i18n.js MESSAGES) because this is the only consumer and i18n.js keys are maintained
// independently of the renderer's chunks.
const { Notification, dialog } = require('electron')
const { currentLocale } = require('./i18n')

const MESSAGES = {
  'zh-CN': {
    title: '拾事',
    body: '配置文件（config.json）已损坏且无法读取，原文件已保留为 config.json.bad。' +
      '本次会话的设置已重置，应用锁也已停用，如需要请重新开启。'
  },
  'en-US': {
    title: 'PickDone',
    body: 'Your config file (config.json) was corrupted and could not be read. ' +
      'The previous file was preserved as config.json.bad. Settings are reset for this session ' +
      'and the security lock is disabled until you re-enable it.'
  }
}

// Message selector: resolve { title, body } for an explicit locale, or from the app's resolved
// locale when omitted. Unknown values fall back to zh-CN (the app's default language).
function noticeMessages (locale) { return MESSAGES[locale || currentLocale()] || MESSAGES['zh-CN'] }

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

module.exports = { showQuarantineNotice, noticeMessages, MESSAGES }
