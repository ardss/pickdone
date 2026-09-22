/** Pomodoro float/taskbar + quick-add + main-window control IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const quickAdd = require('../quick-add')
const { makeAssertMainWindow } = require('./shared')

module.exports = function tomatoHandlers (ctx) {
  const { getMainWindow, showMainOrLock, rebuildTrayMenu, updateTomatoTray, isLocked } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)

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
    // D6-F9: counterpart of ensure-window-width — the edit-panel auto-widen used to be one-way.
    // Shrinks back to the remembered pre-open width (never below min, never while maximized).
    'restore-window-width': (e, w) => {
      const want = Math.max(900, Number(w) || 0)
      const win = getMainWindow()
      if (!win || win.isMaximized() || win.isFullScreen()) return
      const b = win.getBounds()
      if (b.width <= want) return
      const { screen } = require('electron')
      const wa = screen.getDisplayMatching(b).workArea
      const width = Math.min(b.width, Math.max(want, 900))
      const x = Math.max(wa.x, Math.min(b.x + (b.width - width), wa.x + wa.width - width))
      win.setBounds({ x, y: b.y, width, height: b.height })
    },
    'set-tomato-float-panel': (e, open) => tomatoFloat.setPanelOpen(open),
    // --- Running-tomato cross-device announcements (feature: live remote focus chip) ---
    // Renderer (main + float windows) reports local focus transitions; main composes the
    // device identity and writes the meta announce row (synced via the meta entity).
    // D6 P2 (2026-09-22): the write used to be callable from ANY sender — an arbitrary window
    // (or injected page) could forge a SYNCED meta announce row and plant cross-device focus
    // chips on every peer. Gated: main window or the float's own webContents only.
    'tomato-run-announce': (e, payload) => {
      // P3 (R4 2026-09-21): locked-state gate, symmetric with upload-attachment/open-file —
      // the announce write is a SYNCED meta write and must not land while the lock is active.
      if (isLocked()) throw new Error('locked')
      const w = getMainWindow()
      const isMain = w && !w.isDestroyed() && e.sender === w.webContents
      if (!isMain && !tomatoFloat.isSelfSender(e.sender)) {
        log.warn('[IPC] 拒绝非主窗/非浮窗调用 tomato-run-announce, sender:', e.sender.id)
        throw new Error('forbidden: main window or tomato float only')
      }
      return require('../tomato-announce').announceFromRenderer(payload || {})
    },
    // Startup/current snapshot of all peers' announces (renderer filters staleness itself)
    // P3 (R4 2026-09-21): locked-state read gate, symmetric with the announce write above —
    // the lock screen must not expose cross-device focus activity (which tasks, how long).
    'tomato-run-announces': () => {
      if (isLocked()) throw new Error('locked')
      return require('../tomato-announce').listAnnounces()
    },
    // Double-click the float card to summon the main window: accepts only the float's own sender; showMainOrLock already handles the lock-screen redirect and main-window recreation branches
    'show-main-from-float': (e) => { if (tomatoFloat.isSelfSender(e.sender)) showMainOrLock() },
    'undock-tomato-float': () => { tomatoFloat.undock(); rebuildTrayMenu() },
    // Pomodoro state pushed every second → carried by the taskbar five-piece set + tray tooltip together (single tooltip writer)
    // D6 P2 (2026-09-22): main-window gate — any window could previously spoof the tray tooltip /
    // taskbar five-piece state (a fake countdown, a fake running indicator) every second.
    'update-tomato-taskbar': (e, p) => {
      assertMainWindow(e)
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
