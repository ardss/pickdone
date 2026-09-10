/**
 * Main process entry — PickDone offline implementation
 * IPC channel names stay aligned with the project baseline, easing a later swap to a real cloud backend
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, shell, Notification } = require('electron')
// globalShortcut is required by quick-add/pomodoro-float and other modules (avoid duplicates)
const path = require('path')
// The renderer has no nodeIntegration; pass the real version to preload via env var (todoAPI.version)
process.env.APP_VERSION = app.getVersion()
const autoBackup = require('./autoBackup')
const { resolveBackupDir, defaultBackupRoot, saveAllowedBackupDirs, allowedBackupDirs, loadAllowedBackupDirs } = require('./backup-dirs')
const fs = require('fs')
const log = require('electron-log')

const dbm = require('./db')
const fixUtil = require('./fix-util')
const { handleAppProtocol } = require('./protocol')
// The .cjs extension must be spelled out: require's resolution algorithm does not include .cjs (once threw Cannot find module at startup)
const dbRecovery = require('./dbRecovery.cjs')
const scheduler = require('./scheduler')
const i18nM = require('./i18n')
const closeBehavior = require('./close-behavior')
const tomatoFloat = require('./tomato-float')
const tomatoTaskbar = require('./tomato-taskbar')
const quickAdd = require('./quick-add')
const updater = require('./updater')
const appAudit = require('./audit')

app.setName('pickdone') // standalone userData directory, does not affect the project baseline
// Windows toast notifications resolve the app name/icon via the AppUserModelID; without this they show "electron.app".
// Must match package.json build.appId — the electron-builder Start Menu shortcut carries the same AUMID.
app.setAppUserModelId('com.pickdone.app')

// EPIPE tolerance: in dev, when the parent shell exits it takes the inherited stdout/stderr pipes with it; after that, any write from console.log /
// electron-log's console transport raises an uncaught EPIPE exception → the main process pops an error dialog (verified P0 on 2026-08-30).
// Node's default behavior for failed pipe writes is to throw; swallow it here: failing to write logs must not drag down the whole app.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {})
}
process.on('uncaughtException', (e) => {
  // Fully tolerate pipe/stream-destroyed errors (a broken log stream does not affect functionality); rethrow everything else through the default dialog without masking real bugs
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' || e.code === 'ERR_STREAM_WRITE_AFTER_END')) return
  throw e
})
// Promise 侧兜底:只记日志不退出(与 uncaughtException 的 rethrow 不同——rejection 多为单点 IO 失败,
// 静默吞掉比整窗崩溃更符合本地优先应用的可用性;但必须留痕,否则不可诊断)(2026-09-05 终审 P2)
process.on('unhandledRejection', (reason) => {
  try { log.warn('[unhandledRejection]', reason && (reason.stack || reason.message || reason)) } catch {}
})

// Disable HTTP disk cache for renderer ESM modules (app:// already sends no-cache but Chromium still caches,
// which once made revised JS ineffective — the root cause of both blank-screen and stale-logic incidents); reading local resources directly has no performance cost
app.commandLine.appendSwitch('disable-http-cache')
// Test isolation: TODO_USER_DATA_DIR gives test instances a separate data directory coexisting with the dev instance (SQLite WAL multi-process safety is backstopped by external-write detection)
if (process.env.TODO_USER_DATA_DIR) app.setPath('userData', process.env.TODO_USER_DATA_DIR)
// Hardware acceleration switch (aligned with the reference enableHardwareAcceleration; must be called before ready)
try {
  const c = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
  if (c.enableHardwareAcceleration === false) app.disableHardwareAcceleration()
} catch (e) { /* no config on first launch */ }

let win = null // main window
let tray = null
let quitByUser = false

const { readConfig, writeConfig } = require('./config-store')

function getMainWindow () { return win && !win.isDestroyed() ? win : null }

// Submodules like scheduler/notify-sound get the main window via window-ref, avoiding a reverse require('./index') dependency
const windowRef = require('./window-ref')

function showMainOrLock () {
  // --no-focus: e2e/smoke instances never steal focus or cover the user's screen —
  // parked on the secondary display (or off-screen when none) via window-ref.parkForTest
  const inactive = process.argv.includes('--no-focus')
  if (isLocked()) { securityLock.focusLock(); return }
  const w = getMainWindow()
  if (w) {
    if (inactive) { windowRef.parkForTest(w, { screen: require('electron').screen }); return }
    w.show(); w.focus(); return
  }
  // Main window destroyed (clicking X when closeActionMinimize=false): recreate rather than lose it forever (tray/second-instance both go through here)
  createMainWindow()
}

const { createSecurityLock } = require('./security-lock')
const { createShortcuts } = require('./shortcuts')
const { createExporter } = require('./export-xlsx')
const securityLock = createSecurityLock({ getMainWindow, showMainOrLock, readConfig, writeConfig, i18n: i18nM, log })
const { isLocked, lockAppNow, unlockAppNow, verifyLockPassword, isLockWindow } = securityLock
quickAdd.setLockProbe(isLocked) // the global quick-add shortcut does not summon while the screen is locked (summoning = input silently lost)
const shortcuts = createShortcuts({ getMainWindow, showMainOrLock, quickAdd, i18n: i18nM, log })
const { applyShortcuts } = shortcuts
const { exportTodosToXlsx } = createExporter({ getMainWindow, i18n: i18nM, log })
/* ---------------- Broadcast DB changes to all windows (reference: todos-changed) ---------------- */
function broadcastTomatoRecordsChanged (reason, excludeWebContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue
      if (excludeWebContents && w.webContents === excludeWebContents) continue
      w.webContents.send('tomato-records-changed', { reason, at: Date.now() })
    } catch {}
  }
}
function broadcastTodosChanged (reason, excludeWebContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue
      if (excludeWebContents && w.webContents === excludeWebContents) continue
      w.webContents.send('todos-changed', { reason, at: Date.now() })
    } catch {}
  }
}

/* ---------------- Tiered recovery from DB corruption (P0 data-loss prevention) — implementation extracted to dbRecovery.cjs (independently testable) ---------------- */
function attemptDbRecovery (ud) { return dbRecovery.attemptDbRecovery(ud) }
function restoreTasksFromCriticalBackup (ud) { return dbRecovery.restoreTasksFromCriticalBackup(ud, list => dbm.call('upsertMany', list), c => dbm.call('upsertCategory', c), rows => dbm.call('tomatoAppendMany', rows)) }

/* ---------------- External-write listener: when the CLI writes the DB directly, the running App refreshes automatically ---------------- */
function watchDbForExternalWrites () {
  const ud = app.getPath('userData')
  const dbFile = path.join(ud, 'todos.db')
  const walFile = dbFile + '-wal'
  // In WAL mode CLI writes only land in -wal and the main DB's mtime stays unchanged (once broke the 2s broadcast, leaving stale UI data); watch both files
  // Stat the baseline once first: starting lastMtime at 0 would make the first poll always kick, falsely reporting an "external write" right at startup
  let lastMtime = 0
  try { lastMtime = Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0) } catch {}
  let lastTomatoCmdRaw = null
  let lastTomatoSeq = 0
  // CLI settings hot-sync baseline: the first poll only builds the baseline and does not push (otherwise startup would push a full diff by mistake)
  let lastSettingsSavedAt = 0
  let lastSettingsDoc = null
  try {
    const rawS = dbm.call('getMeta', 'db.settingsState')
    if (rawS) { const d = JSON.parse(rawS); lastSettingsSavedAt = (d && d._savedAt) || 0; lastSettingsDoc = d }
  } catch {}
  let debounce = null
  /* Tomato command forwarding: independent of mtime — fs.watchFile polling occasionally drops events, which
     once let a stop command be silently skipped (meta is a single slot; once an old command is overwritten by a
     new one it is lost forever), so every poll reads meta directly once (pure read). */
  const forwardTomatoCmd = () => {
    try {
      const raw = dbm.call('getMeta', 'cliTomatoCmd')
      // 守卫只包转发段,不得 return 整函数——函数后半段还承担 CLI 设置热同步(2026-09-04 二轮深审 P0:提前 return 曾短路设置推送)。
      // 锁屏态不转发也不标记已消费:锁定时 todo-db:call 全拒,转发了会'半执行'(计时启动但回执被拒),解锁后 onChange 自然补发。
      const winOk = win && !win.isDestroyed()
      if (raw && raw !== lastTomatoCmdRaw && winOk && !isLocked()) {
        const cmd = JSON.parse(raw)
        lastTomatoCmdRaw = raw
        if (cmd && cmd.seq && cmd.seq > lastTomatoSeq) {
          lastTomatoSeq = cmd.seq
          // 账本类命令已退役为 CLI 直写行表(渲染端经 tomato-records-changed 回灌),本通道只剩状态类 start/stop/attach,只发主窗
          win.webContents.send('cli-tomato-cmd', cmd)
          log.info('[CLI] 番茄命令已转发渲染端:', cmd.action, 'seq=' + cmd.seq)
        }
      }
    } catch (e) { log.warn('[CLI] 番茄命令转发失败', e) }
    // CLI settings set: mirror changes to db.settingsState's _savedAt → diff and push to the renderer for hot application
    // (renderer dispatches settings/update → IPC notify-settings-updated → main-process config.json/shortcuts/login item sync accordingly)
    try {
      const rawS = dbm.call('getMeta', 'db.settingsState')
      if (rawS) {
        const doc = JSON.parse(rawS)
        const at = (doc && doc._savedAt) || 0
        if (at > lastSettingsSavedAt) {
          const prev = lastSettingsDoc
          lastSettingsSavedAt = at
          lastSettingsDoc = doc
          if (prev && win && !win.isDestroyed()) {
            const patch = {}
            for (const k of Object.keys(doc)) {
              if (k === '_savedAt' || k === 'schemaV') continue
              if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) patch[k] = doc[k]
            }
            if (Object.keys(patch).length) {
              delete patch.securityLockPassword
              delete patch.securityLockQuestion
              win.webContents.send('external-settings-changed', patch)
              log.info('[CLI] 设置变更热同步:', Object.keys(patch).join(','))
            }
          }
        }
      }
    } catch (e) { log.warn('[CLI] 设置热同步失败', e) }
  }
  const kick = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        scheduler.reloadAll(dbApi())
        broadcastTodosChanged('external-db-write')
        // CLI 直写账本行(独立进程,db 层钩子在 CLI 进程内不挂)——外部写轮询是唯一跨进程通知点,
        // 必须同时广播账本重载,否则 CLI backfill/record rm 后界面账本保持旧副本(2026-09-04 实锤)
        broadcastTomatoRecordsChanged('external-db-write')
        // CLI pomodoro command channel: the CLI writes meta cliTomatoCmd → forwarded to the main window's renderer, which dispatches the existing
        // store/tomato actions (idempotency token/cross-window claim/ledger/project estimate all reused; the CLI never writes state in parallel)
        forwardTomatoCmd()
        log.info('[TodoDB] 检测到外部写入（CLI），已刷新调度器并通知渲染端')
        // Resync the mtime baseline: reloadAll itself writes reminderLastSeenAt (touching -wal); without this
        // the next poll sees our own write as "another external write" → reload → write again = a self-sustaining loop
        try {
          lastMtime = Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0)
        } catch {}
      } catch (e) { log.warn('[TodoDB] 外部写入刷新失败', e) }
    }, 500)
  }
  const onChange = () => {
    try {
      const m = Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0)
      if (m === lastMtime) { forwardTomatoCmd(); return } // check commands even when mtime is unchanged (guards against watchFile dropping events)
      lastMtime = m
      kick()
      forwardTomatoCmd()
    } catch {}
  }
  fs.watchFile(dbFile, { interval: 2000 }, onChange)
  fs.watchFile(walFile, { interval: 2000 }, onChange)
}

/* ---------------- External-link safety: only http/https allowed ---------------- */
function isSafeExternal (url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

const { saveAttachment, attachDir, attachmentPath } = require('./attachments')
const attachments = require('./attachments')

/* ---------------- Excel export (column headers follow common practice) ---------------- */
/* ================= Main window ================= */
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
    title: i18nM.mt('appName'),       // taskbar/alt-tab label follows the configured language (index.html <title> is the zh fallback only)
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
      win.setTitle(i18nM.mt('appName') + ' [TEST]')
      win.webContents.on('did-finish-load', () => {
        win.setTitle(i18nM.mt('appName') + ' [TEST]')
        win.webContents.executeJavaScript(`{
          if (!document.getElementById('test-env-badge')) {
            const b = document.createElement('div')
            b.id = 'test-env-badge'
            b.textContent = 'TEST'
            b.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;background:#f2a63b;color:#fff;font:bold 11px/1 sans-serif;padding:4px 8px;border-radius:0 0 6px 0;pointer-events:none;letter-spacing:1px'
            document.body.appendChild(b)
          }
          document.title = ${JSON.stringify(i18nM.mt('appName'))} + ' [TEST]'
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
    if (!isMainFrame || code === -3 || quitting) return
    if (loadRetryCount >= 3) return
    loadRetryCount++
    const delay = 400 * loadRetryCount
    log.warn('[Window] 主框架加载失败,退避重试', loadRetryCount, 'in', delay, 'ms')
    setTimeout(() => {
      try { if (win && !win.isDestroyed()) win.webContents.loadURL('app://app/renderer-dist/index.html').catch(() => {}) } catch { /* gone */ }
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
    if (quitting) return // a quit in progress kills renderers as a side effect; do not fight it
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
    if (!quitByUser && closeBehavior.isCloseToTray(readConfig())) {
      e.preventDefault(); win.hide()
      const cfg = readConfig()
      if (closeBehavior.shouldShowTrayNotice(cfg)) {
        writeConfig({ closeTrayNotified: true })
        try { if (tray && process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title: i18nM.mt('appName'), content: i18nM.mt('closeTrayNotice') }) } catch (err) { /* balloon is best-effort */ }
      }
    } else {
      writeConfig({ winBounds: win.getBounds() })
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

/* ================= Tray ================= */
function createTray () {
  const iconPath = path.join(__dirname, '../../assets/tray/tray.png')
  const usedPath = fs.existsSync(iconPath) ? iconPath : path.join(__dirname, '../../assets/icon.png')
  tray = new Tray(usedPath)
  tomatoTaskbar.attachTray(tray, usedPath) // during a pomodoro the tray is redrawn as a progress ring; restores the original icon when idle
  rebuildTrayMenu()
  tray.setToolTip(i18nM.mt('appName'))
  tray.on('click', () => { showMainOrLock() })
}
// Tray carries pomodoro state: the tooltip is composed solely by the main process (single writer; shows just the app name when text is empty)
function updateTomatoTray (text) {
  const t = String(text || '').trim()
  if (tray) { try { tray.setToolTip(i18nM.mt('appName') + (t ? ' · ' + t : '')) } catch (e) { /* empty */ } }
}

function rebuildTrayMenu () {
  if (!tray) return
  const tpl = []
  tpl.push({ label: tomatoFloat.isDocked() ? i18nM.mt('trayShowFloat') : i18nM.mt('trayDockFloat'),
    click: () => { tomatoFloat.isDocked() ? tomatoFloat.undock() : tomatoFloat.dock(); rebuildTrayMenu() } })
  tpl.push({ label: i18nM.mt('trayOpen'), click: () => { showMainOrLock() } })
  tpl.push({ type: 'separator' })
  tpl.push({ label: i18nM.mt('trayQuit'), click: () => {
    quitByUser = true
    // win can be a DESTROYED instance here (closeActionMinimize=false destroys the window on X but only
    // createMainWindow reassigns the module var) — getBounds on it throws "Object has been destroyed" and
    // kills the whole quit chain. Route through the live-window guard.
    const qw = getMainWindow()
    if (qw) writeConfig({ winBounds: qw.getBounds() })
    // Destroy the tray icon first: the icon only disappears on Windows when the process exits,
    // while the quit path (renderer flush + scheduler persist + WAL close) can take seconds — without this, the icon lingers and reads as "quit is slow"
    if (tray) { try { tray.destroy() } catch (e) { /* empty */ } tray = null }
    app.quit()
  } })
  tray.setContextMenu(Menu.buildFromTemplate(tpl))
}

/* ================= Custom protocol privileges (must run before ready) ================= */
{
  const { protocol } = require('electron')
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'local', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/* ================= Single-instance lock & startup ================= */
if (!app.requestSingleInstanceLock()) { app.quit() } else {
  app.on('second-instance', () => { showMainOrLock() })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null) // project baseline has no menu bar
    // 账本广播挂 db 层钩子(非 IPC handler):CLI 是独立进程直写 DB,不经过本进程 IPC,
    // 只有 db.call 统一出口能同时覆盖 App IPC 与外部写入后的通知(2026-09-04 实锤修复)
    dbm.setLedgerChangedHook(op => broadcastTomatoRecordsChanged(op))
    // 无 todos.db 但 .plain-bak 存在 = 加密迁移两步 rename 间崩溃的'两头都没有'窗口(2026-09-04 深审 P0):
    // 空库 init 不抛错、不会进 attemptDbRecovery,必须在此显式把 plain-bak 放回去
    try {
      const ud0 = app.getPath('userData'), fs0 = require('fs'), p0 = require('path')
      // 三条件同时成立才是迁移两步 rename 的崩溃现场:无 todos.db、有 plain-bak、无 db.key(迁移成功才写 key;
      // key 还在 = 用户手删库或其他场景,复制明文库会被带钥探针误判损坏,交给正常 init/recovery 流程)
      const bak0 = p0.join(ud0, 'todos.db.plain-bak')
      if (!fs0.existsSync(p0.join(ud0, 'todos.db')) && fs0.existsSync(bak0)) {
        if (!fs0.existsSync(p0.join(ud0, 'db.key'))) {
          // 无库+无key+有bak = 迁移两步 rename 崩溃现场:清孤儿 WAL 后把明文库放回
          for (const suf of ['-wal', '-shm']) { try { fs0.rmSync(p0.join(ud0, 'todos.db' + suf), { force: true }) } catch {} }
          fs0.copyFileSync(bak0, p0.join(ud0, 'todos.db'))
          log.warn('[Init] 迁移中断残留:已从 todos.db.plain-bak 恢复数据库文件')
        } else {
          // 无库+有bak+有key(用户手删库等):静默跳过会让 init 落到空库、数据被无视(二轮深审 P1-1)。
          // 把旧 key 移开、明文库放回:init 走无钥+存量库路径,生成新 key 并重加密,数据保留
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          try { fs0.renameSync(p0.join(ud0, 'db.key'), p0.join(ud0, 'db.key.superseded-' + stamp)) } catch {}
          for (const suf of ['-wal', '-shm']) { try { fs0.rmSync(p0.join(ud0, 'todos.db' + suf), { force: true }) } catch {} }
          fs0.copyFileSync(bak0, p0.join(ud0, 'todos.db'))
          log.warn('[Init] todos.db 缺失但存在明文备份:已从 plain-bak 恢复,旧 db.key 移为 db.key.superseded-*')
        }
      }
    } catch (e0) { log.warn('[Init] plain-bak 预检失败', e0) }
    // 上次「重置数据」时被占用而改名挂起的文件(pending-delete-<ts>-*),本次启动句柄已释放,统一清扫
    try {
      const ud0s = app.getPath('userData')
      for (const f of fs.readdirSync(ud0s)) {
        if (f.startsWith('pending-delete-')) { try { fs.rmSync(path.join(ud0s, f), { force: true, recursive: true }) } catch {} }
      }
    } catch (e0s) { log.warn('[Init] pending-delete 清扫失败', e0s) }
    try {
      dbm.init(app.getPath('userData'))
    } catch (e) {
      log.error('[Init] DB 初始化失败：', e)
      const { dialog, shell } = require('electron')
      const ud = app.getPath('userData')
      const recoveredFrom = attemptDbRecovery(ud)
      let reinitErr = null
      try { dbm.init(ud) } catch (e2) { reinitErr = e2 }
      let restoredN = 0
      // source is a structured branch flag; display copy must never drive logic (dbRecovery.cjs contract)
      if (recoveredFrom && recoveredFrom.source === 'json') restoredN = restoreTasksFromCriticalBackup(ud)
      const detailMsg = String(e && e.message || e) + '.' + (recoveredFrom
        ? i18nM.mt('dbFailRecovered', { n: restoredN })
        : i18nM.mt('dbFailRecoveredNone')) + (reinitErr ? i18nM.mt('dbFailReinit', { msg: reinitErr.message }) : '')
      const buttons = recoveredFrom
        ? [i18nM.mt('btnRecoverRelaunch'), i18nM.mt('btnOpenDataDir'), i18nM.mt('btnQuit')]
        : [i18nM.mt('btnOpenDataDirBackup'), i18nM.mt('btnResetRelaunch'), i18nM.mt('btnQuit')]
      const choice = dialog.showMessageBoxSync({
        type: 'error', title: i18nM.mt('appName'), message: i18nM.mt('dbFailMessage'),
        detail: detailMsg, buttons, defaultId: 0, cancelId: buttons.length - 1
      })
      // app.exit does not trigger will-quit: the relaunch path must explicitly unregister system hotkeys (otherwise the new instance misreports registration conflicts)
      const relaunchClean = () => { app.relaunch(); shortcuts.unregisterAll(); app.exit(0) }
      if (choice === 0 && recoveredFrom) { relaunchClean() }
      else if (choice === 0) { shell.openPath(ud); app.quit() }
      else if (choice === 1 && recoveredFrom) { app.quit() }
      else if (choice === 1) {
        // Reset-data-and-relaunch. Root cause fixed (2026-09-09): unlink on an open SQLite file always
        // fails with EPERM on Windows and the blanket `catch {}` swallowed it — the user was told the
        // data was destroyed while todos.db survived intact. Close our handle first, then delete;
        // files that still cannot be unlinked are renamed aside (pending-delete-<ts>-*, swept at next
        // startup), and any residual failure is reported to the user instead of silently "succeeding".
        try { dbm.close() } catch {}
        const ts = Date.now()
        const failures = []
        for (const f of ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key', 'todos.db.plain-bak']) {
          const p = path.join(ud, f)
          try {
            fs.unlinkSync(p)
          } catch (err) {
            try {
              fs.renameSync(p, path.join(ud, fixUtil.pendingDeleteName(f, ts)))
              log.warn('[Reset] 文件被占用无法直接删除,已改名挂起(下次启动清理):', f, err.message)
            } catch (err2) {
              failures.push(f + ': ' + (err2 && err2.message || err2))
            }
          }
        }
        if (failures.length) {
          // Never claim success when files survived: hand the list back to the dialog flow
          dialog.showErrorBox(i18nM.mt('appName'), i18nM.mt('dbFailMessage') + '\n\n' + failures.join('\n'))
        }
        relaunchClean()
      } else { app.quit() }
      return
    }
    // init 成功(加密库正常打开)=迁移自愈窗口已关闭:立刻删除 .plain-bak 明文残留,否则用户的
    // 全部任务/账本永远留一份明文拷贝在 userData,at-rest 加密被整体架空(2026-09-05 二轮深审 P1-1)
    try {
      const pb = path.join(app.getPath('userData'), 'todos.db.plain-bak')
      if (fs.existsSync(pb)) { fs.rmSync(pb, { force: true }); log.info('[Init] 加密库启动正常,已清除明文残留 todos.db.plain-bak') }
    } catch (e0) { log.warn('[Init] plain-bak 清理失败', e0) }
    handleAppProtocol()
    createMainWindow()
    tomatoTaskbar.init(win) // taskbar progress/title countdown/thumbnail toolbar (pomodoro, Windows native)
    // Temporary demo data injection (enabled with --seed-tomato)
    // Guard: TODO_USER_DATA_DIR unset = connected directly to the real database (%APPDATA%\pickdone); demo data must never pollute real user data
    if (process.argv.includes('--seed-tomato')) {
      if (!process.env.TODO_USER_DATA_DIR) {
        log.warn('--seed-tomato 仅允许在隔离数据目录实例使用，本次已忽略；设置 TODO_USER_DATA_DIR 后重试')
      } else {
        try { require('./seed-temp')(win) } catch (e) { log.warn('[Seed] failed', e) }
      }
    }
    createTray()
    scheduler.setSoundFile(path.join(__dirname, '../../assets/media/confirm1.ogg'))
    scheduler.reloadAll(dbApi())
    // Meta GC: clean up orphan keys (residue after a repeat rule is deleted / project deadline & milestones become permanent orphans after a category is deleted)
    try {
      const live = new Set((dbm.call('getAllCategories') || []).map(c => String(c.id || c.categoryId)))
      const liveRids = new Set((dbm.call('getAll', { deleted: null }) || []).map(t => t.repeatId).filter(Boolean))
      for (const k of dbm.call('listMetaKeys') || []) {
        let m = k.match(/^repeatRule:(.+)$/)
        if (m && !liveRids.has(m[1])) { dbm.call('deleteMeta', k); continue }
        m = k.match(/^(?:projectDeadline|projectMilestones):(.+)$/)
        if (m && !live.has(m[1])) dbm.call('deleteMeta', k)
      }
    } catch (e) { log.warn('[MetaGC] skipped:', e && e.message) }
    registerIpc()
    watchDbForExternalWrites()

    // Auto-update: init the event bridge + delayed silent check (does not compete with startup; degrades automatically in non-update environments)
    updater.init(win)
    setTimeout(() => { updater.check().then(r => { if (r.active) log.info('[Updater]', r.status) }).catch(() => {}) }, 8000)
    // Periodic re-check for resident instances (4h): users who go long without restarting still get the new-version notice within the current session
    setInterval(() => { updater.check().catch(() => {}) }, 4 * 60 * 60 * 1000).unref?.()

    // Global shortcuts (shortcut settings stored in config.json)
    applyShortcuts(readConfig().shortcutKeySettings)

    // Security lock: when enabled the main process takes over — hide the main window and pop a standalone lock screen (aligned with the reference enableSecurityLock)
    if (readConfig().enableSecurityLock) {
      win.webContents.once('did-finish-load', () => {
        try { lockAppNow() } catch (e) { log.error('[SecurityLock] 锁定失败', e) }
      })
    }
    log.info('[App] 初始化完成。userData=', app.getPath('userData'))
  }).catch(e => {
    // Uncaught exceptions inside the whenReady chain (createTray/registerIpc/applyShortcuts etc.): Electron by default only logs and does not exit,
    // leaving a zombie process with no window and no tray (from the user's view, "double-click does nothing"). Explicitly log + dialog + exit.
    log.error('[App] 启动初始化失败:', e)
    try {
      dialog.showErrorBox('PickDone — ' + i18nM.mt('startupFailed'), String((e && e.stack) || e))
    } catch (_) { /* no dialog available */ }
    app.exit(1)
  })
}

function proxyDb () {
  return new Proxy({}, { get (_, op) { return (p) => dbm.call(op, p) } })
}

function dbApi () { return { queryTodos: p => dbm.call('queryTodos', p), ...proxyDb() } }

let quitting = false // re-entrancy guard for the will-quit flush window (see below)
let flushDone = false // flush window finished; second will-quit passes through so the native quit event (updater autoInstallOnAppQuit) fires
app.on('before-quit', () => {
  quitByUser = true
  // Before quitting, broadcast the renderer flush of debounced mirrors (the last write within dbMirror's 2s / disaster-snapshot 800ms window would be silently lost)
  // 2026-09-10 P1: previously only the main window was notified — the float window's pending pomodoro
  // ledger (and the whole broadcast when the main window was already destroyed, e.g. X-close→tray→quit)
  // was silently lost. Broadcast to every live window with an isDestroyed guard.
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (w && !w.isDestroyed()) w.webContents.send('app-quitting-flush') } catch {}
  }
})
app.on('window-all-closed', e => { /* stay resident in the tray, do not quit */ })
app.on('will-quit', (event) => {
  /* P0 quit-flush race (2026-09-09): before-quit only fire-and-forgets 'app-quitting-flush' while the
     old will-quit closed the DB immediately — renderer invokes still inside the dbMirror 2s debounce
     (pending edits / pomodoro ledger) arrived after dbm.close() and were silently dropped.
     Fix: first will-quit preventDefaults and holds the quit open for a bounded 500ms flush window; the
     timer flushes scheduler state and closes the DB, then re-issues app.quit() with flushDone=true so the
     second will-quit is NOT prevented — the native `quit` event must fire because electron-updater's
     autoInstallOnAppQuit installs on quit, and app.exit() would skip it entirely (2026-09-09 review).
     app.exit(0) below is only a hang fallback if the re-issued quit is somehow swallowed again.
     Verification path: tray → quit and window-X → quit both run before-quit → will-quit(preventDefault) →
     500ms window → flush+close → app.quit() → will-quit(passthrough) → quit event; process must exit
     exactly once with no lingering tray icon. */
  if (flushDone) return // passthrough: let the native quit (and updater install) proceed
  if (quitting) { event.preventDefault(); return }
  quitting = true
  event.preventDefault()
  setTimeout(() => {
    try { shortcuts.unregisterAll() } catch {}
    // Persist the reminder dedup ledger synchronously (quitting inside the 60s debounce window → reminders resent after restart) + close the db handle (avoids losing one checkpoint and late handle release on Windows)
    try { scheduler.flushFiredNow() } catch {}
    try { if (dbm && dbm.close) dbm.close() } catch {}
    flushDone = true
    app.quit()
    setTimeout(() => { try { app.exit(0) } catch {} }, 3000) // hang fallback only; normally unreachable
  }, 500)
})

/* ================= Full IPC registration (channel names aligned with the project baseline) ================= */
let lastPickedImportPath = '' // the only legitimate path source for import:run (the import:pick-preview dialog)
function registerIpc () {
  // App-side audit trail (src/main/audit.js) resolves its JSONL path lazily; wire it to the real userData
  // here so app.setPath('userData', TODO_USER_DATA_DIR) test isolation is honored
  appAudit.setDirResolver(() => app.getPath('userData'))
  // Whitelist of DB ops callable by the renderer: only reads + safe writes pass.
  // Unlike dbm.isWriteOp: this whitelist governs "callable from any renderer window", while isWriteOp governs "whether reloadAll/broadcast is triggered".
  // ⚠️ The whitelist must cover the renderer's real call surface: the cli/check-ipc-op-coverage.cjs gate statically cross-checks
  // (the full set of dbCall/dbCall?.( ops in the renderer ⊆ this list); two missed checks once silently broke features entirely (filterList/bumpSnow).
  // hardDelete is a dangerous write, but the renderer's recycle-bin "delete permanently" uses it for single items, so it stays on the whitelist;
  // purgeRecycleBin/purgeSeedTodos go through dedicated main-process channels below, not through this whitelist.
  const ALLOWED_RENDERER_OPS = new Set([
    'getById', 'getAll', 'queryTodos', 'getMeta', 'deleteMeta',
    'upsert', 'upsertMany', 'hardDelete', 'hardDeleteMany', 'setMeta',
    'getAllCategories', 'upsertCategory',
    // Filter CRUD (filterUpsert/filterDelete are user-level safe writes, same as upsertCategory) + count reads
    'filterList', 'filterUpsert', 'filterDelete', 'countAll', 'countSeedTodos',
    // Atomic accumulation of pomodoro focus minutes (a safe write preventing concurrent overwrites; missing it once silently lost pomodoro credit)
    'bumpSnow',
    // Plan-chip row storage (2026-09-03 root fix): read/write at atomic-operation granularity, single-field validation at the db layer, no whole-package overwrite surface
    'planAll', 'planAddMany', 'planUpdateChip', 'planRemoveIds',
    'planMoveTask', 'planDeleteTask', 'planDeleteTaskDay', 'planPrune',
    // 番茄账本行存储(2026-09-04 根修):主窗/浮窗/CLI 同表同 op,账本无整包覆盖面
    'tomatoAll', 'tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta'
  ])

  // Dangerous DB ops: batch write/batch delete/arbitrary meta write. Capability-wise aligned with "dangerous channels main-window only" —
  // a compromised float/lock-screen window could previously wipe the whole database in bulk or change any meta via todo-db:call (audit 2026-09-01).
  // The renderer's real call surface has been verified: all three only occur in the main window (store/utils/main.js); auxiliary windows have no legitimate callers.
  const MAIN_WINDOW_ONLY_OPS = new Set(['upsertMany', 'hardDeleteMany', 'setMeta', 'deleteMeta'])

  // Lock-screen password brute-force throttling: after 5 failures, trip for 60s (guards against dictionary attacks)
  const LOCK_FAIL_LIMIT = 5
  const LOCK_FAIL_WINDOW = 60 * 1000
  const LOCK_COOLDOWN = 60 * 1000
  const lockFailCount = { n: 0, firstAt: 0, lockedUntil: 0 }
  function checkLockRateLimit (plain) {
    const now = Date.now()
    if (now < lockFailCount.lockedUntil) return false // currently tripped
    if (now - lockFailCount.firstAt > LOCK_FAIL_WINDOW) {
      lockFailCount.n = 0; lockFailCount.firstAt = now
    }
    const ok = verifyLockPassword(plain)
    if (!ok) {
      lockFailCount.n += 1
      if (lockFailCount.n >= LOCK_FAIL_LIMIT) {
        lockFailCount.lockedUntil = now + LOCK_COOLDOWN
        log.warn('[SecurityLock] 失败 ' + lockFailCount.n + ' 次，熔断 60s')
      }
    } else {
      lockFailCount.n = 0; lockFailCount.firstAt = 0; lockFailCount.lockedUntil = 0
    }
    return ok
  }

  // Dangerous-channel guard: only the main window may call (lock-screen/float/quick-add and all other renderer windows are rejected)
  const assertMainWindow = (e) => {
    const w = getMainWindow()
    if (!w || e.sender !== w.webContents) {
      log.warn('[IPC] 拒绝非主窗调用危险通道, sender:', e.sender.id)
      throw new Error('forbidden: main window only')
    }
  }

  /** Purge disk attachments after hard delete (filename prefix = taskId_, same rule as saveAttachment): warn-only on failure, never blocking */
  function purgeAttachmentFiles (ids) {
    if (!ids || !ids.length) return
    try {
      const dir = attachDir()
      const prefixes = ids.map(id => `${id}_`)
      for (const f of fs.readdirSync(dir)) {
        if (prefixes.some(p => f.startsWith(p))) {
          try { fs.unlinkSync(path.join(dir, f)) } catch (err) { log.warn('[Purge] 附件删除失败:', f, err.message) }
        }
      }
    } catch (err) { log.warn('[Purge] 附件目录遍历失败:', err.message) }
  }

  const handlers = {
    // --- DB ---
    'todo-db:call': (e, op, params) => {
      // While the security lock is active: only the lock-screen window may write (prevents the pomodoro float/injected windows from reading or writing data around the lock)
      if (isLocked() && !isLockWindow(e.sender)) {
        // 浮窗到点落番茄账是合法后台行为:锁屏期间放行浮窗自身的番茄追加类写(只挡读/危险写,威胁模型针对绕锁读写)
        let floatLedger = tomatoFloat.isSelfSender(e.sender) && /^(tomatoAppendMany|tomatoUpdateById|bumpSnow)$/.test(op) // bumpSnow=挂任务送专注积分,同属到点落账
        if (floatLedger && (op === 'tomatoUpdateById' || op === 'tomatoAppendMany')) {
          // 本地时区当天(dateKey 按本地 dayjs 导出,UTC 串会在 0-8 点误判跨天)
          const todayKey = fixUtil.localDayKey(Date.now())
          if (op === 'tomatoUpdateById') {
            // dateKey 由 endTime 强制导出(db 层),校验目标行当天即够;查不到的行让 db 层自己返回 false
            const cur = dbm.call('tomatoAll', {}).find(r => r && String(r.tomatoId) === String((params || {}).tomatoId))
            floatLedger = !!cur && cur.dateKey === todayKey
          } else {
            // tomatoAppendMany 同款收窄(2026-09-09 P2):此前批量追加无时间约束,被陷浮窗锁屏期可
            // 伪造任意历史日期的账本行;现要求所有行的 endTime 都落在本地当天
            const rows = Array.isArray(params) ? params : [params]
            floatLedger = rows.every(r => r && r.endTime && fixUtil.localDayKey(r.endTime) === todayKey)
          }
        }
        if (!floatLedger) throw new Error('app is locked')
      }
      // Write-op whitelist: callable by the renderer; other ops must go through main-process methods (prevents XSS injecting arbitrary ops)
      if (!ALLOWED_RENDERER_OPS.has(op)) {
        log.warn('[IPC] 拒绝渲染端 op:', op, 'from sender:', e.sender.id)
        throw new Error('DB op not allowed: ' + String(op))
      }
      if (MAIN_WINDOW_ONLY_OPS.has(op)) assertMainWindow(e)
      // Pre-write snapshot for upsert only (single indexed read): the audit trail needs the previous row to
      // tell done/undo/delete/restore/subtask apart. Must run BEFORE dbm.call overwrites the row; best-effort.
      let auditBefore = null
      if (op === 'upsert' && params && params.taskId != null) {
        try { auditBefore = dbm.call('getById', String(params.taskId)) } catch { /* null → coarse action */ }
      }
      const r = dbm.call(op, params)
      // App-side audit: renderer-initiated writes append to the same JSONL trail the CLI writes
      // (userData/cli-audit.jsonl). No double-logging: CLI write commands hit db.js directly inside the
      // CLI process and never pass through this IPC handler. The settings mirror blob (setMeta
      // db.settingsState, persisted debounced on every settings change) is skipped as noise.
      // Fire-and-forget: audit failures must never break the IPC path.
      try { appAudit.recordAppOp(op, params, { before: auditBefore, result: r }) } catch { /* best-effort */ }
      // Write-op determination lives in db.js's explicit WRITE_OPS list (do not fall back to regex: hardDeleteMany and others were once missed, leaving cross-window data stale)
      // setMeta writes only the meta table, not todos: skip reloadAll (settings/tomato/dayPlan mirrors are high-frequency writes; the previous full-reload path caused a reload storm); still broadcast so peer windows sync
      if (op === 'setMeta') { broadcastTodosChanged(op, e.sender); return r }
      if (dbm.isWriteOp(op)) {
        // Single-task writes (upsert/bumpSnow) reschedule only that task's timers via scheduleOne instead of a
        // full reloadAll (whole-table scan + all timers torn down and rebuilt on every write). Fall back to
        // reloadAll for bulk ops, when the row is gone, or when any reminder time is already past — scheduleOne
        // skips past times, while reloadAll owns the missed-reminder catch-up path (watermark + re-fire).
        const tid = (params || {}).taskId
        const t = (op === 'upsert' || op === 'bumpSnow') && tid != null ? dbm.call('getById', String(tid)) : null
        if (t && !scheduler.reminderInstances(t).some(([, ts]) => ts <= Date.now())) scheduler.scheduleOne(t)
        else scheduler.reloadAll(dbApi())
      }
      // 账本行写:调度器不依赖番茄记录;广播由 db 层 setLedgerChangedHook 统一发(CLI 直写同样触发),此处只跳过 todos 全量重载
      if (op === 'tomatoAppendMany' || op === 'tomatoUpdateById' || op === 'tomatoRemoveByIds' || op === 'tomatoMigrateFromMeta') return r
      if (dbm.isWriteOp(op)) broadcastTodosChanged(op, e.sender) // exclude the originating sender, so optimistic updates are not clobbered by the echo
      return r
    },

    // --- Dangerous purge: dedicated channels (bypassing the todo-db:call whitelist); only the main window may call (UI already double-confirms),
    //     float/quick-add/lock-screen and all other renderer windows are rejected ---
    'db:purge-recycle-bin': (e) => {
      assertMainWindow(e)
      if (isLocked()) throw new Error('locked')
      // Collect rows to delete and clean attachment files first (files before rows): deleting only rows once left private attachments on disk after "permanent wipe"
      let ids = []
      try {
        ids = dbm.call('queryTodos', { deleted: 1 }).map(t => t.taskId)
      } catch (err) { log.warn('[Purge] 收集回收站行失败，仅删行:', err) }
      const r = dbm.call('purgeRecycleBin')
      purgeAttachmentFiles(ids)
      scheduler.reloadAll(dbApi()); broadcastTodosChanged('purgeRecycleBin', e.sender)
      return r
    },
    'db:purge-seed-todos': (e) => {
      assertMainWindow(e)
      if (isLocked()) throw new Error('locked')
      const r = dbm.call('purgeSeedTodos')
      // Symmetric with purge-recycle-bin: purging demo data also refreshes the scheduler + broadcasts (once missing → other windows kept stale seed records and scheduled reminders still fired)
      scheduler.reloadAll(dbApi()); broadcastTodosChanged('purgeSeedTodos', e.sender)
      return r
    },

    // --- Settings / config ---
    // Sensitive-key stripping: the security-lock ciphertext in config must never be sent down to any renderer window (a compromised auxiliary window could pair with decrypt-secret to recover the lock-screen plaintext password)
    'get-settings': () => {
      const c = readConfig()
      delete c.securityLockPassword
      delete c.securityLockQuestion
      return c
    },
    'set-app-locale': (e, locale) => { i18nM.setLocale(locale); const c = writeConfig({ appLocale: locale }); rebuildTrayMenu(); if (tray) { try { tray.setToolTip(i18nM.mt('appName')) } catch (err) { /* empty */ } } if (win && !win.isDestroyed()) { try { win.setTitle(i18nM.mt('appName')) } catch (err) { /* empty */ } } return c },
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
    },

    // --- Reminders ---
    'notification': (e, opt) => {
      // Same sanitization as scheduler.fire: renderer-supplied title/body goes straight to system notifications; control characters/RTL override characters must be stripped
      // eslint-disable-next-line no-control-regex -- control characters are exactly the target of this sanitization; the rule does not apply here
      const clean = v => require('./sanitize').sanitizeText(v, 200)
      const n = new Notification({ title: clean(opt.title) || i18nM.mt('notifyDefault'), body: clean(opt.body), silent: !!opt.silent })
      n.show(); return true
    },

    // --- External links ---
    'open-external-url': (e, url) => {
      if (!isSafeExternal(url)) return
      if (isSafeExternal(url)) shell.openExternal(url)
    },
    // [IPC dead channels cleaned] download-file/open-file-in-viewer/goto-main-window-and-select-todo/
    // show-todo-list/focus-main-window/open-settings-modal/user-logout/get-memory-metrics/
    // downloadUpdate/critical-state:*/app-initialization-completed/get-window-bounds etc. had no renderer callers and were deleted
    // The old checkForUpdates/quitAndInstall stubs were also removed: preload actually uses updater:check / updater:quit-and-install
    'show-about-window': () => {
      const aboutWin = new BrowserWindow({ width: 360, height: 240, resizable: false, minimizable: false, maximizable: false, frame: true, show: false })
      aboutWin.removeMenu()
      aboutWin.loadURL('data:text/html,' + encodeURIComponent('<body style="font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:88vh;color:#303133;margin:0"><img src="app://app/assets/icon.png" width="72" style="margin-bottom:10px"><div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:20px;font-weight:700">' + i18nM.mt('appName') + '</span><span style="font-size:10px;letter-spacing:2.5px;color:#909399">PICKDONE</span></div><p style="color:#909399;font-size:12px;margin:6px 0 0">' + i18nM.mt('aboutSlogan') + '</p><p style="color:#c0c4cc;font-size:12px;margin:8px 0 0">' + i18nM.mt('aboutVersion', { v: app.getVersion() }) + '</p></body>'))
      aboutWin.once('ready-to-show', () => aboutWin.show())
      return true
    },
    'notify-data-changed': () => { broadcastTodosChanged('notify-data-changed'); return true },

    // --- Attachments (offline localization) ---
    'upload-attachment': (e, payload) => { if (isLocked()) throw new Error('locked'); return saveAttachment(payload) },
    'open-file': async (e, url) => {
      if (url.startsWith('local://')) { shell.openPath(attachmentPath(url.slice(8))); return true }
      if (isSafeExternal(url)) return shell.openExternal(url)
      return false
    },
    'download-file-and-open': (e, url) => { if (url.startsWith('local://')) { shell.openPath(attachmentPath(url.slice(8))); return true } if (isSafeExternal(url)) shell.openExternal(url); return true },
    'save-upload-file-to-download': (e, url, targetName) => {
      // Security check: force basename on the target name and strip path segments, preventing path traversal writes to arbitrary locations
      const rawName = String(targetName || '').replace(/[/]/g, '_')
      if (/^\.+$/.test(rawName)) throw new Error('bad target name')
      const safeName = path.basename(rawName) || path.basename(attachmentPath(url.slice(8)))
      // 同名不静默覆盖(2026-09-10 P2):copyFileSync 直接覆盖用户已有的同名下载;改为 " (n)" 后缀,
      // 并包 try 返回结构化错误(磁盘满/权限等此前抛裸异常,渲染端只能拿到笼统 invoke reject)
      if (url.startsWith('local://')) {
        try {
          const src = attachmentPath(url.slice(8))
          const dst = fixUtil.nextAvailableName(app.getPath('downloads'), safeName, p => fs.existsSync(p))
          fs.copyFileSync(src, dst)
          return dst
        } catch (err) {
          throw new Error('save-to-download failed: ' + String((err && err.message) || err))
        }
      }
      return null
    },
    'delete-file': (e, url) => { if (isLocked()) throw new Error('locked'); try { if (url.startsWith('local://')) fs.unlinkSync(attachmentPath(url.slice(8))) } catch {} return true },
    'delete-todo-files': (e, taskId) => {
      if (isLocked()) throw new Error('locked')
      const dir = attachDir()
      for (const f of fs.readdirSync(dir)) if (f.startsWith(taskId + '_')) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
      return true
    },

    // --- Export ---
    'export-todos-to-xlsx': (e, payload) => { if (isLocked()) throw new Error('locked'); return exportTodosToXlsx(payload) },

    // --- Backup (critical-state aligned) ---
    'write-critical-state-backup': (e, jsonText) => {
      // 灾备唯一源通道:主窗限定+锁定态拒绝(被攻陷的浮窗/快加窗可覆写 critical JSON 投毒恢复源,三轮安全深审 C-2)
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      if (isLocked()) throw new Error('app is locked')
      // External default root (userData parent dir / pickdone-backups): separated from todos.db, so disaster backup remains recoverable even if userData is wiped
      dbRecovery.writeCriticalStateBackupAtomic(defaultBackupRoot(), String(jsonText))
      return true
    },
    'get-default-backup-dir': () => defaultBackupRoot(),
    // --- Secure storage: sensitive values like securityLockPassword encrypted with safeStorage (DPAPI/Keychain) ---
    // Main window only: encrypt/decrypt primitives serve only the main window's settings page and lock-screen flow; a compromised float/quick-add window must not use them to recover plaintext
    'encrypt-secret': (e, plain) => {
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      // When encryption is unavailable, refuse rather than persist plaintext (storing the lock password in plaintext contradicts "secure storage"; open-source audits would flag it).
      // Windows DPAPI is always available; this branch realistically only appears in anomalous environments.
      const { safeStorage } = require('electron')
      if (!plain) return ''
      if (!safeStorage.isEncryptionAvailable()) throw new Error('secure-encryption-unavailable')
      return 'enc1:' + safeStorage.encryptString(String(plain)).toString('base64')
    },
    'decrypt-secret': (e, stored) => {
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      try {
        const { safeStorage } = require('electron')
        if (!stored) return ''
        if (!stored.startsWith('enc1:')) return stored // backward compatible with historical plaintext
        if (!safeStorage.isEncryptionAvailable()) return ''
        return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
      } catch { return '' }
    },

    // --- Security lock (verification happens entirely in the main process; the plaintext password is never returned to the renderer) ---
    'lock-app': () => { lockAppNow() },
    // Unlock may only be initiated by the lock-screen window itself (prevents the float/other windows from calling without a password)
    'unlock-app': (e) => { if (isLockWindow(e.sender)) unlockAppNow() },
    // Password verification: (1) must be initiated by the lock-screen window (prevents brute force from any renderer window) (2) 5 failures trip a 60s cooldown (prevents dictionary attacks)
    'verify-lock-password': (e, plain) => {
      if (!isLockWindow(e.sender)) {
        log.warn('[SecurityLock] 拒绝 verify-lock-password from non-lock window, sender:', e.sender.id)
        return false
      }
      return checkLockRateLimit(plain)
    },
    'pick-backup-dir': async () => {
      const { dialog } = require('electron')
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, { title: i18nM.mt('pickBackupDir'), properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      loadAllowedBackupDirs()
      allowedBackupDirs.add(path.resolve(r.filePaths[0])) // only user-explicitly-picked directories enter the whitelist
      saveAllowedBackupDirs()
      return r.filePaths[0]
    },
    // --- Auto backup (GFS tiered retention: recent N + daily anchors + weekly anchors; content dedup; atomic write) ---
    'run-auto-backup': (e, jsonText, opts) => {
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      if (isLocked()) throw new Error('app is locked')
      try {
        const o = typeof opts === 'number' ? { recent: opts } : (opts || {})
        const dir = resolveBackupDir(o.backupDir)
        fs.mkdirSync(dir, { recursive: true })
        const d = new Date()
        const pad = n => String(n).padStart(2, '0')
        const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
        // Lowercase uniformly: keeps evt snapshot naming consistent with autoBackup's case-sensitive RE_EVT (no i flag)
        const tag = o.tag ? ('evt-' + String(o.tag).toLowerCase().replace(/[^a-z0-9-]/g, '') + '-') : 'auto-'
        const name = tag + stamp + '.json'
        const tmp = path.join(dir, '.tmp-' + name)
        // Content dedup: only compare against the newest file. (The original implementation compared against any old file — when the data was changed back to its original state
        // it would return dedup without writing the new snapshot, yet prune would delete that old snapshot → that point in time ends up with no backup)
        // 排序按名字内嵌时间戳(2026-09-10 P2):字典序 sort() 让 'auto-' 排在同日 'evt-…' 之后/之前错位,
        // 去重会拿一个陈旧文件当"最新"比对 → 误判 dedup 丢快照。复用 fix-util 的纯排序(与 autoBackup.nameToTs 同规则)。
        const existing = fixUtil.sortBackupNamesNewestFirst(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)))
        if (existing.length) {
          try {
            if (fs.readFileSync(path.join(dir, existing[existing.length - 1]), 'utf8') === jsonText) {
              return { ok: true, file: existing[existing.length - 1], dedup: true }
            }
          } catch {}
        }
        // Atomic write: temp file + rename, prevents corruption on interruption
        fs.writeFileSync(tmp, jsonText)
        fs.renameSync(tmp, path.join(dir, name))
        const files = fs.readdirSync(dir).filter(f => (o.tag ? /^evt-/.test(f) : /^(auto|evt)-/.test(f)))
        for (const dead of autoBackup.selectPrunes(files, o)) { try { fs.unlinkSync(path.join(dir, dead)) } catch {} }
        return { ok: true, file: name }
      } catch (err) { return { ok: false, error: String(err && err.message || err) } }
    },
    // 备份读取(2026-09-09 P2):此前三层 catch 全静默——「目录不存在(正常空态)」与「读取失败(权限/IO)」
    // 同样返回 ''/[],设置页永远不知道读不了。改为结构化结果:ok/missing/error,渲染端对应展示错误态
    'read-auto-backup': (e, backupDir, fileName) => {
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      if (isLocked()) throw new Error('app is locked')
      const name = path.basename(String(fileName || ''))
      if (!/^(auto|evt)-.+.json$/.test(name)) return { ok: false, error: 'invalid backup file name' } // whitelisted naming, prevents path traversal
      const dir = resolveBackupDir(backupDir)
      try {
        return { ok: true, text: fs.readFileSync(path.join(dir, name), 'utf8') }
      } catch (err) {
        return fixUtil.classifyBackupError(err) === 'missing'
          ? { ok: false, error: 'backup file not found' }
          : { ok: false, error: String(err && err.message || err) }
      }
    },
    'list-auto-backups': (e, backupDir) => {
      if (!win || e.sender !== win.webContents) throw new Error('main-window-only')
      if (isLocked()) throw new Error('app is locked')
      const dir = resolveBackupDir(backupDir)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch (err) {
        // 目录不存在 = 正常空态(用户尚未选过备份目录),不算错误;其余读取失败必须上报
        if (fixUtil.classifyBackupError(err) === 'missing') return { ok: true, missing: true, files: [] }
        return { ok: false, files: [], error: String(err && err.message || err) }
      }
      // 新→旧展示排序也按内嵌时间戳(字典序会把 evt-/auto- 前缀排在时间之前,同日错位)
      return { ok: true, files: fixUtil.sortBackupNamesNewestFirst(names.filter(f => /^(auto|evt)-/.test(f))) }
    },
    'read-critical-state-backup': () => {
      if (isLocked()) throw new Error('app is locked')
      // Same source of truth as dbRecovery.cjs: external root first, with fallback to legacy files inside userData
      try { return fs.readFileSync(dbRecovery.criticalBackupPath(app.getPath('userData')), 'utf8') } catch { return null }
    },

    // --- CSV import (migrating from other apps): reuses the CLI's cli/import.js engine; both preview and execution go through the main process ---
    'import:pick-preview': async () => {
      const importer = require('../../cli/import.js')
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, {
        title: i18nM.mt('importPickCsv'), properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (r.canceled || !r.filePaths[0]) return null
      const file = r.filePaths[0]
      lastPickedImportPath = file // import:run only allows executing the most recent dialog-picked path (prevents the renderer passing arbitrary paths to read files)
      // 同步 readFileSync 无上限曾把整个主进程(全部窗口/定时器)卡死在大 CSV 上:先 statSync 限 20MB 超限报错(2026-09-09 P2)
      const tooBig = fixUtil.checkImportFileSize(fs.statSync(file).size)
      if (tooBig) throw new Error(tooBig)
      const text = fs.readFileSync(file, 'utf8')
      const format = importer.detectFormat(text)
      const items = importer.rowsToItems(text, format)
      return { file, report: importer.importItems(items, { format, dryRun: true }) }
    },
    'import:run': (e, file) => {
      const f = String(file || '')
      // Arbitrary-path read primitive sealed off: only the path most recently returned by the main-process dialog is accepted
      if (!lastPickedImportPath || f !== lastPickedImportPath) throw new Error('import: path not granted by picker')
      const r = require('../../cli/import.js').importFile(f, { dryRun: false })
      // 与 todo-db:call 写路径对齐(2026-09-09 P2):导入落库后必须刷新调度器并广播,否则应用内导入后
      // 主窗口列表陈旧、已导入的提醒全部静默丢失
      try { scheduler.reloadAll(dbApi()) } catch (err) { log.warn('[Import] reloadAll failed', err) }
      // 2026-09-10 P2:传 e.sender(IpcMainInvokeEvent 本身不是 webContents,exclude 永不命中,
      // 发起导入的窗会被自己的广播打断撤销栈);其余窗照常刷新
      broadcastTodosChanged('import', e.sender)
      return r
    },

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
      if (!win || win.isDestroyed()) return
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

    // --- Version-sync task set (offline no-op reserved channel) ---
    'sync-todos-to-server': () => ({ offline: true }),

    // --- Window controls (win may be destroyed: null-guarded via getMainWindow, avoiding throws after destruction) ---
    'minimize-main-window': () => { const w = getMainWindow(); if (w) w.minimize(); return true },
    'maximize-main-window': () => { const w = getMainWindow(); if (!w) return false; w.isMaximized() ? w.unmaximize() : w.maximize(); return true },
    'is-maximized': () => { const w = getMainWindow(); return w ? w.isMaximized() : false },
    'hide-main-window': () => { const w = getMainWindow(); if (w) w.hide(); return true },
    'close-main-window-request': () => { const w = getMainWindow(); if (w) w.close(); return true },

    // --- Diagnostic logs (renderer logs to a separate file; export diagnostics bundle) ---
    'log:write': (e, entries) => {
      try {
        if (!Array.isArray(entries)) return false
        const rlog = require('electron-log')
        rlog.scope('renderer')
        // Write to a separate renderer.log (reuses electron-log's transports.file mechanism, scope isolated to a subdirectory)
        const fsx = require('fs')
        const dir = path.join(app.getPath('userData'), 'logs')
        fsx.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, 'renderer.log')
        // Cap guard: a compromised renderer could write to disk without bound and fill the disk (dual limits on entry count/entry length; truncate when exceeded)
        const capped = entries.slice(0, 200)
        // 轮转:超 2MB 归档为 renderer.old.log(单副本)。无轮转时被攻陷渲染端可持续刷盘(2026-09-05 终审 P2)
        try {
          const st = fsx.statSync(file)
          if (st.size > 2 * 1024 * 1024) {
            const old = path.join(dir, 'renderer.old.log')
            try { fsx.rmSync(old, { force: true }) } catch {}
            fsx.renameSync(file, old)
          }
        } catch { /* 首次写入文件尚不存在 */ }
        // 2026-09-10 P2:lines 是数组,此前 `lines + NL` 走 array+string 的 join(',') —— 含逗号条目被
        // 拆散、整批挤成一行。改为显式换行连接(纯逻辑抽到 fix-util.formatLogLines 便于测试)
        fsx.appendFileSync(file, fixUtil.formatLogLines(capped) + String.fromCharCode(10), 'utf8')
        return true
      } catch (err) { console.error('[log:write]', err); return false }
    },
    'log:open-dir': () => {
      try {
        const dir = path.join(app.getPath('userData'), 'logs')
        fs.mkdirSync(dir, { recursive: true })
        shell.openPath(dir)
        return true
      } catch (err) { console.error('[log:open-dir]', err); return false }
    },
    // --- Misc ---
    'mime-get-type': (e, name) => {
      const ext = String(name).split('.').pop().toLowerCase()
      const t = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg' }
      return t[ext] || 'application/octet-stream'
    },
    // Custom white noise: copied into userData/files right after picking (reachable via the local:// protocol with Range support, so it can actually play during focus;
    // the old version returned only an absolute path, which the app:// page could not load → picking was equivalent to not picking). Fixed-name overwrite; the directory keeps only the latest file.
    'select-user-white-noise-audio-file': async () => {
      // win 模块级引用在主窗销毁重建后可能是 null/已销毁:dialog 收到死引用会抛,改 getMainWindow 守卫,
      // 无窗时传 undefined(dialog 以无父窗模式打开,2026-09-09 P2)
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, { properties: ['openFile'], filters: [{ name: i18nM.mt('pickAudio'), extensions: ['mp3', 'wav', 'ogg'] }] })
      if (r.canceled || !r.filePaths[0]) return null
      const src = r.filePaths[0]
      const ext = path.extname(src).toLowerCase()
      const key = 'noise-custom' + ext
      await fs.promises.copyFile(src, path.join(attachments.attachDir(), key))
      // 2026-09-10 P2:保存自定义白噪音后广播所有存活窗(渲染端另一代理会加监听,通道名固定);
      // 此前只更新发起窗的本地状态,其他窗(如浮窗)的噪音列表不刷新
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (w && !w.isDestroyed()) w.webContents.send('white-noise-updated') } catch {}
      }
      return { name: path.basename(src), key }
    },

    // --- Auto-update ---
    'updater:check': () => updater.check(),
    'updater:download': () => updater.downloadUpdate(),
    'updater:quit-and-install': () => updater.quitAndInstall(),
    'updater:status': () => updater.getStatus()
  }
  // Unified error logging: handler throws are rethrown as-is (the renderer's invoke still rejects) while the main process leaves a trace —
  // previously, handlers throwing silently left no trace in main-process logs, making cross-window issues impossible to diagnose
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (e, ...args) => {
      try { return await fn(e, ...args) } catch (err) { log.error(`[IPC] ${ch}`, err); throw err }
    })
  }
}


module.exports = { getMainWindow }
