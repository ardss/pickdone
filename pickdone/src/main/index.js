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
  // P2 2026-09-17: leave a breadcrumb before the rethrow — the default dialog can be dismissed/skipped
  // and the crash then leaves no trace in the log file for post-mortem diagnosis
  try { log.error('[uncaughtException]', e && e.stack || e) } catch {}
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

const { readConfig, writeConfig, consumeQuarantineNotice } = require('./config-store')

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
function attemptDbRecovery (ud, retryInit) { return dbRecovery.attemptDbRecovery(ud, retryInit) }
// Phase-2 command bus: the critical-backup restore pipeline commits through the bus
// (todo.putMany / category.put / tomato.appendMany) like every other write path. preserveStamp:
// restore replays the backup's own row ages verbatim — re-stamping here would skew LWW against
// peers. The 'undo-barrier'/'ls-mirror' subscribers only exist after registerIpc, so the
// startup recovery path commits with no fanout, exactly as before.
const busCommit = (entity, verb, payload) => require('./command-bus').commit(entity, verb, payload, { preserveStamp: true })
// F11 (dw wave6): startup recovery now re-imports the SAME segment set the UI restore accepts —
// filter.putMany / plan.putMany / meta.put ride the same command-bus doors as the renderer, all
// idempotent by id (dbRecovery skips rows without id; the db ops upsert ON CONFLICT).
function restoreTasksFromCriticalBackup (ud) {
  return dbRecovery.restoreTasksFromCriticalBackup(ud,
    list => busCommit('todo', 'putMany', list),
    c => busCommit('category', 'put', c),
    rows => busCommit('tomato', 'appendMany', rows),
    {
      filterPutMany: rows => busCommit('filter', 'putMany', rows),
      planPutMany: chips => busCommit('plan', 'putMany', chips),
      habitsPut: pair => busCommit('meta', 'put', pair),
      // metaState (2026-09-26, meta-keys-omitted): repeat rules / tomato estimates / project
      // deadline+status+flag+milestones live only in the meta table — re-put them like habits.
      metaPut: pair => busCommit('meta', 'put', pair)
    })
}

/* ---------------- External-write listener: when the CLI writes the DB directly, the running App refreshes automatically ---------------- */
let resyncDbWatch = null // set by watchDbForExternalWrites: re-baselines lastMtime after OUR OWN db writes (P1 2026-09-11)
let stopDbWatch = null // set by watchDbForExternalWrites: unwatchFile both files on the quit chain (P2 2026-09-11)
function watchDbForExternalWrites () {
  const ud = app.getPath('userData')
  const dbFile = path.join(ud, 'todos.db')
  const walFile = dbFile + '-wal'
  // In WAL mode CLI writes only land in -wal and the main DB's mtime stays unchanged (once broke the 2s broadcast, leaving stale UI data); watch both files
  // P2 2026-09-12 torn read: two independent statSync calls raced a concurrent CLI wal write — the
  // baseline absorbed half a write (missed event) or saw a transient value (false external-write
  // reload). Take the value only when two consecutive reads agree (fix-util.stableRead); persistent
  // disagreement (extremely rare) yields null and this poll is skipped, the next one re-reads.
  const readWatchMtime = () => {
    const statOne = () => Math.max(fs.statSync(dbFile).mtimeMs, fs.existsSync(walFile) ? fs.statSync(walFile).mtimeMs : 0)
    return fixUtil.stableRead(statOne)
  }
  // P2 2026-09-19: `readWatchMtime() || 0` mapped a null baseline (torn read at startup) to 0, so
  // the first poll was a GUARANTEED false external-write (full reload + undo-stack wipe) the moment
  // the real mtime came in. Keep the baseline null instead and let onChange establish it from the
  // first non-null read WITHOUT kicking — a null baseline means "disarmed", not "everything changed".
  let lastMtime = readWatchMtime()
  if (lastMtime == null) log.warn('[TodoDB] 启动基线读取未定（torn read），首轮轮询仅建立基线不触发刷新')
  let lastTomatoCmdRaw = null
  // Round-1 P0 (2026-09-21): seed the tomato command watermark from the persisted cliTomatoSeq
  // counter (same restart-replay fix as the cliSyncCmd channel) — a stale slot command must not
  // re-execute on every app restart.
  let lastTomatoSeq = 0
  try { lastTomatoSeq = Number(dbm.call('getMeta', 'cliTomatoSeq')) || 0 } catch { lastTomatoSeq = 0 }
  // Round-2 P1 (2026-09-21): mirror of the cliSyncCmd slot fix — a command queued at exactly the
  // counter (crash between slot-write and forward) must EXECUTE once after restart, not be
  // skipped; seeding the watermark from the slot (counter - 1) lets the normal forward path run
  // it and clear the slot, so a second restart never re-executes it.
  try {
    const queued = JSON.parse(dbm.call('getMeta', 'cliTomatoCmd') || 'null')
    if (queued && Number.isFinite(queued.seq) && Number(queued.seq) === lastTomatoSeq) lastTomatoSeq -= 1
  } catch { /* malformed slot: counter watermark stands */ }
  // CLI settings hot-sync baseline: the first poll only builds the baseline and does not push (otherwise startup would push a full diff by mistake)
  let lastSettingsSavedAt = 0
  let lastSettingsDoc = null
  try {
    const rawS = dbm.call('getMeta', 'db.settingsState')
    if (rawS) { const d = JSON.parse(rawS); lastSettingsSavedAt = (d && d._savedAt) || 0; lastSettingsDoc = d }
  } catch {}
  let debounce = null
  // CLI sync command channel (feat/cli-sync-pair): same polling surface as cliTomatoCmd — the CLI
  // writes meta cliSyncCmd, we dispatch into db-sync-ops (the Device Center's own registry) and
  // write the receipt to cliSyncState. Handled in the MAIN process directly: LAN sync state lives
  // here, not in the renderer, so no window forwarding is involved (and the security lock, which
  // only gates todo-db:call IPC, must not wedge headless pairing of an idle machine).
  let forwardSyncCmd = () => {}
  try {
    const syncChannel = require('./cli-sync-channel')
    const syncOps = require('./db-sync-ops')
    const channel = syncChannel.createSyncCmdHandler({
      dispatch: (op, p) => syncOps.dispatch(op, p),
      setMeta: (k, v) => require('./command-bus').commit('meta', 'put', [k, v], { preserveStamp: true }), // Phase-2: receipt write via the bus (cliSync* keys are machine-local — no sync kick)
      // Round-1 P0 (2026-09-21): seed the seq watermark from the persisted counter + clear the
      // handled slot — an old `unpair` left in cliSyncCmd must never replay on every app restart
      // (it rotated the pairing secret and silently dropped the peer).
      getMeta: k => dbm.call('getMeta', k),
      deleteMeta: k => require('./command-bus').commit('meta', 'delete', k, { preserveStamp: true }),
      log
    })
    forwardSyncCmd = () => {
      try { channel.forward(dbm.call('getMeta', 'cliSyncCmd')) } catch (e) { log.warn('[CLI] sync 命令转发失败', e) }
    }
  } catch (e) { log.warn('[CLI] sync 命令通道初始化失败', e) }
  /* Tomato command forwarding: independent of mtime — fs.watchFile polling occasionally drops events, which
     once let a stop command be silently skipped (meta is a single slot; once an old command is overwritten by a
     new one it is lost forever), so every poll reads meta directly once (pure read). */
  const forwardTomatoCmd = () => {
    try {
      const raw = dbm.call('getMeta', 'cliTomatoCmd')
      // 守卫只包转发段,不得 return 整函数——函数后半段还承担 CLI 设置热同步(2026-09-04 二轮深审 P0:提前 return 曾短路设置推送)。
      // 锁屏态不转发也不标记已消费:锁定时 todo-db:call 全拒,转发了会'半执行'(计时启动但回执被拒),解锁后 onChange 自然补发。
      // F2 2026-09-15 竞态根修:此前 lastTomatoSeq 在 send 之前推进且 send 前无 isDestroyed 复查——窗口销毁/
      // 重建间隙 send 抛错被外层 catch 成 warn,但 seq 已消费 → 命令永久丢失。现抽为纯逻辑
      // fixUtil.tryForwardTomatoCmd:send 成功才推进 seq,失败/窗口未就绪均不消费(下轮轮询重投)。
      const st = fixUtil.tryForwardTomatoCmd({
        raw, lastTomatoCmdRaw, lastTomatoSeq, getMainWindow, isLocked,
        // Round-1 P0 (2026-09-21): after a successful forward, clear the slot so the command
        // cannot replay on the next app restart (compare-and-delete: never eat a newer command).
        clearCmd: (cmd) => {
          try {
            const cur = JSON.parse(dbm.call('getMeta', 'cliTomatoCmd') || 'null')
            if (cur && Number(cur.seq) === Number(cmd.seq)) require('./command-bus').commit('meta', 'delete', 'cliTomatoCmd', { preserveStamp: true })
          } catch { /* best-effort cleanup */ }
        }
      })
      lastTomatoCmdRaw = st.lastTomatoCmdRaw
      lastTomatoSeq = st.lastTomatoSeq
      // 账本类命令已退役为 CLI 直写行表(渲染端经 tomato-records-changed 回灌),本通道只剩状态类 start/stop/attach,只发主窗
      if (st.sent) log.info('[CLI] 番茄命令已转发渲染端:', st.cmd.action, 'seq=' + st.cmd.seq)
    } catch (e) { log.warn('[CLI] 番茄命令转发失败', e) }
    // CLI settings set: mirror changes to db.settingsState's _savedAt → diff and push to the renderer for hot application
    // (renderer dispatches settings/update → IPC notify-settings-updated → main-process config.json/shortcuts/login item sync accordingly)
    // C14 (P2 2026-09-24): the change watermark used to be the blob's _savedAt alone — a whole-blob
    // snapshot stamp written from the doc's READ time. Two CLI writes within one poll interval (or two
    // concurrent CLI processes) could land the same _savedAt millisecond while settings_rows (the
    // field-granular write truth, see cli/lib.js settingsSet row-path-first) already recorded both
    // field updates — the intermediate state evaporated and the renderer never saw it. The watermark
    // is now max(blob._savedAt, settings_rows max(updatedAt)): row updatedAt is stamped per real field
    // change, so a same-millisecond blob stamp can no longer mask a change. Deleted rows count too (a
    // tombstone is a state change the renderer must see).
    try {
      const rawS = dbm.call('getMeta', 'db.settingsState')
      let doc = null
      let at = 0
      if (rawS) { doc = JSON.parse(rawS); at = (doc && doc._savedAt) || 0 }
      try {
        // Round-3 perf (2026-09-26): identical watermark via one MAX aggregate instead of
        // settingsRowsAll + per-row JSON.parse (this tick runs ~4x/sec for the app's lifetime).
        const maxRow = Number(dbm.call('settingsRowsMaxUpdated')) || 0
        if (maxRow > at) at = maxRow
      } catch { /* rows unavailable (legacy lib) → fall back to the _savedAt-only watermark */ }
      if (doc && at > lastSettingsSavedAt) {
        const prev = lastSettingsDoc
        lastSettingsSavedAt = at
        lastSettingsDoc = doc
        const win = getMainWindow()
        if (prev && win) {
          // Diff moved to settings-hot-sync.js (testable): machine-local stamps (_lsAt included —
          // echo-loop root fix, see module comment) and secret fields never travel in the patch.
          const patch = require('./settings-hot-sync').computeSettingsPatch(doc, prev)
          if (Object.keys(patch).length) {
            // P2 2026-09-11: hot-sync used to push only the main window — the float/quick-add windows
            // kept pre-CLI-change settings until restart (same all-windows pattern as the quit flush)
            for (const w of BrowserWindow.getAllWindows()) {
              try { if (w && !w.isDestroyed()) w.webContents.send('external-settings-changed', patch) } catch {}
            }
            log.info('[CLI] 设置变更热同步:', Object.keys(patch).join(','))
          }
        }
      }
    } catch (e) { log.warn('[CLI] 设置热同步失败', e) }
  }
  const kick = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      try {
        // Round-3 stability (2026-09-26): the quit chain arms ext-watch-gate BEFORE the flush
        // window, but a kick scheduled within the 150ms debounce just before arm fires INSIDE
        // the window — where the un-gated forwardTomatoCmd could consume a CLI command slot
        // whose resulting write lands after dbm.close() (same permanent-loss class C11 fixed
        // for ticks). Gate the flush body, not just the tick.
        if (!extWatchGate.canPoll()) return
        scheduler.reloadAll(dbApi())
        broadcastTodosChanged('external-db-write')
        // CLI 直写账本行(独立进程,db 层钩子在 CLI 进程内不挂)——外部写轮询是唯一跨进程通知点,
        // 必须同时广播账本重载,否则 CLI backfill/record rm 后界面账本保持旧副本(2026-09-04 实锤)
        broadcastTomatoRecordsChanged('external-db-write')
        // CLI pomodoro command channel: the CLI writes meta cliTomatoCmd → forwarded to the main window's renderer, which dispatches the existing
        // store/tomato actions (idempotency token/cross-window claim/ledger/project estimate all reused; the CLI never writes state in parallel)
        forwardTomatoCmd()
        log.info('[TodoDB] 检测到外部写入（CLI），已刷新调度器并通知渲染端')
        try { require('./lan-sync-bootstrap').kickSyncRound('external-db-write') } catch { /* sync lazy-not-init */ }
        // Resync the mtime baseline: reloadAll itself writes reminderLastSeenAt (touching -wal); without this
        // the next poll sees our own write as "another external write" → reload → write again = a self-sustaining loop
        lastMtime = readWatchMtime() ?? lastMtime
      } catch (e) { log.warn('[TodoDB] 外部写入刷新失败', e) }
    }, 150)
  }
  const onChange = () => {
    try {
      // C11 (2026-09-26): once the quit chain has started, a tick landing inside the 500ms-2s
      // flush window must do NOTHING — no dbm.call reads, no wc.send, no slot-delete commit.
      // stopDbWatch only runs at flushNow (after the flush window), so the poll is still live
      // here; without this gate a late tick could forward a CLI command to an already-flushed
      // renderer and consume the slot whose resulting write would land after dbm.close().
      if (!extWatchGate.canPoll()) return
      const m = readWatchMtime()
      if (m == null) return
      // Disarmed baseline (startup torn read): the first non-null read only ARMS the watcher —
      // it is a baseline, not a change, so it must not kick a spurious external-write reload.
      if (lastMtime == null) { lastMtime = m; forwardTomatoCmd(); forwardSyncCmd(); return }
      if (m === lastMtime) { forwardTomatoCmd(); forwardSyncCmd(); return } // check commands even when mtime is unchanged (guards against watchFile dropping events)
      lastMtime = m
      kick()
      forwardTomatoCmd()
      forwardSyncCmd()
    } catch {}
  }
  fs.watchFile(dbFile, { interval: 500 }, onChange)
  fs.watchFile(walFile, { interval: 500 }, onChange)
  // P1 2026-09-11: App's own todo-db:call writes touch the -wal too, but the 500ms-debounced kick above
  // only re-baselines for the EXTERNAL-write path. Our own IPC writes left the baseline stale → the next
  // poll read them as "external" → full reload + undo-stack wipe ~3s after every local write (the
  // renderer's 1.5s suppression window cannot cover the 2-3s watcher latency). Re-baseline immediately
  // after every write-type todo-db:call so the next poll sees mtime === baseline.
  resyncDbWatch = () => { lastMtime = nextWatchBaseline(lastMtime, readWatchMtime) }
  // P2 2026-09-11: fs.watchFile never unwatched — poll timers kept the quit chain alive/lint-y; release them on quit
  stopDbWatch = () => {
    // Round-3 stability (2026-09-26): a pending 150ms debounce kick survived the unwatch and
    // fired against the closed DB handle (error swallowed as a warn). Clear it first.
    try { clearTimeout(debounce) } catch {}
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
let tomatoLiveText = '' // non-empty = a focus/rest pomodoro is live (per-second push from the renderer; the main process's only running-state signal)
function updateTomatoTray (text) {
  const t = String(text || '').trim()
  tomatoLiveText = t
  if (tray) { try { tray.setToolTip(i18nM.mt('appName') + (t ? ' · ' + t : '')) } catch (e) { /* empty */ } }
}

/* ================= Tray quit with focus-in-progress confirmation ================= */
async function quitFromTray () {
  state.quitByUser = true
  // P2 2026-09-23: a running pomodoro used to die silently on tray-quit — the ledger only ever
  // records on completeFocus/giveUp, so the in-progress session vanished with no confirm and no
  // record. Ask before tearing everything down (the tray stays alive until confirmed).
  if (tomatoLiveText) {
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
if (!app.requestSingleInstanceLock()) { app.quit() } else {
  // Round-3 stability (2026-09-26): show() deferred until whenReady resolves when the event
  // arrives during the cold-start init chain — new BrowserWindow before ready hard-throws and
  // surfaced as a crash dialog on a plain double launch (see second-instance-gate.js).
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
    } catch (e) {
      log.error('[Init] DB 初始化失败：', e)
      const { dialog, shell } = require('electron')
      const ud = app.getPath('userData')
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
      // source is a structured branch flag; display copy must never drive logic (dbRecovery.cjs contract)
      if (recoveredFrom && recoveredFrom.source === 'json') {
        restoredN = restoreTasksFromCriticalBackup(ud)
        // GAP-D fix (2026-09-19): recovery writes go through dbm.call directly with no sync kick —
        // restored rows waited for the periodic round. Boot-time kick is safe: kickSyncRound no-ops
        // while the sync node is not initialized.
        try { require('./lan-sync-bootstrap').kickSyncRound('db-recovery') } catch { /* sync lazy-not-init */ }
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
        // P1 (R4 2026-09-21): cleanup is now gated on an ACTUAL restore. restoreTasksFromCriticalBackup
        // swallows per-step errors and returns 0 — the old unconditional delete destroyed the last
        // usable backup (todos.db.plain-bak) whenever the JSON restore imported nothing. Only the
        // 'json' branch with restoredN > 0 proves the DB was really rebuilt with current data, so
        // only that branch may drop the bak; a 'plain-bak' copy or a 0-row restore keeps it on disk.
        const jsonRestoreProved = recoveredFrom.source === 'json' && restoredN > 0
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
    createTray()
    scheduler.setSoundFile(path.join(__dirname, '../../assets/media/confirm1.ogg'))
    scheduler.reloadAll(dbApi())
    // Meta GC: clean up orphan keys (residue after a repeat rule is deleted / project deadline & milestones become permanent orphans after a category is deleted)
    try {
      // P1 2026-09-19: getAll({deleted:null}) included recycle-bin rows, so a repeatId referenced
      // only by a deleted task kept its repeatRule: meta forever (never GC'd). Only LIVE rows keep
      // a rule alive — deleted:0. Decision logic extracted to handlers/shared.computeMetaGc for tests.
      const { computeMetaGc } = require('./handlers/shared')
      for (const k of computeMetaGc(dbm.call('listMetaKeys'), dbm.call('getAllCategories'), dbm.call('getAll', { deleted: 0 }))) {
        require('./command-bus').commit('meta', 'delete', k, { preserveStamp: true }) // Phase-2: GC via the bus
      }
      // D6 P2 (2026-09-21): the GC loop runs BEFORE registerIpc wires the bus fanout hooks, so
      // the deletion deltas sat in the local oplog until the next periodic sync round — peers
      // kept stale repeat-rule/deadline meta for minutes after boot. One explicit kick mirrors
      // the GAP-D recovery kick above; kickSyncRound no-ops while sync is lazy-not-initialized.
      try { require('./lan-sync-bootstrap').kickSyncRound('meta-gc') } catch { /* sync lazy-not-init */ }
    } catch (e) { log.warn('[MetaGC] skipped:', e && e.message) }
    registerIpc()
    watchDbForExternalWrites()
    // P3a LAN sync (lazy; never auto-enables — see lan-sync-bootstrap.js header)
    require('./lan-sync-bootstrap').initLanSync({
      db: dbm,
      getWindowSenders: () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => w.webContents),
      // P0-1 (2026-09-19 UX review): after applying inbound rows, LAN sync re-baselines the
      // external-write watcher — its own WAL writes must not surface as "CLI wrote" and fire a
      // second, undo-stack-wiping full reload on top of the targeted lan-sync-apply broadcast.
      resyncExternalWatch: () => { try { if (resyncDbWatch) resyncDbWatch() } catch { /* best-effort */ } },
    })

    // Auto-update: init the event bridge + delayed silent check (does not compete with startup; degrades automatically in non-update environments)
    updater.init(win)
    setTimeout(() => { updater.check().then(r => { if (r.active) log.info('[Updater]', r.status) }).catch(() => {}) }, 8000)
    // Periodic re-check for resident instances (4h): users who go long without restarting still get the new-version notice within the current session
    setInterval(() => { updater.check().catch(() => {}) }, 4 * 60 * 60 * 1000).unref?.()

    // Global shortcuts (shortcut settings stored in config.json)
    applyShortcuts(readConfig().shortcutKeySettings)

    // Round-3 stability (2026-09-26): if this startup quarantined a corrupt config.json (renamed
    // to config.json.bad), the user must know: settings reset for this session and the security
    // lock is disabled until re-enabled. Notice-only — the fail-open semantics are unchanged.
    try {
      if (consumeQuarantineNotice()) {
        const { Notification, dialog } = require('electron')
        const body = 'Your config file (config.json) was corrupted and could not be read. ' +
          'The previous file was preserved as config.json.bad. Settings are reset for this session ' +
          'and the security lock is disabled until you re-enable it.'
        log.warn('[App] config.json was corrupted and quarantined as config.json.bad; security lock disabled until re-enabled')
        let shown = false
        try {
          if (Notification.isSupported()) { new Notification({ title: 'PickDone', body }).show(); shown = true }
        } catch { /* fall through to the non-modal dialog */ }
        if (!shown) dialog.showMessageBox(win, { type: 'warning', title: 'PickDone', message: body, buttons: ['OK'] }).catch(() => {})
      }
    } catch (e) { log.warn('[App] quarantine notice failed:', e && e.message) }

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
const quitAckModule = require('./quit-ack')
const quitAck = quitAckModule.createQuitAckTracker()
// webContents -> latest 'destroyed'/'render-process-gone' abandon closure (WeakMap: dying senders GC freely)
const quitAckGone = new WeakMap()
app.on('before-quit', () => {
  // Second pass (the re-issued app.quit() below): the DB is already closed, re-broadcasting the flush
  // would only be a dead letter — renderer invokes would fail against a closed handle.
  if (flushDone) return
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
  if (quitting) { event.preventDefault(); return }
  quitting = true
  extWatchGate.arm() // C11: disarm the external-write poll BEFORE the flush window opens
  event.preventDefault()
  const FLUSH_FLOOR_MS = 500
  const flushNow = () => {
    try { if (stopDbWatch) stopDbWatch() } catch {} // release the fs.watchFile poll timers before closing
    try { shortcuts.unregisterAll() } catch {}
    // Persist the reminder dedup ledger synchronously (quitting inside the 60s debounce window → reminders resent after restart) + close the db handle (avoids losing one checkpoint and late handle release on Windows)
    try { scheduler.flushFiredNow() } catch {}
    // R7-B P2: the sync node (and its in-flight quit-announce round) stops here — after the
    // flush window gave the round its runway, before the DB handle closes.
    try { require('./lan-sync-bootstrap').stopSyncForQuit() } catch { /* sync never initialized */ }
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
    getMainWindow, showMainOrLock,
    isLocked, isLockWindow, lockAppNow, unlockAppNow, verifyLockPassword, allowWithinRate,
    isSafeExternal, attachDir,
    resyncDbWatch: () => resyncDbWatch,
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
