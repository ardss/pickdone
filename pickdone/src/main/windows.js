/**
 * Main window lifecycle — extracted from index.js (pure relocation, no behavior change).
 * Exports a factory; index.js wires shared dependencies in via ctx (no reverse require of index.js).
 */
const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

function createWindowManager (ctx) {
  const {
    readConfig, writeConfig, i18n, log, windowRef, closeBehavior,
    tomatoTaskbar, updater, applyShortcuts, shortcuts, scheduler,
    isLocked, lockAppNow, showMainOrLock,
    isQuitting, getState, getTray
  } = ctx

  let win = null // main window

  const getMainWindow = () => (win && !win.isDestroyed() ? win : null)

  function createMainWindow () {
    const conf = readConfig()
    const bounds = conf.winBounds
    // minWidth=750(2026-09-03 用户定稿渐进折叠): 日期条视图切换行单行自然宽 614px,全折临界 732(实测 1120/1140 为
    // 侧栏250+抽屉236 全展开的临界;折叠态临界 732)。<1140 渲染端自动折抽屉、<920 折侧栏(DayRail/SideNav 各自
    // matchMedia,两级递进,加宽自动恢复),因此任何宽度下该行都单行。旧 winBounds 小于 750 须钳制。
    // Visual distinction for test instances (users confirmed "couldn't tell which is the real one"): isolated-environment instance = orange icon + [TEST] title + top-left badge
    const isTestEnv = !!process.env.TODO_USER_DATA_DIR
    win = new BrowserWindow({
      width: Math.max(750, (bounds && bounds.width) || 1000),
      height: (bounds && bounds.height) || 560,
      x: bounds && bounds.x, y: bounds && bounds.y,
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
      win.setTitle(i18n.mt('appName') + ' [TEST]')
      win.webContents.on('did-finish-load', () => {
        win.setTitle(i18n.mt('appName') + ' [TEST]')
        win.webContents.executeJavaScript(`{
          if (!document.getElementById('test-env-badge')) {
            const b = document.createElement('div')
            b.id = 'test-env-badge'
            b.textContent = 'TEST'
            b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#f2a63b;color:#fff;font:bold 11px/1 sans-serif;padding:4px 8px;border-radius:0 0 6px 0;pointer-events:none;letter-spacing:1px'
            document.body.appendChild(b)
          }
          document.title = ${JSON.stringify(i18n.mt('appName'))} + ' [TEST]'
        }`).catch(() => {})
      })
    }
    // Reject window.open child windows; only external-link protocols go to the system browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      // The blank print window (printList's window.open('', '_blank') followed by document.write injecting print content, no navigation) was once wrongly killed by the blanket deny
      if (!url || url === 'about:blank') return { action: 'allow' }
      if (/^https?:/i.test(url)) { shell.openExternal(url) }
      return { action: 'deny' }
    })
    // The allowed about:blank child had NO navigation guard (2026-09-11 P1): injected script could
    // navigate it anywhere (or chain another window.open). Clamp it: navigation denied, external http(s)
    // handed to the system browser, nested window.open denied outright.
    win.webContents.on('did-create-window', (child) => {
      child.webContents.on('will-navigate', (e2, u) => {
        e2.preventDefault()
        if (/^https?:/i.test(u)) { try { shell.openExternal(u) } catch { /* best-effort */ } }
      })
      try { child.webContents.setWindowOpenHandler(() => ({ action: 'deny' })) } catch { /* older Electron */ }
    })
    // Intercept navigation to non-app:// protocols; XSS cross-origin guard
    win.webContents.on('will-navigate', (e, url) => {
      if (!/^app:\/\/app\//i.test(url)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url) }
    })
    // 加载失败自愈(2026-09-10 P2,与浮窗 5 次重试同类):此前主窗 did-fail-load 只 log,加载失败后
    // 用户面对白屏/错误页永不恢复。对主框架、非 -3(ERR_ABORTED 良性中断)做 3 次退避 reload,
    // did-finish-load 成功即复位计数。
    let loadRetryCount = 0
    win.webContents.on('did-finish-load', () => { loadRetryCount = 0 })
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      log.error('[Window] 加载失败:', code, desc, url)
      if (!isMainFrame || code === -3 || isQuitting()) return
      // P2 2026-09-11: the startup lock (enableSecurityLock) used to hook ONLY did-finish-load — if the
      // load chain failed completely (retries exhausted), the app came up unlocked and silent. Prefer the
      // locked-white-screen over an unlocked app (layered with lockLoadFailedFallback, which only disables
      // the lock when even the lock window cannot open).
      if (loadRetryCount >= 3) {
        if (readConfig().enableSecurityLock && !isLocked()) {
          log.warn('[SecurityLock] 主窗加载彻底失败,按锁定态兜底')
          try { lockAppNow() } catch (e) { log.error('[SecurityLock] 兜底锁定失败', e) }
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
      setTimeout(() => {
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
    win.webContents.on('did-finish-load', () => { crashReloadCount = 0 })
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('[Crash] render-process-gone:', details && details.reason, 'exitCode=', details && details.exitCode)
      if (isQuitting()) return // a quit in progress kills renderers as a side effect; do not fight it
      const reason = details && details.reason
      if (!reason || reason === 'clean-exit') return
      if (crashReloadCount < 3) {
        crashReloadCount++
        log.warn('[Crash] 渲染进程崩溃,自动重载', crashReloadCount, '/3')
        setTimeout(() => { const w = getMainWindow(); if (w) { try { w.webContents.reload() } catch (e2) { log.warn('[Crash] reload failed', e2) } } }, 300)
      } else {
        log.error('[Crash] 重载超限,relaunch 应用')
        try { shortcuts.unregisterAll() } catch {}
        // Best-effort dedup-ledger persist so the relaunch doesn't re-fire reminders from the last 60s
        try { scheduler.flushFiredNow() } catch {}
        app.relaunch()
        app.exit(1)
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
      if (!getState().quitByUser && closeBehavior.isCloseToTray(readConfig())) {
        e.preventDefault(); win.hide()
        const cfg = readConfig()
        if (closeBehavior.shouldShowTrayNotice(cfg)) {
          // P2 2026-09-11: writeConfig in the close path used to run unguarded — a config write failure
          // (disk full/permissions) threw straight out of the close handler and killed the quit chain
          try { writeConfig({ closeTrayNotified: true }) } catch (err) { log.warn('[Window] closeTrayNotified 写入失败', err) }
          const tray = getTray()
          try { if (tray && process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title: i18n.mt('appName'), content: i18n.mt('closeTrayNotice') }) } catch (err) { /* balloon is best-effort */ }
        }
      } else {
        // Same guard as above: resize path already wraps writeConfig in try (debounced), close must not be able to break the quit chain either
        try { writeConfig({ winBounds: win.getBounds() }) } catch (err) { log.warn('[Window] winBounds 写入失败(close)', err) }
      }
    })
    let _resizeTimer = null
    win.on('resize', () => { // high-frequency synchronous writes while dragging cause jank; debounce 400ms (close/quit already save as backstop)
      clearTimeout(_resizeTimer)
      _resizeTimer = setTimeout(() => { try { writeConfig({ winBounds: win.getBounds() }) } catch {} }, 400)
    })
    // Clamp the window back onto a visible screen on restore/show (fixes the "disappeared" window after multi-monitor changes/power loss)
    const clampIntoView = () => {
      try {
        const { screen } = require('electron')
        const displays = screen.getAllDisplays()
        const b = win.getBounds()
        const cx = b.x + b.width / 2
        const cy = b.y + b.height / 2
        const onScreen = displays.some(d =>
          cx >= d.workArea.x && cx <= d.workArea.x + d.workArea.width &&
          cy >= d.workArea.y && cy <= d.workArea.y + d.workArea.height)
        if (!onScreen) {
          const wa = screen.getPrimaryDisplay().workArea
          const w = Math.min(b.width, wa.width - 40)
          const h = Math.min(b.height, wa.height - 40)
          win.setBounds({ x: wa.x + (wa.width - w) / 2, y: wa.y + (wa.height - h) / 3, width: w, height: h })
          log.info('[Window] 窗口位置越界，已钳制回主屏')
        }
      } catch (e) { /* ignore */ }
    }
    win.on('restore', clampIntoView)
    win.on('show', clampIntoView)
  }

  return { createMainWindow, getMainWindow }
}

module.exports = { createWindowManager }
