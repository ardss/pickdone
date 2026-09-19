/** Auto-update (electron-updater + GitHub Releases)
 *  The feed is provided by app-update.yml generated at electron-builder package time (publish: github draft);
 *  dev builds / portable versions have no app-update.yml, isUpdaterActive()=false, and all entry points degrade safely.
 *  Process convention: CI builds on tag → GitHub Draft Release → manually add changelog then Publish →
 *  installed users get a silent check at startup, background download, and auto-install on quit (or manual "restart to update" from settings).
 *
 *  2026-09-10 P1 — early exit-flush on 'update-downloaded' (see flushOnceOnReady below): the NSIS
 *  installer's customInit taskkill /F-kills any running instance, so once the installer is spawned the
 *  will-quit 500ms flush window ALWAYS loses that race — the debounced dbMirror writes and the reminder
 *  dedup ledger must already be on disk before the installer starts, not while it is killing us.
 */
const { autoUpdater } = require('electron-updater')
const log = require('electron-log')
const { readConfig } = require('./config-store')

// Portable versions (PORTABLE_EXECUTABLE_DIR injected by the electron-builder portable runtime) do not participate in in-app updates:
// otherwise it would launch the NSIS installer and overwrite the install, breaking the portable single-file semantics
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR
// PICKDONE_NO_AUTOUPDATE=1: reserved for managed distribution channels such as MS Store / portable — a store build self-updating would conflict with the store's distribution mechanism; a blanket env-var disable
const isActive = () => !isPortable && process.env.PICKDONE_NO_AUTOUPDATE !== '1' && autoUpdater.isUpdaterActive()

let win = null
const state = { status: 'idle', info: null } // idle|checking|downloading|available|ready|uptodate|error

// Setting autoDownloadUpdates (default on): when off, only a new-version notice is shown; the user clicks "Download now" in settings
function syncAutoDownload () {
  try { autoUpdater.autoDownload = readConfig().autoDownloadUpdates !== false } catch { autoUpdater.autoDownload = true }
}

function broadcast () {
  try { if (win && !win.isDestroyed()) win.webContents.send('updater:event', { ...state }) } catch (e) { /* window closed */ }
}

// Fires ONCE per downloaded update (the app restarts into the new version after install, so one shot per
// process = one shot per downloaded update): an early, equivalent round of the exit flush that index.js
// runs in before-quit/will-quit. Chosen as the least invasive hook — updater.js talks to the renderer via
// the same 'app-quitting-flush' channel and lazily requires ./scheduler for flushFiredNow, so index.js
// needs no exported symbol and no require cycle is created at load time.
// P2 2026-09-19: the broadcast used to go out WITHOUT a token, so the renderer's quit-ack guard could
// never match an ack to this round, and the old fire-and-forget shape cleared renderer pendings while
// the installer's taskkill was free to land first. Now it runs the same tokenized handshake as the
// quit path (quit-ack beginRound/ack) and performs the main-process flush only after every live
// window acked or a short cap elapses.
let _flushedOnReady = false
let _activeFlushRound = null
/** Routes a renderer 'app-quitting-flush-ack' into the updater's early-flush round, if one is in
 *  flight (index.js owns the quit-path tracker; this early round has its own). No-op otherwise. */
function forwardFlushAck (token, senderId) {
  try { return !!(_activeFlushRound && _activeFlushRound.ack(token, senderId)) } catch { return false }
}
function flushOnceOnReady (deps = {}) {
  if (_flushedOnReady) return
  _flushedOnReady = true
  const getWindows = deps.getWindows || (() => {
    try { return require('electron').BrowserWindow.getAllWindows() } catch { return [] }
  })
  const tracker = deps.tracker || require('./quit-ack').createQuitAckTracker()
  const flushMain = deps.flushMain || (() => { try { require('./scheduler').flushFiredNow() } catch { /* best-effort */ } })
  const ACK_CAP_MS = deps.ACK_CAP_MS ?? 1500
  const POLL_MS = 50
  const senders = []
  const token = tracker.nextToken()
  for (const w of getWindows()) {
    try {
      if (w && !w.isDestroyed()) {
        // Renderer side: same channel + token shape as the before-quit path — the renderer flushes
        // whatever is still sitting in the dbMirror debounce (pending edits / pomodoro ledger) to
        // disk, then acks 'app-quitting-flush-ack' with the token.
        w.webContents.send('app-quitting-flush', { token })
        senders.push(w.webContents.id)
      }
    } catch { /* dead window */ }
  }
  tracker.beginRound(senders, token)
  _activeFlushRound = tracker
  // Main-process side: same scheduler flush the will-quit path runs (persist the reminder dedup
  // ledger now instead of losing whatever sits inside its 60s debounce when the installer /F-kills
  // us) — but only once the renderer side is done (all acked) or the bounded cap elapsed, never
  // before the renderer even had a chance to dispatch.
  const startedAt = Date.now()
  const poll = setInterval(() => {
    if (tracker.allAcked() || Date.now() - startedAt >= ACK_CAP_MS) {
      clearInterval(poll)
      flushMain()
    }
  }, POLL_MS)
  if (poll.unref) poll.unref()
}

let _inited = false
function init (mainWin) {
  win = mainWin
  if (_inited) return module.exports // idempotent: the main-window-close → tray → reopen path calls createMainWindow again; repeated init would stack listeners and multiply broadcasts N-fold
  _inited = true
  autoUpdater.logger = log // stdout is invisible after packaging; update failures must be diagnosable from the log
  autoUpdater.autoInstallOnAppQuit = true // after download, a normal user quit silently upgrades
  syncAutoDownload()
  autoUpdater.on('checking-for-update', () => { state.status = 'checking'; broadcast() })
  autoUpdater.on('update-available', i => { state.status = autoUpdater.autoDownload ? 'downloading' : 'available'; state.info = i; broadcast() })
  autoUpdater.on('update-not-available', i => { state.status = 'uptodate'; state.info = i; broadcast() })
  autoUpdater.on('download-progress', p => { state.status = 'downloading'; state.info = { percent: Math.round(p.percent || 0) }; broadcast() })
  autoUpdater.on('update-downloaded', i => { state.status = 'ready'; state.info = i; broadcast(); flushOnceOnReady() })
  // Error handling: besides broadcasting, schedule a single backoff retry (checkForUpdates after 30s).
  // Only one retry: transient network/proxy jitter self-heals; persistent failures (e.g. 404, certificate issues) are not retried, avoiding a request storm every 30s. During the retry window, a new error overwrites the state directly without queuing.
  let _retryTimer = null
  autoUpdater.on('error', e => {
    state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }; broadcast()
    if (_retryTimer || !isActive()) return
    _retryTimer = setTimeout(() => {
      _retryTimer = null
      if (!isActive() || state.status === 'ready') return
      log.warn('[Updater] 自动重试检查更新（仅一次）')
      check().catch(() => {})
    }, 30 * 1000)
    _retryTimer.unref?.()
  })
  return module.exports
}

/** In non-update environments (dev/portable) returns {active:false}; the renderer hides the entry copy accordingly */
let _inFlight = null
async function check () {
  if (!isActive()) return { active: false, ...state }
  if (_inFlight) return _inFlight // 并发重入护栏:4h 定时/手动/30s 错误重试三者可能重叠(2026-09-05 终审 P2)
  _inFlight = (async () => {
    syncAutoDownload() // align with the settings-page toggle before every check (hot-applied, no restart needed)
    try { await autoUpdater.checkForUpdates(); return { active: true, ...state } } catch (e) {
      state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }
      broadcast() // 手动检查失败也要推给设置页状态条(error 事件路径之外的 catch 不经过 autoUpdater 事件)(三轮扫荡 P2)
      return { active: true, ...state }
    } finally { _inFlight = null }
  })()
  return _inFlight
}

/** Manual download (settings page "Download now"): only meaningful in the "new version found but not auto-downloaded" state */
async function downloadUpdate () {
  if (!isActive() || state.status !== 'available') return false
  autoUpdater.autoDownload = true
  state.status = 'downloading'; broadcast()
  try { await autoUpdater.downloadUpdate(); return true } catch (e) {
    state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }; broadcast()
    return false
  }
}

function quitAndInstall () {
  if (isPortable || state.status !== 'ready') return false
  autoUpdater.quitAndInstall(true, true) // silent + runAfter: skips the install wizard and auto-launches the new version after update (smooth default)
  return true
}

function getStatus () {
  return { active: isActive(), version: require('electron').app.getVersion(), ...state }
}

module.exports = { init, check, downloadUpdate, quitAndInstall, getStatus, flushOnceOnReady, forwardFlushAck }
