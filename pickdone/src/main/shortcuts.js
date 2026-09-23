/** Global + in-window shortcuts — moved from index.js with dependency injection */
const { globalShortcut, ipcMain } = require('electron')

/** P2 2026-09-19: normalize keyboard-event key names to the Accelerator vocabulary the saved
 *  config uses. The old `key === 'delete' ? 'delete' : key` ternary was a dead no-op that lost the
 *  intended mapping, so saved config variants ('del'/'ins'/'esc', as users and older builds wrote
 *  them) never matched the before-input-event combo. Class fix: any future variant only needs a row
 *  here, in one place. */
const KEY_ALIASES = { del: 'delete', ins: 'insert', esc: 'escape' }
function normalizeKey (key) {
  const k = String(key || '').toLowerCase()
  return KEY_ALIASES[k] || k
}

function createShortcuts ({ getMainWindow, showMainOrLock, quickAdd, i18n, log }) {
  // Register a single global shortcut: returns false when the key is taken. On failure, retry once after a delay (typical case: our own old instance
  // during restart or an isolated integration-test instance briefly holds the key and releases it on exit); only if that still fails show the conflict dialog.
  // Test-isolated instances (TODO_USER_DATA_DIR) never register — stealing the real instance's system hotkeys is pointless and guaranteed to clash.
  // Common conflicts come from resident software (WeChat/QQ screenshot = ctrl+shift+a etc.): a modal dialog would re-pop on every settings change — intrusive and unresolvable.
  // Changed to three silent backoff retries at 3s/12s/30s; only alert after final failure, at most once per combo per run, via a non-blocking renderer toast.
  const conflictWarned = new Set()
  const retryTimers = new Set()
  function registerGlobal (accel, onFire, keyLabel) {
    if (process.env.TODO_USER_DATA_DIR) return true
    const attempt = () => {
      try { return globalShortcut.register(accel, onFire) } catch { return false }
    }
    let ok = attempt()
    if (!ok) {
      const delays = [3000, 12000, 30000]
      delays.forEach((d, i) => {
        // 重试定时器入册:applyShortcuts 重绑时统一清理,否则旧组合的定时器会把已弃用的旧键重新注册回系统(2026-09-05 终审 P2)
        const t = setTimeout(() => {
          retryTimers.delete(t)
          if (ok) return
        ok = attempt()
        if (ok) { conflictWarned.delete(accel); return } // a retry won it back; release the one-time alert latch
          if (i === delays.length - 1 && !conflictWarned.has(accel)) {
            conflictWarned.add(accel)
            const win = getMainWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('shortcut-conflict', { msg: i18n.mt('shortcutConflict', { key: keyLabel }) })
            } else if (log) log.warn('[shortcut] conflict and main window unavailable, notification skipped: ' + keyLabel)
          }
        }, d)
        retryTimers.add(t)
      })
    }
    return ok
  }

  function applyShortcuts (s = {}) {
    // 丢弃上一轮挂着的退避重试:重绑后旧组合不得再抢注系统热键
    for (const t of retryTimers) clearTimeout(t)
    retryTimers.clear()
    globalShortcut.unregisterAll()
    // Global system-level shortcut (per project baseline only toggleMainWindow is global; the rest are in-window)
    if (s.toggleMainWindow) {
      registerGlobal(s.toggleMainWindow, () => {
        const win = getMainWindow()
        if (!win || win.isDestroyed()) return
        if (win.isVisible() && win.isFocused()) win.hide()
        else { showMainOrLock() }
      }, s.toggleMainWindow)
    }
    // Global quick add: summon the mini input bar from anywhere (quick-add.js)
    if (s.quickAddGlobal) {
      registerGlobal(s.quickAddGlobal, () => quickAdd.toggle(), s.quickAddGlobal)
    }
    // In-window action shortcuts → broadcast to the renderer for dispatch
    const inApp = {
      addEvent: 'todo:shortcut-add-event',
      deleteEvent: 'todo:shortcut-delete-event',
      pinEvent: 'todo:shortcut-pin',
      unpinEvent: 'todo:shortcut-unpin',
      toggleAllSubtasks: 'todo:shortcut-toggle-subtasks',
      startPomodoro: 'todo:shortcut-start-pomodoro',
      switchToDaytodo: 'todo:shortcut-nav-today',
      switchToRecentTodos: 'todo:shortcut-nav-recent',
      switchToSchedule: 'todo:shortcut-nav-calendar',
      switchToInbox: 'todo:shortcut-nav-inbox',
      // F-D1 (maint/dw 2026-09-23): sync was exposed as a rebindable entry in the settings
      // shortcuts tab and occupied ctrl+s in conflict detection, but this table (the ONLY
      // before-input-event dispatcher) had no row — the combo never dispatched; the real Ctrl+S
      // was a hardcoded renderer keydown branch. Wired here; the renderer consumes 'sync' in
      // onShortcutAction with the same syncTodos feedback shape.
      sync: 'todo:shortcut-sync'
    }
    // F-D3 (maint/dw 2026-09-23): while the settings tab is RECORDING a new combo, the main
    // process must stand down: before-input-event fires before the renderer's capture-phase
    // listener, so a recorded combo that is already bound used to be preventDefault'ed (the
    // recorder never saw the key — impossible to re-record) AND still dispatched its action
    // (recording ctrl+d really deleted the selected task). The renderer toggles this flag over
    // IPC on capture start/stop; suppressed events fall through untouched.
    let captureSuppress = false
    ipcMain.on('shortcut-capturing', (e, flag) => { captureSuppress = !!flag })
    // The main window may already be destroyed (settings re-bind triggered via notify-settings-updated during exit): guard with a getMainWindow null check
    const cur = getMainWindow()
    cur && cur.webContents.removeAllListeners('before-input-event')
    // F-D3 self-heal: if the renderer dies / reloads mid-record (crash, dev reload) the
    // suppression flag would otherwise stay raised forever and silently disable every in-app
    // shortcut until the next record or app restart. Any fresh load starts from a clean slate.
    cur && cur.webContents.on('did-finish-load', () => { captureSuppress = false })
    cur && cur.webContents.on('before-input-event', (e, input) => {
      const w = getMainWindow()
      if (input.type !== 'keyboard' || !w || w.isDestroyed()) return
      const parts = []
      if (input.control) parts.push('ctrl')
      if (input.alt) parts.push('alt')
      if (input.shift) parts.push('shift')
      const key = normalizeKey(input.key)
      if (!key) return
      // F-D3: recording in progress — let the combo reach the renderer's capture listener
      // untouched (no preventDefault, no action dispatch, no side effects mid-record)
      if (captureSuppress) return
      parts.push(key)
      const combo = parts.join('+')
      for (const [action] of Object.entries(inApp)) {
        const accNorm = String((s[action] || '')).toLowerCase()
        if (accNorm && accNorm === combo) {
          e.preventDefault()
          w.webContents.send('shortcut-action', action)
          return
        }
      }
    })
  }

  return { applyShortcuts, unregisterAll: () => globalShortcut.unregisterAll() }
}

module.exports = { createShortcuts, normalizeKey, KEY_ALIASES }
