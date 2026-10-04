/**
 * Main process entry — PickDone offline implementation * IPC channel names stay aligned with the project baseline, easing a later swap to a real cloud backend * Window lifecycle lives in windows.js; IPC handlers live in handlers/*.js — this file stays the
 * assembly point (wiring + unified handler error-wrap loop + tray + quit chain). */
const { app, BrowserWindow, ipcMain, Tray, Menu, dialog } = require('electron')
// globalShortcut is required by quick-add/pomodoro-float and other modules (avoid duplicates)
const path = require('path')
// The renderer has no nodeIntegration; pass the real version to preload via env var (todoAPI.version)
process.env.APP_VERSION = app.getVersion()
const fs = require('fs')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

const dbm = require('./db')
const fixUtil = require('./fix-util')
// C11 (2026-09-26): quit gate for the external-write poll — see ext-watch-gate.js and onChange below.
const extWatchGate = require('./ext-watch-gate')
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
// Windows toast notifications resolve the app name/icon via the AppUserModelID; without this they show "electron.app". // Must match package.json build.appId — the electron-builder Start Menu shortcut carries the same AUMID.
app.setAppUserModelId('com.pickdone.app')

// EPIPE tolerance: in dev, when the parent shell exits it takes the inherited stdout/stderr pipes with it; after that, any write from console.log / // electron-log's console transport raises an uncaught EPIPE exception → the main process pops an error dialog (verified P0 on 2026-08-30).
// Node's default behavior for failed pipe writes is to throw; swallow it here: failing to write logs must not drag down the whole app.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', () => {})
}
process.on('uncaughtException', (e) => {
  // Fully tolerate pipe/stream-destroyed errors (a broken log stream does not affect functionality); rethrow everything else through the default dialog without masking real bugs
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' || e.code === 'ERR_STREAM_WRITE_AFTER_END')) return
  // P2 2026-09-17: leave a breadcrumb before the rethrow — the default dialog can be dismissed/skipped // and the crash then leaves no trace in the log file for post-mortem diagnosis
  try { log.error('[uncaughtException]', e && e.stack || e) } catch {}
  throw e
})
// Promise 侧兜底:只记日志不退出(与 uncaughtException 的 rethrow 不同——rejection 多为单点 IO 失败, // 静默吞掉比整窗崩溃更符合本地优先应用的可用性;但必须留痕,否则不可诊断)(2026-09-05 终审 P2)
process.on('unhandledRejection', (reason) => {
  try { log.warn('[unhandledRejection]', reason && (reason.stack || reason.message || reason)) } catch {}
})

// Disable HTTP disk cache for renderer ESM modules (app:// already sends no-cache but Chromium still caches, // which once made revised JS ineffective — the root cause of both blank-screen and stale-logic incidents); reading local resources directly has no performance cost
app.commandLine.appendSwitch('disable-http-cache')
// Test isolation: TODO_USER_DATA_DIR gives test instances a separate data directory coexisting with the dev instance (SQLite WAL multi-process safety is backstopped by external-write detection)
if (process.env.TODO_USER_DATA_DIR) app.setPath('userData', process.env.TODO_USER_DATA_DIR)
// Hardware acceleration switch (aligned with the reference enableHardwareAcceleration; must be called before ready)
try {
  const c = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
  if (c.enableHardwareAcceleration === false) app.disableHardwareAcceleration()
} catch (e) { /* no config on first launch */ }

let tray = null
const state = { quitByUser: false } // shared with windows.js close handler (was a module var in the pre-split index.js)

const { readConfig, writeConfig } = require('./config-store')

// Submodules like scheduler/notify-sound get the main window via window-ref, avoiding a reverse require('./index') dependency
const windowRef = require('./window-ref')

function showMainOrLock () {
  // --no-focus: e2e/smoke instances never steal focus or cover the user's screen — // parked on the secondary display (or off-screen when none) via window-ref.parkForTest
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
const securityLock = createSecurityLock({ getMainWindow, showMainOrLock, readConfig, writeConfig, i18n: i18nM, log })
const { isLocked, lockAppNow, unlockAppNow, verifyLockPassword, isLockWindow } = securityLock
const { allowWithinRate } = require('./security-lock') // pure sliding-window limiter for the notification channel
const { nextWatchBaseline } = require('./watch-baseline') // pure baseline update for the external-write watcher resync
const { createExternalDbWatch } = require('./external-db-watch') // external-write poll (moved verbatim out of this file)
quickAdd.setLockProbe(isLocked) // the global quick-add shortcut does not summon while the screen is locked (summoning = input silently lost)
const shortcuts = createShortcuts({ getMainWindow, showMainOrLock, quickAdd, i18n: i18nM, log })
const { applyShortcuts } = shortcuts

/* ---------------- Main window (factory lives in windows.js; this file wires shared deps) ---------------- */
const { createWindowManager } = require('./windows')
const windowManager = createWindowManager({
  readConfig, writeConfig, i18n: i18nM, log, windowRef, closeBehavior,
  tomatoTaskbar, updater, applyShortcuts, shortcuts, scheduler,
  isLocked, lockAppNow, showMainOrLock,
  isQuitting: () => quitting, getState: () => state, getTray: () => tray,
  // D10 (2026-09-27): renderer-death hooks — clear the stale tomato countdown lease and let the // crash counter health window live in windows.js (see crashRelaunchDecision in handlers/shared).
  onRendererGone: clearTomatoLiveText
})
const createMainWindow = windowManager.createMainWindow
function getMainWindow () { return windowManager.getMainWindow() }

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
function broadcastWhiteNoiseUpdated () {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (w && !w.isDestroyed()) w.webContents.send('white-noise-updated') } catch {}
  }
}

/* ---------------- Tiered recovery from DB corruption (P0 data-loss prevention) — implementation extracted to dbRecovery.cjs (independently testable) ---------------- */
function attemptDbRecovery (ud, retryInit) { return dbRecovery.attemptDbRecovery(ud, retryInit) }
// Phase-2 command bus: the critical-backup restore pipeline commits through the bus // (todo.putMany / category.put / tomato.appendMany) like every other write path. preserveStamp: // restore replays the backup's own row ages verbatim — re-stamping here would skew LWW against
// peers. The 'undo-barrier'/'ls-mirror' subscribers only exist after registerIpc, so the // startup recovery path commits with no fanout, exactly as before.
const busCommit = (entity, verb, payload) => require('./command-bus').commit(entity, verb, payload, { preserveStamp: true })
// F11 (dw wave6): startup recovery now re-imports the SAME segment set the UI restore accepts — // filter.putMany / plan.putMany / meta.put ride the same command-bus doors as the renderer, all // idempotent by id (dbRecovery skips rows without id; the db ops upsert ON CONFLICT).
// Sync-3 (D12): the wrapper returns the per-segment REPORT (tasks / imported / failedSegments / // unconsumedSegments / proved) — the plain-bak cleanup gate must know whether EVERY segment of // the snapshot was consumed, not just whether todoState imported rows.
function restoreFromCriticalBackup (ud) {
  const r = dbRecovery.restoreSegmentsFromCriticalBackup(ud,
    list => busCommit('todo', 'putMany', list),
    c => busCommit('category', 'put', c),
    rows => busCommit('tomato', 'appendMany', rows),
    {
      filterPutMany: rows => busCommit('filter', 'putMany', rows),
      planPutMany: chips => busCommit('plan', 'putMany', chips),
      habitsPut: pair => busCommit('meta', 'put', pair),
      // metaState (2026-09-26, meta-keys-omitted): repeat rules / tomato estimates / project // deadline+status+flag+milestones live only in the meta table — re-put them like habits.
      metaPut: pair => busCommit('meta', 'put', pair)
    })
  // [Sync-13 reader, restore-degraded-segments-marker-never-consumed] the only main-process caller // logs the marker: a degraded dump's missing segments must be visible in the recovery trail.
  if (r && Array.isArray(r.degradedSegments) && r.degradedSegments.length) {
    log.warn('[Init] critical backup was collected degraded — segments missing from this dump:', r.degradedSegments.join(', '))
  }
  return r
}

/* ---------------- External-write listener: when the CLI writes the DB directly, the running App refreshes automatically ----------------
   Implementation moved verbatim to external-db-watch.js (factory carries the closure state the
   module lets used to hold). Pure dependency injection; the top-level construction below is
   side-effect-free — the watcher only arms when watchDbForExternalWrites() runs in whenReady. */
const extWatch = createExternalDbWatch({
  app, log, dbm, fixUtil, extWatchGate, nextWatchBaseline, scheduler,
  getMainWindow, isLocked, dbApi,
  broadcastTodosChanged, broadcastTomatoRecordsChanged, BrowserWindow
})


/* ---------------- External-link safety: only http/https allowed ---------------- */
function isSafeExternal (url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

const attachments = require('./attachments')
const { attachDir } = attachments


// TQ-1 (2026-10-03): durable running-session ownership — created in registerIpc (db handle is // module-initialized before whenReady). From here on the tray-text lease below is DISPLAY-ONLY: // quit guards and startup reconciliation consult the durable 'tomatoRunningSession' meta row.
let tomatoSession = null

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
let tomatoLiveText = '' // non-empty = a focus/rest pomodoro is live (per-second push from the renderer; the main process's only running-state signal)
// D10 (2026-09-27): wired into windows.js's render-process-gone hook — a crashed renderer clears // its own lease immediately (TQ-1: the quit-confirm GATE reads the durable session row, not this // display-only lease, so no timestamp reader is needed).
function clearTomatoLiveText () { tomatoLiveText = '' }
function updateTomatoTray (text) {
  const t = String(text || '').trim()
  tomatoLiveText = t
  if (tray) { try { tray.setToolTip(i18nM.mt('appName') + (t ? ' · ' + t : '')) } catch (e) { /* empty */ } }
}

/* ================= Tray quit with focus-in-progress confirmation ================= */
async function quitFromTray () {
  // D10 (2026-09-27): re-entrancy guard — a second tray-quit click while the confirm dialog is // open used to enter again (two dialogs, two quit chains, quitByUser race). Rejected before the // first await.
  if (!quitFromTrayGuard.enter()) return
  try {
    return await quitFromTrayInner()
  } finally { quitFromTrayGuard.exit() }
}
async function quitFromTrayInner () {
  state.quitByUser = true
  // P2 2026-09-23: a running pomodoro used to die silently on tray-quit — the ledger only ever // records on completeFocus/giveUp, so the in-progress session vanished with no confirm and no // record. Ask before tearing everything down (the tray stays alive until confirmed).
  // TQ-1 (2026-10-03): the confirm gate now consults the DURABLE 'tomatoRunningSession' meta row // (written by every renderer FSM transition, main or float window), not the tray-text lease. // The lease (tomatoLiveText) was a display artifact: a throttled/crashed renderer let a live
  // focus quit with no confirm, and a float-originated focus never refreshed the lease at all // (update-tomato-taskbar is main-window-gated). The lease remains for the tooltip detail text // only; isLiveTextFresh stays exported for its lease-semantics unit tests.
  const sessionLive = tomatoSession ? tomatoSession.hasRunningSession() : false
  if (sessionLive) {
    try {
      const { dialog } = require('electron')
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: i18nM.mt('quitFocusActiveTitle'),
        message: i18nM.mt('quitFocusActiveTitle'),
        detail: i18nM.mt('quitFocusActiveMsg') + '\n\n' + tomatoLiveText,
        buttons: [i18nM.mt('quitFocusQuit'), i18nM.mt('quitFocusCancel')],
        cancelId: 1,
        defaultId: 1,
        noLink: true,
      })
      if (response !== 0) { state.quitByUser = false; return } // cancelled: restore quit intent
    } catch (e) { log.warn('[Tray] quit confirm dialog failed, proceeding with quit', e) }
  }
  // win can be a DESTROYED instance here (closeActionMinimize=false destroys the window on X but only // createMainWindow reassigns the module var) — getBounds on it throws "Object has been destroyed" and // kills the whole quit chain. Route through the live-window guard.
  const qw = getMainWindow()
  // P1 2026-09-12: writeConfig here used to run bare — a disk-full/locked config.json threw straight // out of the tray-menu click handler. The tray was already destroyed below, so the quit died // mid-chain leaving a zombie process (no window, no tray). Same try-wrap as windows.js close path.
  if (qw) { try { writeConfig({ winBounds: qw.getBounds() }) } catch (err) { log.warn('[Tray] winBounds 写入失败(退出路径)', err) } }
  // Destroy the tray icon first: the icon only disappears on Windows when the process exits, // while the quit path (renderer flush + scheduler persist + WAL close) can take seconds — without this, the icon lingers and reads as "quit is slow"
  if (tray) { try { tray.destroy() } catch (e) { /* empty */ } tray = null }
  app.quit()
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

/* ================= Custom protocol privileges (must run before ready) ================= */
{
  const { protocol } = require('electron')
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: 'local', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

/* ================= Single-instance lock & startup ================= */
// D10: true only for the singleton-lock WINNER after full startup. Declared before its first
// assignment below — the duplicate instance's app.quit() used to run the whole will-quit flush
// chain (preventDefault + quitAck + 500ms floor before a no-op flushNow) with a null db handle
// and no windows.
let ranFullInit = false
// Multi-instance opt-in (2026-10-01, src/main/multi-instance.js): PICKDONE_MULTI=1 scopes the
// singleton lock per data dir — the lock file lives in userData, and app.setPath('userData',
// TODO_USER_DATA_DIR) already ran at module top, so instances with different data dirs hold
// independent locks. Default (no env) passes NO arguments: byte-identical to the historical call.
const multiInstance = require('./multi-instance')
// Retry launches pause briefly before the lock request: the previous instance's dying
// process tree needs a moment to release the singleton mutex. Default launches: no delay.
if (multiInstance.preLockDelayMs(process.argv)) multiInstance.sleepSync(multiInstance.preLockDelayMs(process.argv))
// Multi mode only: wait out a stale singleton lockfile (the killed instance's crashpad
// handler holds <userData>/lockfile for ~10s after a hard kill; every launch inside that
// window fails the lock and used to quit silently). A live holder keeps the file held for
// its whole lifetime, so this times out into the normal (denying) lock request.
if (multiInstance.isMultiEnabled(process.env)) {
  const stale = multiInstance.clearStaleSingletonLockFileSync(app.getPath('userData'))
  if (!stale.cleared) {
    process.stderr.write('[MultiInstance] singleton lockfile still held after ' + stale.waitedMs + 'ms — requesting lock anyway\n')
  }
}
const __multiLockArgs = multiInstance.lockRequestArgs(process.env, app.getPath('userData'))
if (!app.requestSingleInstanceLock(...__multiLockArgs)) {
  // A lock denied right after a hard kill is usually a stale holder (dying child
  // processes), and Electron caches the failed request, so an in-process retry never
  // succeeds. Opt-in multi mode relaunches itself (bounded by --pickdone-lock-retry)
  // so a crash-restart wins the lock; a real same-dir duplicate still terminates.
  // Default (non-multi) mode keeps the historical instant quit.
  if (multiInstance.shouldRelaunchOnLockLoss(process.env, process.argv)) {
    // stderr, not electron-log: this runs pre-ready, before the file transport exists.
    process.stderr.write('[MultiInstance] singleton lock denied — relaunching (attempt ' +
      (multiInstance.lockRetryCount(process.argv) + 1) + '/' + multiInstance.LOCK_RETRY_MAX + ')\n')
    app.relaunch({ args: multiInstance.relaunchArgv(process.argv, multiInstance.lockRetryCount(process.argv) + 1, process.cwd()) })
  } else {
    process.stderr.write('[MultiInstance] singleton lock denied — giving up\n')
  }
  app.quit()
} else {
  // D10 (2026-09-27): singleton-lock winner — only this instance may run the will-quit flush chain
  // (the duplicate's app.quit() has no DB and no windows; see shouldRunQuitFlush in will-quit).
  ranFullInit = true
  // Round-3 stability (2026-09-26): show() deferred until whenReady during cold-start init — a
  // BrowserWindow before ready hard-throws (see second-instance-gate.js).
  require('./second-instance-gate').wireSecondInstance(app, () => { showMainOrLock() })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null) // project baseline has no menu bar
    // 账本广播挂 db 层钩子(非 IPC handler):CLI 是独立进程直写 DB,不经过本进程 IPC,
    // 只有 db.call 统一出口能同时覆盖 App IPC 与外部写入后的通知(2026-09-04 实锤修复)
    dbm.setLedgerChangedHook(op => broadcastTomatoRecordsChanged(op))
    // P2 (dw wave5 2026-09-24): the plain-bak residue precheck and the pending-delete sweep are
    // pure fs over userData — sunk into dbRecovery.cjs (this module's declared home for startup
    // recovery, testable without electron); whenReady keeps one-line calls. Behavior unchanged:
    // 无 todos.db 但 .plain-bak 存在 = 加密迁移两步 rename 间崩溃的'两头都没有'窗口(2026-09-04 深审 P0),
    // 必须在此显式把 plain-bak 放回去;pending-delete-<ts>-* 是上次「重置数据」被占用改名挂起的文件。
    dbRecovery.preflightMigrateResidue(app.getPath('userData'), log)
    dbRecovery.sweepPendingDeletes(app.getPath('userData'), log)
    try {
      dbm.init(app.getPath('userData'))
    } catch (e0) {
      log.error('[Init] DB 初始化失败：', e0)
      // D18 (2026-10-02): a transiently locked db.key (AV/indexer EPERM/EBUSY) fails init with
      // code DB_KEY_TRANSIENT_UNREADABLE while the DATABASE itself is healthy. Never enter the
      // recovery flow (rename/reset) for it: wait the lock out with a bounded sync backoff and
      // retry init once; only a lock persisting past that surfaces the dedicated dialog below
      // (no recovery rename, no reset-data button — resetting would destroy a healthy db).
      let e = e0
      if (e0 && e0.code === 'DB_KEY_TRANSIENT_UNREADABLE') {
        const keySleep = require('./db-key-read').sleepSync
        keySleep(500); keySleep(500)
        try { dbm.init(app.getPath('userData')); e = null } catch (e2) { e = e2 }
        if (!e) log.info('[Init] db.key lock cleared — init succeeded on retry (no recovery performed)')
      }
      if (e) {
      const { dialog, shell } = require('electron')
      const ud = app.getPath('userData')
      // D18: a db.key lock persisting past the retry is still NOT corruption — surface a
      // dedicated dialog WITHOUT the reset-data button instead of the recovery flow.
      if (e.code === 'DB_KEY_TRANSIENT_UNREADABLE') {
        dialog.showMessageBoxSync({
          type: 'error', title: i18nM.mt('appName'), message: i18nM.mt('dbFailMessage'),
          detail: e.message + ' — db.key is held by another process (antivirus/sync tool); the database itself is intact. Close the locking program and relaunch the app.',
          buttons: [i18nM.mt('btnOpenDataDirBackup'), i18nM.mt('btnQuit')], defaultId: 0, cancelId: 1
        })
        shell.openPath(ud)
        app.quit()
        return
      }
      // P2 2026-09-19: pass the retry hook — attemptDbRecovery now verifies the SQLite header magic
      // first and retries init once before renaming anything, so a healthy DB can no longer be
      // mislabeled .corrupt by a transient init failure (lock held / WAL race).
      const recoveredFrom = attemptDbRecovery(ud, () => dbm.init(ud))
      // P1 2026-09-20: source 'error' = the corrupt file could NOT be quarantined (rename failed,
      // e.g. AV/lock held) and NO backup was copied — treat it as NOT recovered so the dialog does
      // not loop on a false "recovered, relaunch" path; the label explains the actual failure.
      const recoveryFailed = !!(recoveredFrom && recoveredFrom.source === 'error')
      if (recoveryFailed) log.error('[Init] DB recovery aborted:', recoveredFrom.label)
      const recovered = recoveredFrom && !recoveryFailed
      if (recoveredFrom && (recoveredFrom.source === 'retry-ok' || recoveredFrom.source === 'transient')) {
        log.warn('[Init] DB init transient failure (header intact, no rename):', recoveredFrom.label)
      }
      let reinitErr = null
      try { dbm.init(ud) } catch (e2) { reinitErr = e2 }
      let restoredN = 0
      // Sync-3 (D12): per-segment success report — the plain-bak cleanup gate needs to know that
      // EVERY segment of the snapshot was consumed, not just that todoState imported rows.
      let restoreFullyConsumed = false
      // source is a structured branch flag; display copy must never drive logic (dbRecovery.cjs contract)
      // jsonRestoreAllowed gates on the re-init having succeeded: with a dead DB (e.g. the vendor
      // driver itself cannot load) every busCommit in the restore path throws and the "restore"
      // rebuilds nothing (2026-09-26 lubancat live catch; gate = dbRecovery.jsonRestoreAllowed).
      if (dbRecovery.jsonRestoreAllowed(recoveredFrom, reinitErr)) {
        const restored = restoreFromCriticalBackup(ud)
        restoredN = restored.tasks
        restoreFullyConsumed = !!restored.proved
        // GAP-D fix (2026-09-19): recovery writes go through dbm.call directly with no sync kick —
        // restored rows waited for the periodic round. Boot-time kick is safe: kickSyncRound no-ops
        // while the sync node is not initialized.
        try { require('./lan-sync-bootstrap').kickSyncRound('db-recovery') } catch { /* sync lazy-not-init */ }
      }
      // Sync-4/Sync-17 (D12): recovery-pending sentinel lifecycle. When a parseable critical
      // backup is still on disk but the restore could NOT consume it (re-init failed → the
      // jsonRestoreAllowed gate blocked the restore = Sync-17; or segments failed/stayed
      // unconsumed = Sync-4's crash twin), mark the sentinel so the NEXT boot's attemptDbRecovery
      // treats the resulting healthy-header empty shell as re-coverable instead of answering
      // 'transient' forever. A proved restore (or any non-replayable state) clears it — no loop.
      // This MUST sit outside the jsonRestoreAllowed gate: the gate is exactly what blocks the
      // restore on reinitErr (Sync-17), and that is one of the two states the sentinel exists for.
      const jsonSnapshotUsable = !!(recoveredFrom && recoveredFrom.source === 'json' &&
        dbRecovery.backupJsonParseable(dbRecovery.criticalBackupPath(ud)))
      const snapshotConsumed = jsonSnapshotUsable && !reinitErr && restoreFullyConsumed
      if (jsonSnapshotUsable && !snapshotConsumed) {
        dbRecovery.markRecoveryPending(ud, { reason: reinitErr ? 'json-restore-blocked' : 'json-restore-unconsumed' })
        log.warn('[Init] recovery-pending sentinel written: parseable critical backup left unconsumed — next boot will replay the restore')
      } else {
        dbRecovery.clearRecoveryPending(ud)
      }
      // P1-6 (2026-09-19 data-safety round) / round-1 P0 (2026-09-21): ANY recovery that replaced
      // the DB file ('json' restore AND 'plain-bak' copy) rebuilt it in an OLDER oplog seq space —
      // stale persisted peer watermarks would sit above the restored rows and they would never be
      // re-pushed. Invalidate AFTER the recovery writes complete so the next round re-pushes the
      // full window to every peer (merge-apply is idempotent) and peers re-snapshot anything
      // already pruned from the rebuilt oplog. (Previously wired only on the 'json' branch — a
      // plain-bak restore kept stale watermarks and restored rows never reached peers.)
      if (recovered && (recoveredFrom.source === 'json' || recoveredFrom.source === 'plain-bak')) {
        try { require('./lan-sync-bootstrap').invalidateSyncWatermarks('db-recovery:' + recoveredFrom.source) } catch { /* sync lazy-not-init */ }
      }
      const detailMsg = String(e && e.message || e) + '.' + (recoveryFailed
        ? ' ' + recoveredFrom.label
        : recoveredFrom
          ? i18nM.mt('dbFailRecovered', { n: restoredN })
          : i18nM.mt('dbFailRecoveredNone')) + (reinitErr ? i18nM.mt('dbFailReinit', { msg: reinitErr.message }) : '')
      const buttons = recovered
        ? [i18nM.mt('btnRecoverRelaunch'), i18nM.mt('btnOpenDataDir'), i18nM.mt('btnQuit')]
        : [i18nM.mt('btnOpenDataDirBackup'), i18nM.mt('btnResetRelaunch'), i18nM.mt('btnQuit')]
      const choice = dialog.showMessageBoxSync({
        type: 'error', title: i18nM.mt('appName'), message: i18nM.mt('dbFailMessage'),
        detail: detailMsg, buttons, defaultId: 0, cancelId: buttons.length - 1
      })
      // app.exit does not trigger will-quit: the relaunch path must explicitly unregister system hotkeys (otherwise the new instance misreports registration conflicts)
      const relaunchClean = () => { app.relaunch(); shortcuts.unregisterAll(); app.exit(0) }
      // P1 fix (2026-09-25): the branch chain is driven by the pure (recovered, choice) → action map
      // in dbRecovery.recoveryDialogAction. The recovered choice===1 button ("open data dir") used to
      // only app.quit() — shell.openPath was never called on that branch.
      const dialogAction = dbRecovery.recoveryDialogAction(recovered, choice)
      if (dialogAction === 'relaunch') {
        // P2 2026-09-12: the recovery-succeeded relaunch branch skipped the plain-bak cleanup that the
        // init-success path below does — after recovery the plaintext copy stayed in userData forever,
        // defeating at-rest encryption. Clear it before relaunching (same semantics, best-effort).
        // P1 (R4 2026-09-21): cleanup is now gated on an ACTUAL restore. The restore swallows
        // per-step errors — the old unconditional delete destroyed the last usable backup
        // (todos.db.plain-bak) whenever the JSON restore imported nothing. Only the 'json' branch
        // with restoredN > 0 AND a fully-consumed snapshot (Sync-3: every segment imported) proves
        // the DB was really rebuilt with current data, so only that branch may drop the bak.
        const jsonRestoreProved = recoveredFrom.source === 'json' && restoredN > 0 && restoreFullyConsumed
        const pb = path.join(ud, 'todos.db.plain-bak')
        if (jsonRestoreProved) {
          try {
            if (fs.existsSync(pb)) { fs.rmSync(pb, { force: true }); log.info('[Init] 恢复成功重启前清除明文残留 todos.db.plain-bak') }
          } catch (e0) { log.warn('[Init] plain-bak 清理失败(relaunch 前)', e0) }
        } else if (fs.existsSync(pb)) {
          log.warn('[Init] plain-bak 保留:恢复未证实导入任何数据行 (source=' + recoveredFrom.source + ', restoredN=' + restoredN + '),最后的备份不可删除')
        }
        relaunchClean()
      }
      else if (dialogAction === 'open-data-dir') { shell.openPath(ud); app.quit() }
      else if (dialogAction === 'reset-and-relaunch') {
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
      } // if (e) — D18: the transient db.key retry path above skips this whole recovery block
    }
    // init 成功(加密库正常打开)=迁移自愈窗口已关闭:立刻删除 .plain-bak 明文残留,否则用户的
    // 全部任务/账本永远留一份明文拷贝在 userData,at-rest 加密被整体架空(2026-09-05 二轮深审 P1-1)
    // mig-restore-sentinel-cleared-before-consumer (P2, symptom of "sentinel lifecycle keyed to
    // init-failure instead of to DB emptiness"): the sentinel used to be cleared unconditionally
    // here while the replay it stands for only ever ran inside the init-failure catch — a crash in
    // that window left a parseable critical backup stranded behind a cleared sentinel. Now the
    // success path re-evaluates the replay gate BEFORE clearing, runs the replay in the same boot
    // (before createMainWindow/scheduler reload), and mirrors the catch-path follow-ups (sync kick
    // + watermark invalidation) so restored rows reach peers. The plain-bak cleanup below is
    // skipped while an unproved replay leaves the snapshot unconsumed (keep the last copy).
    // Known unrecoverable window (stated, follow-up for crash-atomicity): a hard crash between the
    // re-init inside the catch block and the markRecoveryPending write still strands the state.
    const __ud = app.getPath('userData')
    const replayDecision = dbRecovery.cleanInitReplayDecision(__ud)
    let replayProved = true
    if (replayDecision.replay) {
      log.warn('[Init] recovery-pending sentinel + parseable critical backup survived into a successful init — replaying the JSON restore before the window/scheduler come up')
      let restored = null
      try { restored = restoreFromCriticalBackup(__ud) } catch (e1) { log.error('[Init] recovery replay failed:', e1 && e1.message || e1) }
      replayProved = !!(restored && restored.proved)
      // Mirror the catch-path GAP-D kick: restored rows must not wait for the periodic sync round.
      try { require('./lan-sync-bootstrap').kickSyncRound('db-recovery-replay') } catch { /* sync lazy-not-init */ }
      // Post-recovery watermark invalidation (mirror of the catch path): the replay rebuilt rows in
      // an older oplog seq space — stale peer watermarks would sit above them forever otherwise.
      try { require('./lan-sync-bootstrap').invalidateSyncWatermarks('db-recovery-replay') } catch { /* sync lazy-not-init */ }
      if (replayProved) {
        dbRecovery.clearRecoveryPending(__ud)
        log.info('[Init] recovery replay consumed the snapshot provably — sentinel cleared')
      } else {
        log.error('[Init] recovery replay did NOT provably consume the snapshot — recovery-pending sentinel kept for the next boot')
      }
    }
    try {
      const pb = path.join(__ud, 'todos.db.plain-bak')
      const replayBlocking = replayDecision.replay && !replayProved
      if (fs.existsSync(pb) && replayBlocking) {
        log.warn('[Init] plain-bak 保留:recovery replay 未证实消费快照,最后的备份不可删除')
      } else if (fs.existsSync(pb)) {
        fs.rmSync(pb, { force: true }); log.info('[Init] 加密库启动正常,已清除明文残留 todos.db.plain-bak')
      }
    } catch (e0) { log.warn('[Init] plain-bak 清理失败', e0) }
    // A clean init with NO replayable state means any sentinel is stale (either the replay already
    // ran or there is nothing left to replay) — clear it. With a replay pending, the block above
    // owns the lifecycle (clear on proved, keep on unproved).
    if (!replayDecision.replay) { try { dbRecovery.clearRecoveryPending(__ud) } catch { /* best-effort */ } }
    // TQ-1 (2026-10-03): startup reconciliation — a focus whose renderer died (crash / hard kill /
    // throttled death without a terminal transition) left a durable 'tomatoRunningSession' row.
    // Book-or-void from that row instead of trusting the renderer's silent localStorage
    // voidExpired: the phase is recorded (idempotent deterministic id) or explicitly voided,
    // never silently dropped. Runs before any window comes up.
    try {
      if (!tomatoSession) {
        tomatoSession = require('./tomato-session').createTomatoSession({
          call: (op, p) => dbm.call(op, p), log
        })
      }
      tomatoSession.reconcile()
    } catch (e) { log.warn('[TomatoSession] startup reconcile skipped:', e && e.message) }
    handleAppProtocol()
    createMainWindow()
    const win = getMainWindow()
    tomatoTaskbar.init(win) // taskbar progress/title countdown/thumbnail toolbar (pomodoro, Windows native)
    createTray()
    scheduler.setSoundFile(path.join(__dirname, '../../assets/media/confirm1.ogg'))
    scheduler.setShowMainEntry(showMainOrLock) // D10: reminder notification clicks honor the security lock
    registerIpc()
    extWatch.watchDbForExternalWrites()
    // Perf (2026-10-02): reloadAll + Meta GC moved AFTER registerIpc/extWatch — they used to run
    // before the IPC/bus wiring, blocking the window-ready path on synchronous GC work. No
    // behavior change: registerIpc is synchronous wiring, reloadAll's fingerprint gate
    // (scheduler.js) makes re-entry safe, and the bus fanout hooks are wired by the time the GC
    // commits run (strictly better peer propagation).
    scheduler.reloadAll(dbApi())
    // Meta GC: clean up orphan keys (residue after a repeat rule is deleted / project deadline & milestones become permanent orphans after a category is deleted)
    try {
      // P1 2026-09-19: getAll({deleted:null}) included recycle-bin rows, so a repeatId referenced
      // only by a deleted task kept its repeatRule: meta forever (never GC'd). Only LIVE rows keep
      // a rule alive — deleted:0. Decision logic extracted to handlers/shared.computeMetaGc for tests.
      const { computeMetaGc } = require('./handlers/shared')
      // D19-DOM1: tomatoRunAnnounce family rule inputs — the paired-device set (from the LAN sync
      // bootstrap's peer table) plus OUR own id (our announce row is never GC-able). On any read
      // failure the option stays undefined and the family rule is inert (nothing deleted).
      let pairedDeviceIds, ownDeviceId
      try {
        const lanSync = require('./lan-sync-bootstrap')
        pairedDeviceIds = new Set(lanSync.loadPairedPeers().map(p => String((p && p.deviceId) || '')))
        ownDeviceId = lanSync.ensureIdentity().deviceId
      } catch { /* sync module/settings read unavailable: family rule inert */ }
      for (const k of computeMetaGc(dbm.call('listMetaKeys'), dbm.call('getAllCategories'), dbm.call('getAll', { deleted: 0 }), { pairedDeviceIds, ownDeviceId })) {
        require('./command-bus').commit('meta', 'delete', k, { preserveStamp: true }) // Phase-2: GC via the bus
      }
      // D6 P2 (2026-09-21): historical note — the GC loop used to run BEFORE registerIpc wired the
      // bus fanout hooks, so an explicit sync kick was needed. The GC now runs after the wiring;
      // the kick is retained as a belt-and-suspenders no-op while sync is lazy-not-initialized.
      try { require('./lan-sync-bootstrap').kickSyncRound('meta-gc') } catch { /* sync lazy-not-init */ }
    } catch (e) { log.warn('[MetaGC] skipped:', e && e.message) }
    // P3a LAN sync (lazy; never auto-enables — see lan-sync-bootstrap.js header)
    require('./lan-sync-bootstrap').initLanSync({
      db: dbm,
      getWindowSenders: () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => w.webContents),
      // P0-1 (2026-09-19 UX review): after applying inbound rows, LAN sync re-baselines the
      // external-write watcher — its own WAL writes must not surface as "CLI wrote" and fire a
      // second, undo-stack-wiping full reload on top of the targeted lan-sync-apply broadcast.
      resyncExternalWatch: () => extWatch.resyncExternalWatch(),
    })

    // Auto-update: init the event bridge + delayed silent check (does not compete with startup; degrades automatically in non-update environments)
    updater.init(win)
    setTimeout(() => { updater.check().then(r => { if (r.active) log.info('[Updater]', r.status) }).catch(() => {}) }, 8000)
    // Periodic re-check for resident instances (4h): users who go long without restarting still get the new-version notice within the current session
    setInterval(() => { updater.check().catch(() => {}) }, 4 * 60 * 60 * 1000).unref?.()

    // Global shortcuts (shortcut settings stored in config.json)
    applyShortcuts(readConfig().shortcutKeySettings)

    // Round-3 stability (2026-09-26): surface a quarantined corrupt config.json to the user (notice-only)
    require('./quarantine-notice').showQuarantineNotice(win, log)

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
// D10 (2026-09-27): quit-chain guards (extracted to quit-guards.js for plain-node testability).
const { createHangFallback, createReentrancyGuard, shouldRunQuitFlush } = require('./quit-guards')
// D10 (2026-09-27): the 3s hang fallback is armed BEFORE the awaited flush steps (see flushNow) —
// the old code created it only after the sync stop / dbm.close() resolved, so a never-settling
// await left the windowless process hung forever with no timer.
const quitHangFallback = createHangFallback({
  timeoutMs: 3000,
  onExit: () => {
    // Hang fallback only; normally unreachable. app.exit() bypasses the quit event entirely, so
    // electron-updater's autoInstallOnAppQuit would silently SKIP a pending update. When an update
    // is ready, hand off to quitAndInstall() instead; only hard-exit when nothing is pending (or
    // the handoff is refused, e.g. portable builds where quitAndInstall returns false).
    try { if (updater.getStatus().status === 'ready' && updater.quitAndInstall()) return } catch { /* fall through to the hard exit */ }
    try { app.exit(0) } catch {}
  }
})
// D10 (2026-09-27): quitFromTray re-entrancy guard — a second tray-quit click while the confirm
// dialog is open used to open a second dialog and race quitByUser.
const quitFromTrayGuard = createReentrancyGuard()
// Flush-ack handshake (2026-09-11 P1): the old fixed 500ms window raced the renderer's fire-and-forget
// dbMirror invokes (.catch(()=>{})) — late writes were silently dropped after dbm.close(). before-quit
// broadcasts 'app-quitting-flush' with a token; the renderer acks via 'app-quitting-flush-ack' after its
// flush invokes are dispatched; will-quit holds the quit until every live window acked or ≤2s elapsed
// (bounded, so a hung renderer can never block quitting). The two-phase will-quit (flushDone passthrough
// for updater's autoInstallOnAppQuit) is unchanged.
const quitAckModule = require('./quit-ack')
const quitAck = quitAckModule.createQuitAckTracker()
// webContents -> latest 'destroyed'/'render-process-gone' abandon closure (WeakMap: dying senders GC freely)
const quitAckGone = new WeakMap()
app.on('before-quit', () => {
  // Second pass (the re-issued app.quit() below): the DB is already closed, re-broadcasting the flush
  // would only be a dead letter — renderer invokes would fail against a closed handle.
  // TQ-7 (2026-10-03): the singleton-winner-only quit-chain invariant is now enforced by ONE shared
  // predicate in BOTH chained quit phases. before-quit used to guard on flushDone alone while
  // will-quit consulted shouldRunQuitFlush({ranFullInit,...}) — the acting phase was the unguarded
  // one, so any side effect added here (announceIdleForQuit, shipQuitRound, flush broadcast, and
  // state.quitByUser itself) executed in a singleton-lock loser the will-quit guard explicitly
  // declares must not run the chain. Split-guard root removed: one predicate, both phases.
  if (!shouldRunQuitFlush({ ranFullInit, flushDone, quitting })) return
  state.quitByUser = true
  // Running-tomato announcement: flip this device's announce to idle BEFORE the sync node stops
  // (P1-7 2026-09-19 UX review: the old order ran stopSyncForQuit first, so the idle write's
  // kickSyncRound hit a dead node — the announce sat locally until the DB closed and peers showed
  // our countdown for up to the 5-minute round/TTL window as ghosts). The write is local meta and
  // synchronous (db.call); the kick ships it in a final best-effort round, and the peers' TTL rule
  // still covers a crash where the round never completes.
  try { require('./tomato-announce').announceIdleForQuit() } catch { /* announce never initialized */ }
  // R7-B P2: ship the idle announce with an IMMEDIATE round. stopSyncForQuit used to run here,
  // killing the node before the debounced kick fired, so the announce sat locally and peers
  // showed our countdown as ghosts for up to the TTL window. The node now stops inside the
  // will-quit flush window (flushNow), giving this round 500ms-2s of real runway.
  try { require('./lan-sync-bootstrap').shipQuitRound() } catch { /* sync never initialized */ }
  // Stop the LAN sync node (round timers + TCP server + retry timers) BEFORE the quit-flush window
  // closes the DB. Fire-and-forget: stopSync kicks the async server close off immediately and the
  // bootstrap's settings persists (peer watermarks / security log) run synchronously via db.call,
  // so nothing of sync's outlives the will-quit DB close (2026-09-18 P2 lifecycle fix).
  // Before quitting, broadcast the renderer flush of debounced mirrors (the last write within dbMirror's 2s / disaster-snapshot 800ms window would be silently lost)
  // 2026-09-10 P1: previously only the main window was notified — the float window's pending pomodoro
  // ledger (and the whole broadcast when the main window was already destroyed, e.g. X-close→tray→quit)
  // was silently lost. Broadcast to every live window with an isDestroyed guard.
  // P2 2026-09-19: this is now the exact expected-set (webContents ids) rather than a count —
  // beginRound takes the array so only these senders' acks can satisfy allAcked().
  const liveWindows = []
  // P2 2026-09-12: Date.now() tokens collide within the same millisecond — a stale ack from a previous
  // round could then satisfy (token !== prevToken no longer holds) and cut the flush window short.
  // quit-ack now guarantees strictly increasing tokens across rounds.
  const roundToken = quitAck.nextToken()
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w && !w.isDestroyed()) {
        w.webContents.send('app-quitting-flush', { token: roundToken })
        liveWindows.push(w.webContents.id)
        // P2 2026-09-12: a window destroyed between this send and its ack can never ack, so the
        // flush window previously waited out the full 2s cap every time a window died mid-handshake.
        // When the webContents is destroyed (window closed) or its renderer process is gone (crash —
        // it can never ack either), abandon the sender so allAcked() can go true early. Idempotent
        // via the tracker's abandoned set; acks from still-live windows are unaffected.
        const senderId = w.webContents.id
        // P3 2026-09-12: before-quit can fire more than once (aborted round → re-issued quit), and
        // blind once() attaches then accumulated one dead closure pair per round on long-lived
        // webContents. Keep the latest onGone per webContents in a WeakMap and remove it before
        // re-attaching, so each sender holds at most one live pair.
        const prev = quitAckGone.get(w.webContents)
        if (prev) {
          w.webContents.removeListener('destroyed', prev)
          w.webContents.removeListener('render-process-gone', prev)
        }
        const onGone = () => { try { quitAck.abandon(senderId) } catch { /* dying process */ } }
        quitAckGone.set(w.webContents, onGone)
        w.webContents.once('destroyed', onGone)
        w.webContents.once('render-process-gone', onGone)
      }
    } catch {}
  }
  // Pass the exact expected-sender set: an ack from a sender we never sent to can never satisfy
  // allAcked() (quit-ack P2 2026-09-19).
  quitAck.beginRound(liveWindows, roundToken)
})
app.on('window-all-closed', e => { /* stay resident in the tray, do not quit */ })
app.on('will-quit', (event) => {
  /* P0 quit-flush race (2026-09-09): before-quit only fire-and-forgets 'app-quitting-flush' while the
     old will-quit closed the DB immediately — renderer invokes still inside the dbMirror 2s debounce
     (pending edits / pomodoro ledger) arrived after dbm.close() and were silently dropped.
     Fix: first will-quit preventDefaults and holds the quit open for a bounded flush window; when done it
     flushes scheduler state and closes the DB, then re-issues app.quit() with flushDone=true so the
     second will-quit is NOT prevented — the native `quit` event must fire because electron-updater's
     autoInstallOnAppQuit installs on quit, and app.exit() would skip it entirely (2026-09-09 review).
     app.exit(0) below is only a hang fallback if the re-issued quit is somehow swallowed again.
     2026-09-11 P1: the window is no longer a fixed 500ms — we wait for the renderer's flush ack
     ('app-quitting-flush-ack', sent after its flush invokes are dispatched) from every live window,
     capped at 2s total so a hung renderer cannot block quitting. 500ms remains the floor (renderer
     needs a beat to dispatch the debounced writes at all).
     Verification path: tray → quit and window-X → quit both run before-quit → will-quit(preventDefault) →
     flush window → flush+close → app.quit() → will-quit(passthrough) → quit event; process must exit
     exactly once with no lingering tray icon. */
  if (flushDone) return // passthrough: let the native quit (and updater install) proceed
  // D10 (2026-09-27): a second-instance (singleton-lock loser) has no DB, no windows, nothing to
  // flush — pass the quit straight through instead of running the full preventDefault + quitAck +
  // 500ms-floor chain against a null db handle. (Pure decision unit-tested in quit-guards tests.)
  if (!shouldRunQuitFlush({ ranFullInit, flushDone, quitting })) return
  if (quitting) { event.preventDefault(); return }
  quitting = true
  extWatchGate.arm() // C11: disarm the external-write poll BEFORE the flush window opens
  event.preventDefault()
  const FLUSH_FLOOR_MS = 500
  const flushNow = async () => {
    // D10 (2026-09-27): arm the 3s hang fallback BEFORE any await — the old code registered it only
    // after the sync stop / dbm.close() resolved, so a never-settling await hung the process with
    // no exit timer at all.
    quitHangFallback.arm()
    try { extWatch.stopForQuit() } catch {} // release the fs.watchFile poll timers before closing
    try { shortcuts.unregisterAll() } catch {}
    // Persist the reminder dedup ledger synchronously (quitting inside the 60s debounce window → reminders resent after restart) + close the db handle (avoids losing one checkpoint and late handle release on Windows)
    try { scheduler.flushFiredNow() } catch {}
    // R7-B P2: the sync node stops here — after the flush window, before the DB handle closes.
    // Round-3 stability (2026-09-26): AWAIT the stop — the settle-point persists (security ring +
    // peer watermarks) run via db.call and must beat dbm.close(); fire-and-forget lost the
    // in-flight round's watermark confirmations.
    try { await require('./lan-sync-bootstrap').stopSyncForQuit() } catch { /* sync never initialized */ }
    // TQ-1 (2026-10-03): the quit is now committed (confirm resolved / will-quit teardown) — clear
    // the durable running-session row before the DB closes, so the next boot does not reconcile a
    // phase the user explicitly ended. A phase that survives only because a crash skipped this
    // line is exactly what startup reconciliation books-or-voids.
    try { if (tomatoSession) tomatoSession.clear() } catch { /* best-effort */ }
    try { if (dbm && dbm.close) dbm.close() } catch {}
    flushDone = true
    app.quit()
    // D10 (2026-09-27): the hang fallback armed at flushNow entry STAYS armed through the re-issued
    // quit — it is exactly the old 3s "quit was swallowed again" backstop, now guaranteed to exist
    // even when an awaited flush step never settles (the bug this fix closes).
  }
  // All acks already in (or no live window to wait for): keep the old fast path
  const allAcked = () => quitAck.allAcked()
  if (allAcked()) { setTimeout(flushNow, FLUSH_FLOOR_MS); return }
  // P2 (dw wave5 2026-09-24): the 50ms poll loop was a hand-rolled copy of the same round logic
  // updater.js carried (with a drifted cap); it moved into quit-ack.awaitFlushAcks — the shared
  // bounded wait. Broadcast+abandon wiring stays in before-quit above; lifecycle teardown stays
  // in flushNow. Cap unified on quit-ack.FLUSH_ACK_CAP_MS (2000ms).
  quitAckModule.awaitFlushAcks({ tracker: quitAck, flushMain: () => { if (!flushDone) flushNow() } })
})

/* ================= Full IPC registration (channel names aligned with the project baseline) =================
   Handlers are split by domain into handlers/*.js modules; each exports (ctx) => ({ channel: fn }).
   This file stays the assembly point: ctx injection + Object.assign merge + the unified error-wrap loop. */
function registerIpc () {
  // App-side audit trail (src/main/audit.js) resolves its JSONL path lazily; wire it to the real userData
  // here so app.setPath('userData', TODO_USER_DATA_DIR) test isolation is honored
  appAudit.setDirResolver(() => app.getPath('userData'))

  // Shared context injected into every handler domain (argument injection only — handler modules never require index.js)
  const hctx = {
    app, readConfig, writeConfig, i18n: i18nM, log,
    dbm, dbApi, scheduler,
    // TQ-1: durable running-session tracker (created lazily here; the startup reconcile above
    // may have created it first — share the one instance).
    get tomatoSession () {
      if (!tomatoSession) {
        tomatoSession = require('./tomato-session').createTomatoSession({ call: (op, p) => dbm.call(op, p), log })
      }
      return tomatoSession
    },
    getMainWindow, showMainOrLock,
    isLocked, isLockWindow, lockAppNow, unlockAppNow, verifyLockPassword, allowWithinRate,
    isSafeExternal, attachDir,
    resyncDbWatch: () => extWatch.currentResyncDbWatch(),
    notifySyncChange: op => { try { require('./lan-sync-bootstrap').kickSyncRound('local-write:' + op) } catch { /* sync lazy-not-init */ } },
    broadcastTomatoRecordsChanged, broadcastTodosChanged, broadcastWhiteNoiseUpdated,
    rebuildTrayMenu, getTray: () => tray, updateTomatoTray,
    applyShortcuts
    // NOTE: no `getState` here — none of the 9 handler modules read app state
    // (verified 2026-09-12); windowManager keeps its own getState for tray-close
    // behavior. Re-add only with a concrete handler consumer.
  }

  const handlers = Object.assign({},
    require('./handlers/todo')(hctx),
    require('./handlers/settings')(hctx),
    require('./handlers/security')(hctx),
    require('./handlers/backup')(hctx),
    require('./handlers/attachments')(hctx),
    require('./handlers/csv-import')(hctx),
    require('./handlers/tomato')(hctx),
    require('./handlers/system')(hctx)
  )
  // Flush-ack handshake receiver (see will-quit): renderer sends this after dispatching its debounced
  // flush writes on app-quitting-flush. fire-and-forget (ipcMain.on, not handle) — the main process is
  // on its way out and must not throw back into a dying renderer.
  ipcMain.on('app-quitting-flush-ack', (e, payload) => {
    try {
      // Stale token acks (from a previous quit attempt that was aborted) must not satisfy this round
      if (payload && e && e.sender && quitAck.ack(payload.token, e.sender.id)) {
        log.info('[Quit] flush ack received', quitAck.progress())
        return
      }
      // P2 2026-09-19: an ack whose token belongs to the updater's EARLY flush round
      // (flushOnceOnReady) is stale for the quit round but must still reach that round's tracker,
      // or its allAcked() can never go true and the early flush always waits out its cap.
      try { updater.forwardFlushAck(payload && payload.token, e && e.sender && e.sender.id) } catch { /* best-effort */ }
    } catch { /* dying process — best effort */ }
  })
  // Unified error logging: handler throws are rethrown as-is (the renderer's invoke still rejects) while the main process leaves a trace —
  // previously, handlers throwing silently left no trace in main-process logs, making cross-window issues impossible to diagnose
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.handle(ch, async (e, ...args) => {
      try { return await fn(e, ...args) } catch (err) { log.error(`[IPC] ${ch}`, err); throw err }
    })
  }
}


module.exports = { getMainWindow }
