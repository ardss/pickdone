/** Settings/config domain IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
require('../log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const i18nM = require('../i18n')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const { makeAssertMainWindow, makeSenderIsMain, stripForbiddenSettingsKeys } = require('./shared')

// Response-shaped projector for outbound config: stripForbiddenSettingsKeys only cleans the
// INBOUND patch, but writeConfig returns the FULL merged on-disk config (config-store.js
// mergeConfig(readConfig(), patch)), so returning it verbatim from a write handler hands the
// security-lock ciphertext + plaintext recovery question back to the calling window — the exact
// material the get-settings read path (below) is documented to never send down. Any handler that
// returns a config to a renderer must pass it through this first.
function sanitizeConfigOut (c) {
  if (!c || typeof c !== 'object') return c
  delete c.securityLockPassword
  delete c.securityLockQuestion
  return c
}

module.exports = function settingsHandlers (ctx) {
  const { readConfig, writeConfig, app, getMainWindow, applyShortcuts, rebuildTrayMenu, getTray, isLocked, isLockWindow } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)
  // M2b (P3 2026-10-23): boolean ownership twin (shared.js makeSenderIsMain) — the inline
  // `getMainWindow() && e.sender === getMainWindow().webContents` test below threw a TypeError when
  // the main window was destroyed mid-tick (isDestroyed-safe like the throw twin); a destroyed
  // window's sender now simply reads as "not main" → forbidden, same as null.
  // The inline fallback only covers test stubs of './shared' predating makeSenderIsMain.
  const senderIsMain = typeof makeSenderIsMain === 'function'
    ? makeSenderIsMain(getMainWindow)
    : (e) => { const w = getMainWindow(); return !!(w && !w.isDestroyed() && e && e.sender === w.webContents) }

  return {
    // --- Settings / config ---
    // Sensitive-key stripping: the security-lock ciphertext in config must never be sent down to any renderer window (a compromised auxiliary window could pair with decrypt-secret to recover the lock-screen plaintext password)
    'get-settings': (e) => {
      // W17 (P2): last gateless read channel while locked — every sibling config consumer
      // already throws (handlers/todo.js:125 style). A locked aux window used to read the full
      // config (backup whitelist / winBounds / shortcuts). The lock-screen window itself stays
      // exempt (same isLockWindow carve-out as the todo bus); other callers while locked throw.
      // W18 fix: the tomato-float window stays VISIBLE while locked (lockAppNow only hides the
      // main window + quick-add — security-lock.js), and its legitimate get-settings read
      // (white-noise list) was newly bricked by the W17 gate: every read rejected while the
      // lock screen was up. Carve out the float window itself — same sender-identity test
      // (tomatoFloat.isSelfSender) notify-settings-updated already uses for its float write
      // carve-out; NOT a general exemption, any other window still throws.
      if (isLocked && isLocked() && !(isLockWindow && e && isLockWindow(e.sender)) &&
          !(e && tomatoFloat.isSelfSender && tomatoFloat.isSelfSender(e.sender))) throw new Error('app is locked')
      const c = readConfig()
      // W23 (P2, 2026-10-31): type-cleanse enableTomatoFloating at the IPC boundary. config.json is a
      // user-editable + cross-machine-transported blob (LAN restore / manual copy); a beta.15 residue
      // or a flipped value can land here as a non-boolean (string "0", null, ...), and the renderer
      // auto-show gate tests `=== false` — only a REAL boolean false legitimately disables the float.
      // Anything else is dropped in favor of the schema default (true) instead of feeding the gate
      // a value that neither enables nor (visibly) disables it — the silent "小窗没弹出来" class.
      if ('enableTomatoFloating' in c && typeof c.enableTomatoFloating !== 'boolean') {
        log.warn('[settings] config.json enableTomatoFloating is not boolean (' + typeof c.enableTomatoFloating + ':' + JSON.stringify(c.enableTomatoFloating) + ') — dropping it, schema default (true) applies')
        c.enableTomatoFloating = true
      }
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
      // D13 C3 (2026-10-01): validate BEFORE persisting. Any string used to be written to
      // config.json verbatim; on the next launch i18n only recognized exact 'en-US', so an
      // unvalidated/junk value silently flipped the app back to the system default. Reject
      // unsupported values at the IPC boundary and persist only the normalized locale.
      const norm = i18nM.normalizeLocale(locale)
      if (!norm) throw new Error('unsupported locale: ' + String(locale))
      const main = getMainWindow()
      i18nM.setLocale(norm)
      const c = writeConfig({ appLocale: norm })
      // C12 (P3 2026-10-02): under the config read-failed write gate, writeConfig returns null —
      // the old code returned `sanitizeConfigOut(null)` = null, so the renderer saw a null body
      // while the locale HAD been applied in memory (silent divergence between live state and
      // disk). Surface the degradation as a structured error: the in-memory apply above stands,
      // but the IPC rejects with an explicit code so no caller can mistake it for a success
      // shape. Renderer callers (renderer/js/i18n/index.js setLocale, store/settings.js hot-apply)
      // currently swallow rejections — they must branch on `code === 'CONFIG_READ_FAILED'`;
      // coordinated via commit note (those files are owned by another fixer domain).
      if (c == null) {
        const err = new Error('set-app-locale: config is unreadable (read-failed gate) — locale applied in memory but NOT persisted')
        err.code = 'CONFIG_READ_FAILED'
        throw err
      }
      // D19-DOM1 (2026-10-02): rebuildTrayMenu was the only unguarded sibling here — a throw after
      // the locale write had already landed left the op half-applied (persisted locale, stale tray,
      // rejected IPC). Guard like setTitle/taskbar below: log-and-continue.
      try { rebuildTrayMenu() } catch (err) { log.warn('[IPC] rebuildTrayMenu failed after locale change:', err && err.message) }
      const tray = getTray(); if (tray) { try { tray.setToolTip(i18nM.mt('appName')) } catch (err) { /* empty */ } }
      // P2 2026-09-12: previously this looped EVERY live window and setTitle(appName), flattening
      // semantic titles (float window task title, lock window title). Auxiliary windows pick up the
      // new locale via their own per-second title pushes (tomato-float countdown, same pattern as the
      // taskbar setBaseTitle precedent); only the main window's title is the plain appName.
      try { if (!main.isDestroyed()) main.setTitle(i18nM.mt('appName')) } catch (err) { /* dying window */ }
      try { tomatoTaskbar.setBaseTitle(i18nM.mt('appName')) } catch (err) { /* taskbar module keeps its previous base */ }
      return sanitizeConfigOut(c)
    },
    'notify-settings-updated': (e, patch) => {
      // 写配置限主窗;浮窗白噪音选择是合法写入(浮窗内 settings/update 走此通道),放行浮窗自身(2026-09-05 终审 P1)
      if (!(tomatoFloat.isSelfSender(e.sender) || senderIsMain(e))) {
        log.warn('[IPC] 拒绝非主窗/浮窗写配置, sender:', e.sender.id)
        throw new Error('forbidden: main window or float only')
      }
      // Symmetric hardening of the write side with the read side: strip security keys and never send them down, and likewise never accept renderer writes for them
      // (a compromised auxiliary window could previously change the lock password / disable the lock via this channel — isLocked() reads config in real time, so the lock would fail on the next check cycle)
      // D6 P2 (2026-09-21): spread + explicit dangerous-key strip replaces Object.assign —
      // Object.assign SETS '__proto__', so a patch with an own '__proto__' key (JSON.parse from a
      // hostile renderer) polluted Object.prototype; spread defines it as inert data and the
      // explicit delete drops it. (writeConfig's mergeConfig now filters too — belt and braces.)
      // D7 (2026-09-22, main-ipc-1): the strip set is now PER-SENDER. The universal dangerous-key
      // strip below never covered enableSecurityLock (the main settings page legitimately toggles
      // it, so a blanket strip would break the feature) — but the float window has no legitimate
      // use for it, and a trapped float could send {enableSecurityLock:false} to silently kill the
      // lock (isLocked() reads config in real time; the password survives, the lock never engages
      // again). Same for shortcutKeySettings (re-registering global hotkeys) and the other
      // main-consumed keys. Main-window senders keep the full surface; float senders get the
      // forbidden set stripped (their white-noise choice still passes).
      const fromFloat = tomatoFloat.isSelfSender(e.sender)
      const clean = stripForbiddenSettingsKeys(patch, { float: !senderIsMain(e) })
      // note: an own '__proto__' key on the patch is left as inert data here (spread defined it
      // safely); writeConfig's mergeConfig filters it before any merge, and a direct
      // `delete clean.__proto__` is banned by eslint no-proto.
      const c = writeConfig(clean)
      // c-wave fix (2026-10-13): a float-window write is white-noise-only (the float's entire
      // legitimate write surface; everything main-consumed was stripped above). Re-applying the
      // whole shortcut set on every white-noise toggle re-registered every global hotkey — a
      // visible churn window where shortcuts were unregistered, plus avoidable main-process work
      // on each selection change. Main-window senders keep the re-apply; float senders skip it.
      if (fromFloat) {
        log.info('[IPC] 浮窗白噪音写入,跳过快捷键重注册')
      } else if (c && c.shortcutKeySettings) applyShortcuts(c.shortcutKeySettings)
      else log.warn('[IPC] writeConfig 返回缺少 shortcutKeySettings,跳过快捷键重注册')
      // Make launch-at-login actually take effect (aligned with the reference runWhenComputerStart)
      if ('runWhenComputerStart' in clean) {
        try { app.setLoginItemSettings({ openAtLogin: !!clean.runWhenComputerStart }) } catch (err) { log.warn(err) }
      }
      return sanitizeConfigOut(c)
    }
  }
}
