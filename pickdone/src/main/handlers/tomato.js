/** Pomodoro float/taskbar + quick-add + main-window control IPC handlers (pure relocation from index.js registerIpc). */
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const quickAdd = require('../quick-add')

module.exports = function tomatoHandlers (ctx) {
  const { getMainWindow, showMainOrLock, rebuildTrayMenu, updateTomatoTray } = ctx

  return {
    // --- Global quick-add mini window ---
    'quick-add-hide': () => quickAdd.hide(),

    // --- Pomodoro float window (aligned with the reference show/hide-tomato-floating IPCs) ---
    // --no-focus test instances never auto-show the float: it would cover the user's foreground work
    'show-tomato-float': () => { if (!process.argv.includes('--no-focus')) { tomatoFloat.show(); rebuildTrayMenu() } },
    'hide-tomato-float': () => tomatoFloat.hide(),
    'tomato-float-shown': () => tomatoFloat.isVisible(),
    'flush-tomato-float': () => tomatoFloat.flushNow(),
    'set-tomato-float-bounds': () => tomatoFloat.setBounds(),
    'start-tomato-float-drag': (e) => tomatoFloat.dragStart(e.sender),
    'stop-tomato-float-drag': () => tomatoFloat.dragStop(),
    'ensure-window-width': (e, w) => {
      const need = Math.max(900, Number(w) || 0)
      const win = getMainWindow()
      if (!win) return
      const b = win.getBounds()
      if (b.width >= need) return
      const { screen } = require('electron')
      const wa = screen.getDisplayMatching(b).workArea
      const width = Math.min(need, wa.width)
      const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width))
      win.setBounds({ x, y: b.y, width, height: b.height })
    },
    'set-tomato-float-panel': (e, open) => tomatoFloat.setPanelOpen(open),
    // Double-click the float card to summon the main window: accepts only the float's own sender; showMainOrLock already handles the lock-screen redirect and main-window recreation branches
    'show-main-from-float': (e) => { if (tomatoFloat.isSelfSender(e.sender)) showMainOrLock() },
    'undock-tomato-float': () => { tomatoFloat.undock(); rebuildTrayMenu() },
    // Pomodoro state pushed every second → carried by the taskbar five-piece set + tray tooltip together (single tooltip writer)
    'update-tomato-taskbar': (e, p) => {
      if (!p || typeof p !== 'object') return
      tomatoTaskbar.update(p)
      const status = p.status || 'default'
      const running = status === 'startTomatoTime' || status === 'startRestTime' || p.paused
      if (!running) { updateTomatoTray(''); return }
      const mm = String(Math.floor((p.remainSec || 0) / 60)).padStart(2, '0')
      const ss = String((p.remainSec || 0) % 60).padStart(2, '0')
      updateTomatoTray(`${p.phaseText || ''} ${mm}:${ss}`)
    },

    // --- Window controls (win may be destroyed: null-guarded via getMainWindow, avoiding throws after destruction) ---
    'minimize-main-window': () => { const w = getMainWindow(); if (w) w.minimize(); return true },
    'maximize-main-window': () => { const w = getMainWindow(); if (!w) return false; w.isMaximized() ? w.unmaximize() : w.maximize(); return true },
    'is-maximized': () => { const w = getMainWindow(); return w ? w.isMaximized() : false },
    'hide-main-window': () => { const w = getMainWindow(); if (w) w.hide(); return true },
    'close-main-window-request': () => { const w = getMainWindow(); if (w) w.close(); return true }
  }
}
