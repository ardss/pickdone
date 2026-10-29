/**
 * Main window lifecycle — extracted from index.js (pure relocation, no behavior change).
 * Exports a factory; index.js wires shared dependencies in via ctx (no reverse require of index.js).
 */
const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { crashRelaunchDecision, CRASH_RELAUNCH_CAP, openExternalSafely } = require('./handlers/shared')

/* ---- D10 (2026-09-27): persisted renderer-crash relaunch counter ----
 * crashReloadCount is in-memory and resets on did-finish-load AND on every app.relaunch(), so a
 * deterministic startup crash looped crash→3 reloads→relaunch forever. A marker file in userData
 * persists consecutive RELAUNCHES; the health window (60s alive after did-finish-load) clears it.
 * Past CRASH_RELAUNCH_CAP the app gives up with a fatal-error dialog instead. */
const CRASH_MARKER_FILE = 'renderer-crash-relaunch-count.json'
const CRASH_HEALTH_WINDOW_MS = 60_000
function crashMarkerPath () { return path.join(app.getPath('userData'), CRASH_MARKER_FILE) }
function readCrashRelaunchCount () {
  try { return Number(JSON.parse(fs.readFileSync(crashMarkerPath(), 'utf8')).count) || 0 } catch { return 0 }
}
function writeCrashRelaunchCount (n) {
  // D22 (P3): bare writeFileSync could tear under a crash/power cut (half a JSON blob → the read
  // side silently resets the counter to 0 and a deterministic crash loop can restart its relaunch
  // budget). durable-fs writeFileDurable (tmp → fsync → rename, same convention as config-store.js)
  // makes the marker atomic.
  try { require('./durable-fs').writeFileDurable(crashMarkerPath(), JSON.stringify({ count: n, at: Date.now() }), fs) } catch { /* best-effort: a failed persist degrades to the old in-memory-only behavior */ }
}

/** [F4 #4 2026-10-21] Pure visibility test: a window counts as on-screen when its CENTER or ANY
 *  CORNER lies inside some display's workArea. The old center-only test let a half-off-screen
 *  window (common after a monitor is unplugged) pass as "visible" and never clamp back. Pure so
 *  it is unit-testable without Electron; windows.js keeps only the Electron glue. */
function windowBoundsVisible (b, displays) {
  if (!b || !Array.isArray(displays) || !displays.length) return false
  const pts = [
    [b.x + b.width / 2, b.y + b.height / 2],
    [b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]
  ]
  return pts.some(([x, y]) => displays.some(d => {
    const wa = d && d.workArea
    return !!wa && x >= wa.x && x <= wa.x + wa.width && y >= wa.y && y <= wa.y + wa.height
  }))
}

/** [W19 2026-10-30] Pure restore-bounds sanitizer. The old restore path only floored `width` at
 *  750 and left `height` to a falsy-default (a NEGATIVE persisted height passed straight into
 *  BrowserWindow) while x/y flowed through untouched — a corrupted/hand-edited winBounds entry
 *  produced an invisible (negative-sized) or degenerate window. Validate ALL FOUR fields with
 *  Number.isFinite + sane ranges (width ≥ 750 matching minWidth, height ≥ 200; x/y just finite —
 *  off-screen values are the existing clampIntoView's job). Any violation discards the WHOLE
 *  bounds object (null → caller falls back to defaults) rather than half-trusting a corrupt blob. */
const MIN_RESTORE_WIDTH = 750
const MIN_RESTORE_HEIGHT = 200
function sanitizeRestoreBounds (b) {
  if (!b || typeof b !== 'object') return null
  const { x, y, width, height } = b
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width < MIN_RESTORE_WIDTH || height < MIN_RESTORE_HEIGHT) return null
  return { x, y, width, height }
}

function createWindowManager (ctx) {  const {
    readConfig, writeConfig, i18n, log, windowRef, closeBehavior,
    tomatoTaskbar, updater, applyShortcuts, shortcuts, scheduler,
    isLocked, lockAppNow, showMainOrLock,
  isQuitting, getState, getTray,
  /** F1 (2026-10-22): index.js's guarded user-quit chain (quitFromTray) — exit-mode X routes here */
  requestUserQuit,
  /** D10 (2026-09-27): index.js hook — clears the tomato countdown lease when the renderer dies. */
  onRendererGone
} = ctx

  let win = null // main window

  const getMainWindow = () => (win && !win.isDestroyed() ? win : null)

  // [F4 #5 2026-10-21] Bounds-state snapshot for persistence. A maximized window's getBounds()
  // returns the full-screen rect — persisting that made the next launch open a giant
  // non-maximized window covering the whole monitor, and the maximized state itself was lost.
  // Keep the NORMAL (non-maximized) bounds + an explicit winIsMaximized flag instead.
  function persistBoundsState (w) {
    try {
      if (!w || w.isDestroyed()) return
      const maximized = !!w.isMaximized()
      const bounds = (maximized && typeof w.getNormalBounds === 'function') ? w.getNormalBounds() : w.getBounds()
      writeConfig({ winBounds: bounds, winIsMaximized: maximized })
    } catch (err) { log.warn('[Window] winBounds 写入失败', err) }
  }

  function createMainWindow () {
    const conf = readConfig()
    const bounds = conf.winBounds
    // minWidth=750(2026-09-03 用户定稿渐进折叠): 日期条视图切换行单行自然宽 614px,全折临界 732(实测 1120/1140 为
    // 侧栏250+抽屉236 全展开的临界;折叠态临界 732)。<1140 渲染端自动折抽屉、<920 折侧栏(DayRail/SideNav 各自
    // matchMedia,两级递进,加宽自动恢复),因此任何宽度下该行都单行。旧 winBounds 小于 750 须钳制。
    // Visual distinction for test instances (users confirmed "couldn't tell which is the real one"): isolated-environment instance = orange icon + [TEST] title + top-left badge
    const isTestEnv = !!process.env.TODO_USER_DATA_DIR
    // W19: full sanitizeRestoreBounds validation (all four fields finite + min sizes); an invalid
    // persisted entry falls back to the defaults instead of producing a negative-height or
    // degenerate window. x/y remain trusted once finite — off-screen restore is clamped by the
    // existing clampIntoView pass.
    const restore = sanitizeRestoreBounds(bounds) || { width: 1000, height: 560 }
    win = new BrowserWindow({
      width: restore.width,
      height: restore.height,
      x: restore.x, y: restore.y,
      minWidth: 750,
      minHeight: 520,
      frame: false,                     // the project baseline runs frameless (Win11 auto rounded corners)
      show: false,
      title: i18n.mt('appName'),       // taskbar/alt-tab label follows the configured language (index.html <title> is the zh fallback only)
      icon: path.join(__dirname, '../../assets/' + (isTestEnv ? 'icon-test.png' : 'icon.png')),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    windowRef.setMainWindow(win)
    // [F4 #5]: restore the persisted maximized state (winBounds now always stores the NORMAL
    // bounds — see persistBoundsState — so maximizing on top of them is safe).
    if (conf.winIsMaximized) { try { win.maximize() } catch (e) { log.warn('[Window] maximize restore failed', e) } }
    // Re-inject the live window into modules that captured it at startup: the main window can be
    // destroyed and recreated (close-then-tray path via showMainOrLock), and stale refs would make
    // updater events / taskbar progress silently stop reaching the new window.
    try { tomatoTaskbar.init(win) } catch (e) { log.warn('[Taskbar] re-init failed', e) }
    try { updater.init(win) } catch (e) { log.warn('[Updater] re-init failed', e) }
    // 应用内快捷键(before-input-event)挂在主窗 webContents 上:主窗销毁重建后必须重放,
    // 否则 ctrl+n/ctrl+1… 静默失效直到下次改快捷键设置(2026-09-05 终审 P1,与 taskbar/updater 同类)
    try { applyShortcuts(readConfig().shortcutKeySettings) } catch (e) { log.warn('[Shortcuts] re-init failed', e) }
    win.loadURL('app://app/renderer-dist/index.html').catch(e => log.error('[Window] loadURL failed', e))
    if (isTestEnv) {
      // Multi-instance mode (PICKDONE_MULTI=1, src/main/multi-instance.js): append the userData
      // dir scope hash so the two instances of a dev-duo session are tellable apart at a glance.
      const multiSuffix = require('./multi-instance').titleSuffix(process.env, app.getPath('userData'))
      const testTitle = i18n.mt('appName') + ' [TEST]' + multiSuffix
      win.setTitle(testTitle)
      // D19-DOM1 (2026-10-02): the closure used to re-read the module-level `win` on every fire —
      // after a close-then-tray recreation the badge/title landed on (or queried) the NEW window
      // mid-load instead of the load that actually finished. Use the event's own sender, same fix
      // did-fail-load got with wcAtFail.
      win.webContents.on('did-finish-load', (e) => {
        const wc = (e && e.sender) || win.webContents
        try { wc.setTitle(testTitle) } catch { /* destroyed */ }
        wc.executeJavaScript(`{
          if (!document.getElementById('test-env-badge')) {
            const b = document.createElement('div')
            b.id = 'test-env-badge'
            b.textContent = 'TEST'
            b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#f2a63b;color:#fff;font:bold 11px/1 sans-serif;padding:4px 8px;border-radius:0 0 6px 0;pointer-events:none;letter-spacing:1px'
            document.body.appendChild(b)
          }
          document.title = ${JSON.stringify(i18n.mt('appName'))} + ${JSON.stringify(' [TEST]' + multiSuffix)}
        }`).catch(() => {})
      })
    }
    // Reject window.open child windows; only external-link protocols go to the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      // The blank print window (printList's window.open('', '_blank') followed by document.write injecting print content, no navigation) was once wrongly killed by the blanket deny
      if (!url || url === 'about:blank') return { action: 'allow' }
      if (/^https?:/i.test(url)) { openExternalSafely(shell, url, log) } // D11 12-windows: rejection-logged, never an unhandled rejection
      return { action: 'deny' }
    })
    // The allowed about:blank child had NO navigation guard (2026-09-11 P1): injected script could
    // navigate it anywhere (or chain another window.open). Clamp it: navigation denied, external http(s)
    // handed to the system browser, nested window.open denied outright.
    win.webContents.on('did-create-window', (child) => {
      child.webContents.on('will-navigate', (e2, u) => {
        e2.preventDefault()
        if (/^https?:/i.test(u)) { openExternalSafely(shell, u, log) } // D11 12-windows: the try/catch twin could not catch the async rejection
      })
      try { child.webContents.setWindowOpenHandler(() => ({ action: 'deny' })) } catch { /* older Electron */ }
    })
    // Intercept navigation to non-app:// protocols; XSS cross-origin guard
    win.webContents.on('will-navigate', (e, url) => {
      if (!/^app:\/\/app\//i.test(url)) { e.preventDefault(); if (/^https?:/i.test(url)) openExternalSafely(shell, url, log) }
    })
    // 加载失败自愈(2026-09-10 P2,与浮窗 5 次重试同类):此前主窗 did-fail-load 只 log,加载失败后
    // 用户面对白屏/错误页永不恢复。对主框架、非 -3(ERR_ABORTED 良性中断)做 3 次退避 reload,
    // did-finish-load 成功即复位计数。
    let loadRetryCount = 0
    // D21 (P3 2026-10-02): the backoff retry timer is tracked so the window 'closed' handler can
    // clear it — same lifecycle rule as _resizeTimer/crashHealthTimer below (a timer armed by a
    // window must die with that window, not leak across close-then-tray recreation).
    let loadRetryTimer = null
    win.webContents.on('did-finish-load', () => { loadRetryCount = 0 })
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      log.error('[Window] load failed:', code, desc, url)
      if (!isMainFrame || code === -3 || isQuitting()) return
      // P2 2026-09-11: the startup lock (enableSecurityLock) used to hook ONLY did-finish-load — if the
      // load chain failed completely (retries exhausted), the app came up unlocked and silent. Prefer the
      // locked-white-screen over an unlocked app (layered with lockLoadFailedFallback, which only disables
      // the lock when even the lock window cannot open).
      if (loadRetryCount >= 3) {
        if (readConfig().enableSecurityLock && !isLocked()) {
          log.warn('[SecurityLock] 主窗加载彻底失败,按锁定态兜底')
          try { lockAppNow() } catch (e) { log.error('[SecurityLock] fallback lock failed', e) }
        }
        return
      }
      loadRetryCount++
      const delay = 400 * loadRetryCount
      log.warn('[Window] 主框架加载失败,退避重试', loadRetryCount, 'in', delay, 'ms')
      // P2 2026-09-12: the deferred reload closed over the module-level `win` — by the time it fired,
      // the window may have been destroyed and recreated (X-close→tray→showMainOrLock). Reload then
      // hit the NEW window mid-load. Capture the exact webContents and verify it is still the live
      // one of the still-current window before reloading.
      const wcAtFail = win.webContents
      if (loadRetryTimer) clearTimeout(loadRetryTimer)
      loadRetryTimer = setTimeout(() => {
        loadRetryTimer = null
        try {
          if (win && !win.isDestroyed() && win.webContents === wcAtFail && !wcAtFail.isDestroyed()) {
            wcAtFail.loadURL('app://app/renderer-dist/index.html').catch(() => {})
          }
        } catch { /* gone */ }
      }, delay)
    })
    win.webContents.on('console-message', (_e, level, msg, line, src) => {
      if (level >= 2) log.warn('[Renderer]', msg, `(${path.basename(String(src))}:${line})`)
      else log.info('[Renderer]', msg)
    })
    // Renderer/child process crashes land in the log (electron-log is main-process-only; the crash scene must be preserved for post-mortem attribution)
    // + self-heal (2026-09-09): a non-clean renderer crash used to leave a dead/blank main window forever.
    // Reload up to 3 times (counter resets on each successful did-finish-load); beyond the cap, relaunch the app —
    // a relaunched instance is strictly better than a zombie window the user must kill by hand.
    let crashReloadCount = 0
    let crashHealthTimer = null
    // QC 2026-10-09 (D21 parity): the crash-reload timer below was the last untracked window
    // timer — track it so the 'closed' handler can clear it like _resizeTimer/crashHealthTimer/
    // loadRetryTimer (a timer armed by a window must die with that window).
    let crashReloadTimer = null
    win.webContents.on('did-finish-load', () => {
      crashReloadCount = 0
      // D10 (2026-09-27): health window — if the renderer stays alive 60s past a successful load,
      // the crash streak is over; clear the persisted relaunch counter.
      clearTimeout(crashHealthTimer)
      crashHealthTimer = setTimeout(() => { writeCrashRelaunchCount(0) }, CRASH_HEALTH_WINDOW_MS)
      if (crashHealthTimer.unref) crashHealthTimer.unref()
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('[Crash] render-process-gone:', details && details.reason, 'exitCode=', details && details.exitCode)
      try { if (typeof onRendererGone === 'function') onRendererGone() } catch { /* lease clearing is best-effort */ }
      if (isQuitting()) return // a quit in progress kills renderers as a side effect; do not fight it
      const reason = details && details.reason
      if (!reason || reason === 'clean-exit') return
      if (crashReloadCount < 3) {
        crashReloadCount++
        log.warn('[Crash] 渲染进程崩溃,自动重载', crashReloadCount, '/3')
        // Stale-window parity with did-fail-load (fix 2026-10-06): the timer used to resolve
        // getMainWindow() at FIRE time, so a window destroyed and recreated inside the 300ms
        // delay reloaded the WRONG (new) window mid-load. Capture the exact webContents and
        // reload only if it is still the live one of the still-current window.
        const wcAtCrash = win.webContents
        if (crashReloadTimer) clearTimeout(crashReloadTimer)
        crashReloadTimer = setTimeout(() => {
          crashReloadTimer = null
          try {
            if (win && !win.isDestroyed() && win.webContents === wcAtCrash && !wcAtCrash.isDestroyed()) {
              wcAtCrash.reload()
            }
          } catch (e2) { log.warn('[Crash] reload failed', e2) }
        }, 300)
      } else {
        // D10 (2026-09-27): gate the relaunch on the PERSISTED counter. The in-memory counter
        // resets on every relaunch, so the old code looped forever on a deterministic startup
        // crash; past the cap we give up with a fatal-error dialog instead.
        const relaunchCount = readCrashRelaunchCount()
        const action = crashRelaunchDecision(relaunchCount, { cap: CRASH_RELAUNCH_CAP })
        if (action === 'give-up') {
          log.error('[Crash] relaunch cap (' + CRASH_RELAUNCH_CAP + ') exhausted — giving up, showing fatal-error dialog')
          try {
            const { dialog } = require('electron')
            dialog.showErrorBox('[Crash] PickDone', 'The renderer process keeps crashing (' + CRASH_RELAUNCH_CAP + ' relaunches without a stable run). Please restart the app manually; if the problem persists, reinstall or report the log file from the data directory.')
          } catch { /* no dialog available */ }
          return
        }
        log.error('[Crash] reload limit hit, relaunching app (relaunch #' + (relaunchCount + 1) + ')')
        writeCrashRelaunchCount(relaunchCount + 1)
        try { shortcuts.unregisterAll() } catch {}
        // Best-effort dedup-ledger persist so the relaunch doesn't re-fire reminders from the last 60s
        try { scheduler.flushFiredNow() } catch {}
        app.relaunch()
        // P1 2026-09-19: app.exit(1) here bypassed before-quit/will-quit entirely — the quit-flush
        // chain (stopSyncForQuit + scheduler persist + dbm.close WAL checkpoint) never ran, leaving a
        // torn WAL for the relaunched instance to trip over. app.quit() runs the full flush chain
        // (will-quit preventDefault → renderer ack window → flushNow → re-issued quit), exactly like
        // the tray-quit path; the 3s hang fallback inside will-quit bounds it.
        app.quit()
      }
    })
    win.webContents.on('child-process-gone', (_e, details) => {
      log.error('[Crash] child-process-gone:', details && details.type, details && details.reason, 'exitCode=', details && details.exitCode)
    })

    win.once('ready-to-show', () => {
      const s = readConfig().hideMainWindowOnStartup
      if (!s || process.argv.includes('--dev')) showMainOrLock()
    })
    win.on('close', e => {
      // F1 (2026-10-22 window-chrome review): the intent is a named three-way decision
      // (close-behavior.closeIntent) instead of an inline boolean — exit mode (closeActionMinimize
      // =false) must QUIT (the promise written by onboarding step 4 / Settings→General), not
      // destroy the window while window-all-closed stays resident (the 0.1.0-era drift).
      const intent = closeBehavior.closeIntent({ quitByUser: getState().quitByUser, closeToTray: closeBehavior.isCloseToTray(readConfig()) })
      if (intent === 'hide') {
        e.preventDefault(); win.hide()
        const cfg = readConfig()
        if (closeBehavior.shouldShowTrayNotice(cfg)) {
          // P2 2026-09-11: writeConfig in the close path used to run unguarded — a config write failure
          // (disk full/permissions) threw straight out of the close handler and killed the quit chain
          try { writeConfig({ closeTrayNotified: true }) } catch (err) { log.warn('[Window] closeTrayNotified 写入失败', err) }
          const tray = getTray()
          try { if (tray && process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title: i18n.mt('appName'), content: i18n.mt('closeTrayNotice') }) } catch (err) { /* balloon is best-effort */ }
        }
      } else if (intent === 'quit') {
        // Exit mode: route X (and Alt+F4 — same 'close' event) through the tray's guarded quit
        // chain: running-focus confirm → bounds persist → tray destroy → app.quit() (full flush
        // window). preventDefault first: the window stays visible while the confirm is up; the
        // re-issued quit re-enters this handler with quitByUser=true ('close' intent above).
        // LIVE-VERIFIED (2026-10-22 e2e-exit-close): calling requestUserQuit() SYNCHRONOUSLY here
        // hung the quit — app.quit() issued inside a preventDefault'ed close handler collides with
        // the in-flight close in the same tick: before-quit fired but will-quit NEVER arrived
        // (quit aborted in the window-closing phase; the 3s hang fallback never armed because
        // flushNow was never reached). Deferring past the current tick lets the prevented close
        // fully settle first — then the quit chain closes the window cleanly.
        e.preventDefault()
        setImmediate(() => requestUserQuit())
      } else {
        // [F4 #5]: close saves the same normalized shape as the move/resize debouncer (normal
        // bounds + maximized flag), so quit-time persistence can no longer stamp a maximized
        // full-screen rect as the restore size. persistBoundsState carries its own try/catch.
        persistBoundsState(win)
      }
    })
    let _resizeTimer = null
    // [F4 #5]: MOVE also persists now — previously only resize/close/quit wrote winBounds, so a
    // window that was only dragged (no resize) came back at its old position after a kill/power
    // loss. Move and resize share ONE debounced persist (400ms; high-frequency synchronous writes
    // while dragging cause jank) and maximize/unmaximize route through the same timer too — the
    // maximize transition itself fires resize on most platforms, but do not rely on it.
    const scheduleBoundsPersist = () => {
      clearTimeout(_resizeTimer)
      // P2 2026-09-17: a timer firing after the window closed used to call getBounds on a destroyed
      // window (throw inside the timer) and the timer itself leaked across window re-creation
      _resizeTimer = setTimeout(() => {
        if (win.isDestroyed()) { _resizeTimer = null; return }
        persistBoundsState(win)
        _resizeTimer = null
      }, 400)
    }
    win.on('resize', scheduleBoundsPersist)
    win.on('move', scheduleBoundsPersist)
    win.on('maximize', scheduleBoundsPersist)
    win.on('unmaximize', scheduleBoundsPersist)
    // D20-C12: the crash-relaunch health timer must die with the window — an armed 60s
    // writeCrashRelaunchCount(0) surviving a close-then-tray recreation would clear the
    // persisted relaunch counter before the crash streak was actually confirmed stable.
    // D21: the did-fail-load backoff retry timer (loadRetryTimer) clears here too.
    // QC 2026-10-09: and the render-process-gone crash-reload timer (crashReloadTimer).
    win.on('closed', () => { clearTimeout(_resizeTimer); _resizeTimer = null; if (crashHealthTimer) { clearTimeout(crashHealthTimer); crashHealthTimer = null } if (loadRetryTimer) { clearTimeout(loadRetryTimer); loadRetryTimer = null } if (crashReloadTimer) { clearTimeout(crashReloadTimer); crashReloadTimer = null } })
    // Clamp the window back onto a visible screen on restore/show (fixes the "disappeared" window after multi-monitor changes/power loss)
    // [F4 #4]: the on-screen test is the pure windowBoundsVisible above — center OR any corner on
    // some workArea — so a half-off-screen window (monitor unplugged) clamps back too.
    const clampIntoView = () => {
      try {
        // W18 fix: a maximized window can report out-of-view bounds during display churn, but
        // setBounds on it un-maximizes / corrupts the maximized state (the OS snap is lost).
        // Skip the clamp entirely: a maximized window is always on-screen by construction, and
        // display-removed re-maximizes it to the new workArea on its own. Same liveness-first
        // style as the persisted-bounds branch above (:312), which also never touches a
        // maximized window's bounds.
        if (win.isMaximized && win.isMaximized()) return
        const { screen } = require('electron')
        const b = win.getBounds()
        if (windowBoundsVisible(b, screen.getAllDisplays())) return
        const wa = screen.getPrimaryDisplay().workArea
        const w = Math.min(b.width, wa.width - 40)
        const h = Math.min(b.height, wa.height - 40)
        win.setBounds({ x: wa.x + (wa.width - w) / 2, y: wa.y + (wa.height - h) / 3, width: w, height: h })
        log.info('[Window] window position out of bounds, clamped back to primary screen')
      } catch (e) { /* ignore */ }
    }
    win.on('restore', clampIntoView)
    win.on('show', clampIntoView)
    // W17: restore/show never fire while a VISIBLE window sits on a secondary monitor that is
    // then unplugged — the bounds become dead-zone coordinates and the window is unreachable
    // forever (same shape as the float window's W16 fix). Re-clamp on display topology changes;
    // listeners are window-scoped (with a destroyed-window liveness check) and removed on
    // 'closed' so close-then-tray recreation cannot leak or double-wire them.
    const _screen = (() => { try { return require('electron').screen } catch { return null } })()
    const _displayHandlers = []
    if (_screen) {
      const _clampIfLive = () => { try { if (win && !win.isDestroyed()) clampIntoView() } catch { /* gone */ } }
      for (const ev of ['display-removed', 'display-metrics-changed']) {
        _displayHandlers.push([ev, _clampIfLive])
        _screen.on(ev, _clampIfLive)
      }
    }
    win.on('closed', () => { if (_screen) for (const [ev, h] of _displayHandlers) { try { _screen.removeListener(ev, h) } catch { /* gone */ } } })
  }

  return { createMainWindow, getMainWindow,
    /** [F4 #5]: shared bounds persistence for the tray-quit path (index.js) — same normalized
     *  winBounds/winIsMaximized shape as the close path, so quit-time writes can't stamp a
     *  maximized full-screen rect as the restore size. */
    persistBoundsState }
}

module.exports = {
  createWindowManager,
  /** [F4 #4] pure geometry seam for unit tests (no Electron needed). */
  __windowGeom: { windowBoundsVisible, sanitizeRestoreBounds },
  // D10 test seam: crash-counter marker round-trip (plain-node tests stub electron's app.getPath)
  __crashCounter: { read: readCrashRelaunchCount, write: writeCrashRelaunchCount },
  CRASH_RELAUNCH_CAP, CRASH_HEALTH_WINDOW_MS,
}
