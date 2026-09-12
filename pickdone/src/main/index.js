/**
 * Main process entry — PickDone offline implementation
 * IPC channel names stay aligned with the project baseline, easing a later swap to a real cloud backend
 * Window lifecycle lives in windows.js; IPC handlers live in handlers/*.js — this file stays the
 * assembly point (wiring + unified handler error-wrap loop + tray + quit chain).
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, dialog } = require('electron')
// globalShortcut is required by quick-add/pomodoro-float and other modules (avoid duplicates)
const path = require('path')
// The renderer has no nodeIntegration; pass the real version to preload via env var (todoAPI.version)
process.env.APP_VERSION = app.getVersion()
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

let tray = null
const state = { quitByUser: false } // shared with windows.js close handler (was a module var in the pre-split index.js)

const { readConfig, writeConfig } = require('./config-store')

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
const securityLock = createSecurityLock({ getMainWindow, showMainOrLock, readConfig, writeConfig, i18n: i18nM, log })
const { isLocked, lockAppNow, unlockAppNow, verifyLockPassword, isLockWindow } = securityLock
const { allowWithinRate } = require('./security-lock') // pure sliding-window limiter for the notification channel
const { nextWatchBaseline } = require('./watch-baseline') // pure baseline update for the external-write watcher resync
quickAdd.setLockProbe(isLocked) // the global quick-add shortcut does not summon while the screen is locked (summoning = input silently lost)
const shortcuts = createShortcuts({ getMainWindow, showMainOrLock, quickAdd, i18n: i18nM, log })
const { applyShortcuts } = shortcuts

/* ---------------- Main window (factory lives in windows.js; this file wires shared deps) ---------------- */
const { createWindowManager } = require('./windows')
const windowManager = createWindowManager({
  readConfig, writeConfig, i18n: i18nM, log, windowRef, closeBehavior,
  tomatoTaskbar, updater, applyShortcuts, shortcuts, scheduler,
  isLocked, lockAppNow, showMainOrLock,
  isQuitting: () => quitting, getState: () => state, getTray: () => tray
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
function attemptDbRecovery (ud) { return dbRecovery.attemptDbRecovery(ud) }
function restoreTasksFromCriticalBackup (ud) { return dbRecovery.restoreTasksFromCriticalBackup(ud, list => dbm.call('upsertMany', list), c => dbm.call('upsertCategory', c), rows => dbm.call('tomatoAppendMany', rows)) }

/* ---------------- External-write listener: when the CLI writes the DB directly, the running App refreshes automatically ---------------- */
let resyncDbWatch = null // set by watchDbForExternalWrites: re-baselines lastMtime after OUR OWN db writes (P1 2026-09-11)
let stopDbWatch = null // set by watchDbForExternalWrites: unwatchFile both files on the quit chain (P2 2026-09-11)
function watchDbForExternalWrites () {
  const ud = app.getPath('userData')
  const dbFile = path.join(ud, 'todos.db')
  const walFile = dbFile + '-wal'
  // In WAL mode CLI writes only land in -wal and the main DB's mtime stays unchanged (once broke the 2s broadcast, leaving stale UI data); watch both files
  // Stat the baseline once first: starting lastMtime at 0 would make the first poll always kick, falsely reporting an "external write" right at startup
  let lastMtime = 0
  // P2 2026-09-12 torn read: two independent statSync calls raced a concurrent CLI wal write — the
  // baseline absorbed half a write (missed event) or saw a transient value (false external-write
  // reload). Take the value only when two consecutive reads agree (fix-util.stableRead); persistent
  // disagreement (extremely rare) yields null and this poll is skipped, the next one re-reads.
  const readWatchMtime = () => {
    const statOne = () => Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0)
    return fixUtil.stableRead(statOne)
  }
  lastMtime = readWatchMtime() || 0
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
      const winOk = getMainWindow() != null
      if (raw && raw !== lastTomatoCmdRaw && winOk && !isLocked()) {
        const cmd = JSON.parse(raw)
        lastTomatoCmdRaw = raw
        if (cmd && cmd.seq && cmd.seq > lastTomatoSeq) {
          lastTomatoSeq = cmd.seq
          // 账本类命令已退役为 CLI 直写行表(渲染端经 tomato-records-changed 回灌),本通道只剩状态类 start/stop/attach,只发主窗
          getMainWindow().webContents.send('cli-tomato-cmd', cmd)
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
          const win = getMainWindow()
          if (prev && win) {
            const patch = {}
            for (const k of Object.keys(doc)) {
              if (k === '_savedAt' || k === 'schemaV') continue
              if (JSON.stringify(doc[k]) !== JSON.stringify(prev[k])) patch[k] = doc[k]
            }
            if (Object.keys(patch).length) {
              delete patch.securityLockPassword
              delete patch.securityLockQuestion
              // P2 2026-09-11: hot-sync used to push only the main window — the float/quick-add windows
              // kept pre-CLI-change settings until restart (same all-windows pattern as the quit flush)
              for (const w of BrowserWindow.getAllWindows()) {
                try { if (w && !w.isDestroyed()) w.webContents.send('external-settings-changed', patch) } catch {}
              }
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
        lastMtime = readWatchMtime() ?? lastMtime
      } catch (e) { log.warn('[TodoDB] 外部写入刷新失败', e) }
    }, 500)
  }
  const onChange = () => {
    try {
      const m = readWatchMtime()
      if (m == null) return
      if (m === lastMtime) { forwardTomatoCmd(); return } // check commands even when mtime is unchanged (guards against watchFile dropping events)
      lastMtime = m
      kick()
      forwardTomatoCmd()
    } catch {}
  }
  fs.watchFile(dbFile, { interval: 2000 }, onChange)
  fs.watchFile(walFile, { interval: 2000 }, onChange)
  // P1 2026-09-11: App's own todo-db:call writes touch the -wal too, but the 500ms-debounced kick above
  // only re-baselines for the EXTERNAL-write path. Our own IPC writes left the baseline stale → the next
  // poll read them as "external" → full reload + undo-stack wipe ~3s after every local write (the
  // renderer's 1.5s suppression window cannot cover the 2-3s watcher latency). Re-baseline immediately
  // after every write-type todo-db:call so the next poll sees mtime === baseline.
  resyncDbWatch = () => { lastMtime = nextWatchBaseline(lastMtime, readWatchMtime) }
  // P2 2026-09-11: fs.watchFile never unwatched — poll timers kept the quit chain alive/lint-y; release them on quit
  stopDbWatch = () => {
    try { fs.unwatchFile(dbFile, onChange) } catch {}
    try { fs.unwatchFile(walFile, onChange) } catch {}
    resyncDbWatch = null
  }
}

/* ---------------- External-link safety: only http/https allowed ---------------- */
function isSafeExternal (url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

const attachments = require('./attachments')
const { attachDir } = attachments

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
    state.quitByUser = true
    // win can be a DESTROYED instance here (closeActionMinimize=false destroys the window on X but only
    // createMainWindow reassigns the module var) — getBounds on it throws "Object has been destroyed" and
    // kills the whole quit chain. Route through the live-window guard.
    const qw = getMainWindow()
    // P1 2026-09-12: writeConfig here used to run bare — a disk-full/locked config.json threw straight
    // out of the tray-menu click handler. The tray was already destroyed below, so the quit died
    // mid-chain leaving a zombie process (no window, no tray). Same try-wrap as windows.js close path.
    if (qw) { try { writeConfig({ winBounds: qw.getBounds() }) } catch (err) { log.warn('[Tray] winBounds 写入失败(退出路径)', err) } }
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
      if (choice === 0 && recoveredFrom) {
        // P2 2026-09-12: the recovery-succeeded relaunch branch skipped the plain-bak cleanup that the
        // init-success path below does — after recovery the plaintext copy stayed in userData forever,
        // defeating at-rest encryption. Clear it before relaunching (same semantics, best-effort).
        try {
          const pb = path.join(ud, 'todos.db.plain-bak')
          if (fs.existsSync(pb)) { fs.rmSync(pb, { force: true }); log.info('[Init] 恢复成功重启前清除明文残留 todos.db.plain-bak') }
        } catch (e0) { log.warn('[Init] plain-bak 清理失败(relaunch 前)', e0) }
        relaunchClean()
      }
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
    const win = getMainWindow()
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
// Flush-ack handshake (2026-09-11 P1): the old fixed 500ms window raced the renderer's fire-and-forget
// dbMirror invokes (.catch(()=>{})) — late writes were silently dropped after dbm.close(). before-quit
// broadcasts 'app-quitting-flush' with a token; the renderer acks via 'app-quitting-flush-ack' after its
// flush invokes are dispatched; will-quit holds the quit until every live window acked or ≤2s elapsed
// (bounded, so a hung renderer can never block quitting). The two-phase will-quit (flushDone passthrough
// for updater's autoInstallOnAppQuit) is unchanged.
const { createQuitAckTracker } = require('./quit-ack')
const quitAck = createQuitAckTracker()
app.on('before-quit', () => {
  // Second pass (the re-issued app.quit() below): the DB is already closed, re-broadcasting the flush
  // would only be a dead letter — renderer invokes would fail against a closed handle.
  if (flushDone) return
  state.quitByUser = true
  // Before quitting, broadcast the renderer flush of debounced mirrors (the last write within dbMirror's 2s / disaster-snapshot 800ms window would be silently lost)
  // 2026-09-10 P1: previously only the main window was notified — the float window's pending pomodoro
  // ledger (and the whole broadcast when the main window was already destroyed, e.g. X-close→tray→quit)
  // was silently lost. Broadcast to every live window with an isDestroyed guard.
  let liveWindows = 0
  // P2 2026-09-12: Date.now() tokens collide within the same millisecond — a stale ack from a previous
  // round could then satisfy (token !== prevToken no longer holds) and cut the flush window short.
  // quit-ack now guarantees strictly increasing tokens across rounds.
  const roundToken = quitAck.nextToken()
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w && !w.isDestroyed()) {
        w.webContents.send('app-quitting-flush', { token: roundToken })
        liveWindows++
        // P2 2026-09-12: a window destroyed between this send and its ack can never ack, so the
        // flush window previously waited out the full 2s cap every time a window died mid-handshake.
        // When the webContents is destroyed (window closed) or its renderer process is gone (crash —
        // it can never ack either), abandon the sender so allAcked() can go true early. Idempotent
        // via the tracker's abandoned set; acks from still-live windows are unaffected.
        const senderId = w.webContents.id
        const onGone = () => { try { quitAck.abandon(senderId) } catch { /* dying process */ } }
        w.webContents.once('destroyed', onGone)
        w.webContents.once('render-process-gone', onGone)
      }
    } catch {}
  }
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
  if (quitting) { event.preventDefault(); return }
  quitting = true
  event.preventDefault()
  const FLUSH_FLOOR_MS = 500
  const FLUSH_ACK_CAP_MS = 2000
  const startedAt = Date.now()
  const flushNow = () => {
    try { if (stopDbWatch) stopDbWatch() } catch {} // release the fs.watchFile poll timers before closing
    try { shortcuts.unregisterAll() } catch {}
    // Persist the reminder dedup ledger synchronously (quitting inside the 60s debounce window → reminders resent after restart) + close the db handle (avoids losing one checkpoint and late handle release on Windows)
    try { scheduler.flushFiredNow() } catch {}
    try { if (dbm && dbm.close) dbm.close() } catch {}
    flushDone = true
    app.quit()
    setTimeout(() => {
      // Hang fallback only; normally unreachable. 2026-09-10 P2: app.exit() bypasses the quit event
      // entirely, so electron-updater's autoInstallOnAppQuit would silently SKIP a pending update.
      // When an update is ready, hand off to quitAndInstall() instead — it quits, installs and
      // relaunches by itself; only hard-exit when nothing is pending (or the handoff is refused,
      // e.g. portable builds where quitAndInstall returns false without doing anything).
      try { if (updater.getStatus().status === 'ready' && updater.quitAndInstall()) return } catch { /* fall through to the hard exit */ }
      try { app.exit(0) } catch {}
    }, 3000)
  }
  // All acks already in (or no live window to wait for): keep the old fast path
  const allAcked = () => quitAck.allAcked()
  if (allAcked()) { setTimeout(flushNow, FLUSH_FLOOR_MS); return }
  const poll = setInterval(() => {
    if (allAcked() || Date.now() - startedAt >= FLUSH_ACK_CAP_MS) {
      clearInterval(poll)
      if (!flushDone) flushNow()
    }
  }, 50)
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
    getMainWindow, showMainOrLock,
    isLocked, isLockWindow, lockAppNow, unlockAppNow, verifyLockPassword, allowWithinRate,
    isSafeExternal, attachDir,
    resyncDbWatch: () => resyncDbWatch,
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
      }
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
