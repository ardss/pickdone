/** Settings/config domain IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const i18nM = require('../i18n')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const { makeAssertMainWindow } = require('./shared')

module.exports = function settingsHandlers (ctx) {
  const { readConfig, writeConfig, app, getMainWindow, applyShortcuts, rebuildTrayMenu, getTray } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)

  return {
    // --- Settings / config ---
    // Sensitive-key stripping: the security-lock ciphertext in config must never be sent down to any renderer window (a compromised auxiliary window could pair with decrypt-secret to recover the lock-screen plaintext password)
    'get-settings': () => {
      const c = readConfig()
      delete c.securityLockPassword
      delete c.securityLockQuestion
      return c
    },
    // P2 2026-09-12: MAIN_WINDOW_ONLY guard — verified via grep that the only renderer call sites are
    // the main settings page (renderer/js/i18n/index.js setLocale) and the cross-window localStorage
    // 'appLocale' echo in renderer/js/main.js:308 (the float window loads the same bundle, so the echo
    // fires there too; it is a redundant re-notify of a change the main window already persisted).
    // Changing the app-wide language must not be triggerable by an auxiliary window.
    'set-app-locale': (e, locale) => {
      assertMainWindow(e)
      const main = getMainWindow()
      i18nM.setLocale(locale); const c = writeConfig({ appLocale: locale }); rebuildTrayMenu(); const tray = getTray(); if (tray) { try { tray.setToolTip(i18nM.mt('appName')) } catch (err) { /* empty */ } }
      // P2 2026-09-12: previously this looped EVERY live window and setTitle(appName), flattening
      // semantic titles (float window task title, lock window title). Auxiliary windows pick up the
      // new locale via their own per-second title pushes (tomato-float countdown, same pattern as the
      // taskbar setBaseTitle precedent); only the main window's title is the plain appName.
      try { if (!main.isDestroyed()) main.setTitle(i18nM.mt('appName')) } catch (err) { /* dying window */ }
      try { tomatoTaskbar.setBaseTitle(i18nM.mt('appName')) } catch (err) { /* taskbar module keeps its previous base */ }
      return c
    },
    'notify-settings-updated': (e, patch) => {
      // 写配置限主窗;浮窗白噪音选择是合法写入(浮窗内 settings/update 走此通道),放行浮窗自身(2026-09-05 终审 P1)
      if (!(tomatoFloat.isSelfSender(e.sender) || (getMainWindow() && e.sender === getMainWindow().webContents))) {
        log.warn('[IPC] 拒绝非主窗/浮窗写配置, sender:', e.sender.id)
        throw new Error('forbidden: main window or float only')
      }
      // Symmetric hardening of the write side with the read side: strip security keys and never send them down, and likewise never accept renderer writes for them
      // (a compromised auxiliary window could previously change the lock password / disable the lock via this channel — isLocked() reads config in real time, so the lock would fail on the next check cycle)
      const clean = Object.assign({}, patch)
      delete clean.securityLockPassword
      delete clean.securityLockQuestion
      delete clean.schemaV
      const c = writeConfig(clean)
      // P2 2026-09-12 defensive check on the writeConfig contract: config-store.js writeConfig returns
      // Object.assign(readConfig(), patch) — the full merged config — so c.shortcutKeySettings is
      // normally present. But if that contract ever drifts (e.g. a patch-only return, or readConfig's
      // config.json.bad quarantine path returning a bare object), blindly feeding undefined into
      // applyShortcuts would silently unregister every shortcut. Guard instead.
      if (c && c.shortcutKeySettings) applyShortcuts(c.shortcutKeySettings)
      else log.warn('[IPC] writeConfig 返回缺少 shortcutKeySettings,跳过快捷键重注册')
      // Make launch-at-login actually take effect (aligned with the reference runWhenComputerStart)
      if ('runWhenComputerStart' in clean) {
        try { app.setLoginItemSettings({ openAtLogin: !!clean.runWhenComputerStart }) } catch (err) { log.warn(err) }
      }
      return c
    }
  }
}
