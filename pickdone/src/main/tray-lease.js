/* Tray cluster + tomato live-text lease (moved verbatim out of index.js 2026-10-30).
   Owns the module-level `tray` handle and the DISPLAY-ONLY tomatoLiveText lease: creation
   (createTray), the context menu (rebuildTrayMenu), the pomodoro tooltip composition
   (updateTomatoTray / clearTomatoLiveText) and teardown (destroyTray, used by the quit chain).
   All cross-cluster dependencies are injected explicitly — index.js passes showMainOrLock and
   quitFromTray (both still defined there, pinned by source-shape unit tests); no reverse
   require('./index'). The quit-confirm dialog itself stays in index.js. */
function createTrayCluster ({ Tray, Menu, log, i18n: i18nM, tomatoTaskbar, tomatoFloat, showMainOrLock, quitFromTray }) {
  const path = require('path')
  const fs = require('fs')
  let tray = null
  // Tray carries pomodoro state: the tooltip is composed solely by the main process (single writer; shows just the app name when text is empty)
  let tomatoLiveText = '' // non-empty = a focus/rest pomodoro is live (per-second push from the renderer; the main process's only running-state signal)
  function createTray () {
    const iconPath = path.join(__dirname, '../../assets/tray/tray.png')
    const usedPath = fs.existsSync(iconPath) ? iconPath : path.join(__dirname, '../../assets/icon.png')
    // headless Linux (xvfb/CI) throws inside new Tray; boot must survive — whenReady catch treats any throw as fatal
    try {
      tray = new Tray(usedPath)
    } catch (e) {
      log.warn('[Tray] unavailable on this desktop, continuing without tray:', e && e.message)
      return
    }
    tomatoTaskbar.attachTray(tray, usedPath) // during a pomodoro the tray is redrawn as a progress ring; restores the original icon when idle
    rebuildTrayMenu()
    tray.setToolTip(i18nM.mt('appName'))
    tray.on('click', () => { showMainOrLock() })
  }
  // D10 (2026-09-27): wired into windows.js's render-process-gone hook — a crashed renderer clears // its own lease immediately (TQ-1: the quit-confirm GATE reads the durable session row, not this // display-only lease, so no timestamp reader is needed).
  function clearTomatoLiveText () { tomatoLiveText = '' }
  function updateTomatoTray (text) {
    const t = String(text || '').trim()
    tomatoLiveText = t
    if (tray) { try { tray.setToolTip(i18nM.mt('appName') + (t ? ' · ' + t : '')) } catch (e) { /* empty */ } }
  }
  function rebuildTrayMenu () {
    if (!tray) return
    const tpl = []
    tpl.push({ label: tomatoFloat.isDocked() ? i18nM.mt('trayShowFloat') : i18nM.mt('trayDockFloat'),
      click: () => { tomatoFloat.isDocked() ? tomatoFloat.undock() : tomatoFloat.dock(); rebuildTrayMenu() } })
    tpl.push({ label: i18nM.mt('trayOpen'), click: () => { showMainOrLock() } })
    tpl.push({ type: 'separator' })
    tpl.push({ label: i18nM.mt('trayQuit'), click: () => { quitFromTray() } })
    tray.setContextMenu(Menu.buildFromTemplate(tpl))
  }
  function destroyTray () {
    // Destroy the tray icon first: the icon only disappears on Windows when the process exits, // while the quit path (renderer flush + scheduler persist + WAL close) can take seconds — without this, the icon lingers and reads as "quit is slow"
    if (tray) { try { tray.destroy() } catch (e) { /* empty */ } tray = null }
  }
  return {
    createTray, clearTomatoLiveText, updateTomatoTray, rebuildTrayMenu, destroyTray,
    getTray: () => tray,
    getTomatoLiveText: () => tomatoLiveText,
  }
}

module.exports = { createTrayCluster }
