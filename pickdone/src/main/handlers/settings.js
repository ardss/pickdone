/** Settings/config domain IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const i18nM = require('../i18n')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')

module.exports = function settingsHandlers (ctx) {
  const { readConfig, writeConfig, app, getMainWindow, applyShortcuts, rebuildTrayMenu, getTray } = ctx

  return {
    // --- Settings / config ---
    // Sensitive-key stripping: the security-lock ciphertext in config must never be sent down to any renderer window (a compromised auxiliary window could pair with decrypt-secret to recover the lock-screen plaintext password)
    'get-settings': () => {
      const c = readConfig()
      delete c.securityLockPassword
      delete c.securityLockQuestion
      return c
    },
    'set-app-locale': (e, locale) => { i18nM.setLocale(locale); const c = writeConfig({ appLocale: locale }); rebuildTrayMenu(); const tray = getTray(); if (tray) { try { tray.setToolTip(i18nM.mt('appName')) } catch (err) { /* empty */ } } // P2 2026-09-12: only the main window was retitle — the float/lock windows kept the old language until restart. Retitle every live window; windows created afterwards naturally pick up the new locale (title comes from i18n.mt at creation time in windows.js, no extra work needed).
      for (const w of require('electron').BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.setTitle(i18nM.mt('appName')) } catch (err) { /* dying window */ } } try { tomatoTaskbar.setBaseTitle(i18nM.mt('appName')) } catch (err) { /* taskbar module keeps its previous base */ } return c },
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
      applyShortcuts(c.shortcutKeySettings)
      // Make launch-at-login actually take effect (aligned with the reference runWhenComputerStart)
      if ('runWhenComputerStart' in clean) {
        try { app.setLoginItemSettings({ openAtLogin: !!clean.runWhenComputerStart }) } catch (err) { log.warn(err) }
      }
      return c
    }
  }
}
