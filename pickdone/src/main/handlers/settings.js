/** Settings/config domain IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const i18nM = require('../i18n')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const { makeAssertMainWindow } = require('./shared')

// P2-1 (R4 2026-09-21): per-sender allowlist for the float window. The old gate was
// "float may write anything except a 3-key denylist (securityLockPassword/Question/schemaV)",
// so a compromised float could still flip enableSecurityLock:false (or any other config key)
// through this channel and disarm the lock on its next real-time isLocked() read. The float's
// ONLY legitimate write is the white-noise picker (TomatoFloatPage.vue settings/update), so the
// float is narrowed to exactly those keys; the main window keeps full write access.
const FLOAT_SETTINGS_ALLOW = new Set(['whiteNoiseAudio', 'whiteNoiseVolume'])

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
      const isMain = !!(getMainWindow() && e.sender === getMainWindow().webContents)
      const isFloat = tomatoFloat.isSelfSender(e.sender)
      if (!(isFloat || isMain)) {
        log.warn('[IPC] 拒绝非主窗/浮窗写配置, sender:', e.sender.id)
        throw new Error('forbidden: main window or float only')
      }
      // P2-1 (R4 2026-09-21): replace the old denylist with a per-sender ALLOWLIST. Denying three
      // keys left every other config key writable by a compromised float (enableSecurityLock:false
      // disarms the lock on the next isLocked() read). The float may only write the white-noise
      // keys it actually uses; anything else is stripped (and logged) before it reaches config.
      const clean = { ...patch }
      if (!isMain) {
        for (const k of Object.keys(clean)) {
          if (!FLOAT_SETTINGS_ALLOW.has(k)) { log.warn('[IPC] 浮窗越权配置键已剥离:', k); delete clean[k] }
        }
        if (!Object.keys(clean).length) return readConfig() // nothing the float may write: no config write at all
      }
      delete clean.securityLockPassword
      delete clean.securityLockQuestion
      delete clean.schemaV
      delete clean.constructor
      delete clean.prototype      // note: an own '__proto__' key on the patch is left as inert data here (spread defined it
      // safely); writeConfig's mergeConfig filters it before any merge, and a direct
      // `delete clean.__proto__` is banned by eslint no-proto.
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
