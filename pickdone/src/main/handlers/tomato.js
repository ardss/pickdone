/** Pomodoro float/taskbar + quick-add + main-window control IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const tomatoFloat = require('../tomato-float')
const tomatoTaskbar = require('../tomato-taskbar')
const quickAdd = require('../quick-add')
const { makeAssertMainWindow, makeSenderIsMain } = require('./shared')
const { formatMMSS } = require('../../../shared/format-mmss.cjs') // F-A6: single mm:ss source (floor + negative clamp)

module.exports = function tomatoHandlers (ctx) {
  const { getMainWindow, showMainOrLock, rebuildTrayMenu, updateTomatoTray, isLocked } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)
  // main-ipc wave (2026-09-25): the main-window control channels below had NO sender gate — any
  // renderer window (trapped float / injected page) could minimize/hide/close the main window,
  // hide/undock/flush/reposition the float. Gate: main window OR the channel's owning window
  // (float owns the float controls, quick-add owns its own hide). is-maximized /
  // tomato-float-shown stay open (read-only).
  // 2026-09-25 adversarial follow-up: ownership test converged on shared.makeSenderIsMain
  // (boolean twin of makeAssertMainWindow) instead of a local re-implementation.
  const senderIsMain = makeSenderIsMain(getMainWindow)
  const isFloatSelf = sender => {
    try { return !!require('../tomato-float').isSelfSender(sender) } catch { return false }
  }
  const isQuickAddSelf = sender => {
    try { const qa = require('../quick-add'); return !!(qa && typeof qa.isSelfSender === 'function' && qa.isSelfSender(sender)) } catch { return false }
  }
  // main window only, with a lock-state reuse (same class as backup.js's `if (isLocked()) throw`):
  // while the lock is active a non-main renderer must not be able to drive the main window's
  // visibility at all.
  const assertWindowControl = (e, label) => {
    if (!senderIsMain(e)) {
      log.warn('[IPC] 拒绝非主窗调用窗口控制通道, sender:', e && e.sender && e.sender.id)
      throw new Error('forbidden: main window only (' + label + ')')
    }
  }
  const assertFloatControl = (e, label) => {
    if (!senderIsMain(e) && !isFloatSelf(e && e.sender)) {
      log.warn('[IPC] 拒绝非主窗/非浮窗调用浮窗控制通道, sender:', e && e.sender && e.sender.id)
      throw new Error('forbidden: main window or tomato float only (' + label + ')')
    }
  }

  return {
    // --- Global quick-add mini window ---
    // Owning-window gate: only the main window or the quick-add window itself may hide it.
    'quick-add-hide': (e) => {
      if (!senderIsMain(e) && !isQuickAddSelf(e && e.sender)) {
        log.warn('[IPC] 拒绝非主窗/非快加窗调用 quick-add-hide, sender:', e && e.sender && e.sender.id)
        throw new Error('forbidden: main window or quick-add only')
      }
      return quickAdd.hide()
    },

    // --- Pomodoro float window (aligned with the reference show/hide-tomato-floating IPCs) ---
    // --no-focus test instances never auto-show the float: it would cover the user's foreground work
    // Adversarial-review fix (2026-09-25 ①): show/hide/set-bounds were the same class of ungated
    // side-effect as flush/undock (a trapped window could pop/hide/move the float) — same
    // main-window-or-float gate. Legit callers: SettingsModal/TomatoBar/TomatoPanel (main window)
    // and TomatoFloatPage (the float itself).
    'show-tomato-float': (e) => {
      assertFloatControl(e, 'show-tomato-float')
      if (!process.argv.includes('--no-focus')) { tomatoFloat.show(); rebuildTrayMenu() }
    },
    'hide-tomato-float': (e) => { assertFloatControl(e, 'hide-tomato-float'); return tomatoFloat.hide() },
    'tomato-float-shown': () => tomatoFloat.isVisible(),
    'flush-tomato-float': (e) => { assertFloatControl(e, 'flush-tomato-float'); return tomatoFloat.flushNow() },
    'set-tomato-float-bounds': (e) => { assertFloatControl(e, 'set-tomato-float-bounds'); return tomatoFloat.setBounds() },
    'start-tomato-float-drag': (e) => tomatoFloat.dragStart(e.sender),
    // Domain-1 F-A5 (2026-09-23): the sender is now forwarded on BOTH channels — dragStop/
    // setPanelOpen used to be callable from ANY window, so a trapped float could interrupt a
    // drag in progress (clearInterval dragTimer) or flip the panel/click-through state of a
    // float it doesn't own. Symmetric with dragStart's win.webContents check.
    'stop-tomato-float-drag': (e) => tomatoFloat.dragStop(e.sender),
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
    'set-tomato-float-panel': (e, open) => tomatoFloat.setPanelOpen(e.sender, open),
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
    'undock-tomato-float': (e) => { assertFloatControl(e, 'undock-tomato-float'); tomatoFloat.undock(); rebuildTrayMenu() },
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
      // F-A6 (2026-09-23): mm:ss via the shared formatter — the inline copy had no floor/
      // negative clamp, so a remainSec of -1 rendered "-1:-1" in the tray for a tick.
      updateTomatoTray(`${p.phaseText || ''} ${formatMMSS(p.remainSec)}`)
    },

    // --- Window controls (win may be destroyed: null-guarded via getMainWindow, avoiding throws after destruction) ---
    // main-ipc wave (2026-09-25): side-effecting controls are main-window only + locked-state gate
    // (isLocked, symmetric with backup.js write channels); 'is-maximized' stays open (read-only).
    'minimize-main-window': (e) => { assertWindowControl(e, 'minimize-main-window'); if (isLocked()) throw new Error('app is locked'); const w = getMainWindow(); if (w) w.minimize(); return true },
    'maximize-main-window': (e) => { assertWindowControl(e, 'maximize-main-window'); if (isLocked()) throw new Error('app is locked'); const w = getMainWindow(); if (!w) return false; w.isMaximized() ? w.unmaximize() : w.maximize(); return true },
    'is-maximized': () => { const w = getMainWindow(); return w ? w.isMaximized() : false },
    'hide-main-window': (e) => { assertWindowControl(e, 'hide-main-window'); if (isLocked()) throw new Error('app is locked'); const w = getMainWindow(); if (w) w.hide(); return true },
    'close-main-window-request': (e) => { assertWindowControl(e, 'close-main-window-request'); if (isLocked()) throw new Error('app is locked'); const w = getMainWindow(); if (w) w.close(); return true }
  }
}
