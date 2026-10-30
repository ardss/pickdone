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
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const { readConfig, isReadFailed } = require('./config-store')

// Portable versions (PORTABLE_EXECUTABLE_DIR injected by the electron-builder portable runtime) do not participate in in-app updates:
// otherwise it would launch the NSIS installer and overwrite the install, breaking the portable single-file semantics
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR
// PICKDONE_NO_AUTOUPDATE=1: reserved for managed distribution channels such as MS Store / portable — a store build self-updating would conflict with the store's distribution mechanism; a blanket env-var disable
const isActive = () => !isPortable && process.env.PICKDONE_NO_AUTOUPDATE !== '1' && autoUpdater.isUpdaterActive()

let win = null
const state = { status: 'idle', info: null } // idle|checking|downloading|available|ready|uptodate|error

// Setting autoDownloadUpdates (default on): when off, only a new-version notice is shown; the user clicks "Download now" in settings
function syncAutoDownload () {
  // updater-config-read-fail-open fix (2026-09-26): the catch failed OPEN to auto-download, and
  // the real fail-open path was readConfig's defaults-on-corruption anyway — an explicit
  // autoDownloadUpdates=false opt-out silently reverted to auto-download whenever the config
  // read failed. Fail CLOSED when the opt-out state is UNKNOWABLE: a known-failed read
  // (isReadFailed — quarantine failed, writes gated off) or a throw disables auto-download.
  // Auto-download is a network side effect; without an affirmative readable consent it must not
  // start. Residual (documented, deliberate): when quarantine SUCCEEDS the config reverts to
  // defaults like every other preference (keys are lost, not destroyed — see config-store) and
  // the lost opt-out is indistinguishable from a first install; closing that needs a
  // readConfig degraded-marker API change, out of scope here. Missing config (ENOENT) keeps
  // the defaults-on default.
  let allow = false
  try {
    // read FIRST, then consult the failure flag: the flag is set by THIS readConfig call when
    // it discovers (and cannot quarantine) the corruption — checking it before the read would
    // only see the PREVIOUS read's state and miss the corruption found right here.
    const c = readConfig()
    allow = !isReadFailed() && c.autoDownloadUpdates !== false
  } catch { allow = false }
  autoUpdater.autoDownload = allow
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
 *  flight (index.js owns the quit-path tracker; this early round has its own). No-op otherwise.
 *  P2 2026-09-20: also guards against a STALE round — once the round completes (acked or cap)
 *  the tracker is cleared below, so a late ack can no longer route into a finished round. */
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
  // P2 (dw wave5 2026-09-24): the whole broadcast→ack→bounded-wait→flushMain round moved into
  // quit-ack.runFlushRound (it used to be a hand-rolled copy of index.js's will-quit loop with a
  // drifted 1500ms cap; the cap now unifies on the shared 2000ms default in quit-ack.js).
  _activeFlushRound = tracker
  require('./quit-ack').runFlushRound({
    tracker,
    getWindows,
    flushMain,
    capMs: deps.ACK_CAP_MS,
    onDone: t => {
      // P2 2026-09-20: _activeFlushRound used to stay set forever after the round completed —
      // late acks kept routing into the finished tracker and the reference leaked. Clear it.
      if (_activeFlushRound === t) _activeFlushRound = null
    }
  })
}

let _inited = false
// D2 (2026-10-21): set by init — the stall-watchdog arming point, so the manual downloadUpdate
// entry into 'downloading' arms it too (module-level because downloadUpdate lives outside init).
let _armStallWatchdog = null
// D2 (2026-10-21): the in-flight manual download's abort handle — markUpdateError (watchdog /
// 'error' event) resolves a hung downloadUpdate promise so the NEXT click can start a fresh
// download instead of being handed the same dead promise forever.
let _manualAbort = null
function init (mainWin) {
  win = mainWin
  if (_inited) return module.exports // idempotent: the main-window-close → tray → reopen path calls createMainWindow again; repeated init would stack listeners and multiply broadcasts N-fold
  _inited = true
  autoUpdater.logger = log // stdout is invisible after packaging; update failures must be diagnosable from the log
  // F4 (2026-10-21): autoInstallOnAppQuit fires only on the NATIVE quit event, i.e. AFTER a
  // user-confirmed quit — the running-pomodoro confirmation lives upstream at the quit entry
  // points (tray quit in index.js, X-close quit chain, and the "restart to update" IPC in
  // handlers/system.js which now asks the same confirm). No second gate here: this path cannot
  // run without the user having already confirmed the quit.
  autoUpdater.autoInstallOnAppQuit = true // after download, a normal user quit silently upgrades
  // P1-4 (2026-09-19): electron-updater derives the feed FILE from the channel — a beta app version
  // implies channel `beta` and fetches `beta.yml`, which electron-builder never publishes for this
  // project (it only emits `latest.yml`). Pinning channel='latest' fixed that 404 but introduced a
  // WORSE one (2026-10-29 beta.21 实锤): GitHubProvider's prerelease matcher requires the channel to
  // be null-or-alpha/beta (`shouldFetchVersion = !channel || ['alpha','beta'].includes(channel)`),
  // so channel='latest' matched NO beta tag at all → "No published versions on GitHub" forever.
  // Correct shape: leave `channel` UNSET (currentVersion 0.4.0-beta.x yields currentChannel 'beta',
  // which matches beta tags; and a null channel resolves the feed file to latest.yml by default)
  // + allowPrerelease=true. Verified against node_modules/electron-updater 6.8.9 getLatestVersion.
  autoUpdater.allowPrerelease = true
  autoUpdater.allowDowngrade = false
  syncAutoDownload()
  autoUpdater.on('checking-for-update', () => {
    // D10: a periodic/error-retry check() overlapping a manual downloadUpdate must not clobber state
    // W12 (P2 2026-10-26): the last handler without the terminal 'ready' guard — every check()
    // (4h periodic, 30s error retry, manual updater:check) fires this event first, so a re-check
    // after update-downloaded clobbered 'ready' → 'checking', and the downstream M2b guards never
    // saw 'ready' again; 'update-available' then reset to 'available'/'downloading' and
    // quitAndInstall() (requires status==='ready') returned false for the rest of the session —
    // the "restart to install" button died (with autoDownloadUpdates:false it never recovered).
    if (_manualDownload || state.status === 'ready') return
    state.status = 'checking'; broadcast()
  })
  autoUpdater.on('update-available', i => {
    // D10 (2026-09-27): a check() that fires 'update-available' mid-MANUAL-download used to reset
    // status to 'available' and replace state.info, so the settings gate read the wrong state and a
    // second downloadUpdate double-called autoUpdater.downloadUpdate. While a manual download is
    // in flight, status/info are owned by it.
    // d-wave fix (2026-10-14): a LATER check() firing update-available after update-downloaded
    // reset status off 'ready', breaking the "restart and install" path (quitAndInstall requires
    // status==='ready'). A downloaded update is already on disk — later availability events are
    // stale; keep 'ready' and the stored info.
    if (_manualDownload || state.status === 'ready') return
    state.status = autoUpdater.autoDownload ? 'downloading' : 'available'; state.info = i; broadcast()
    // D2 fix (2026-10-21): the auto-download entry into 'downloading' arms the stall watchdog
    // too — the hang-before-first-progress case is reachable from here just as much.
    if (state.status === 'downloading' && _armStallWatchdog) { try { _armStallWatchdog() } catch { /* arming is best-effort */ } }
  })
  autoUpdater.on('update-not-available', i => {
    // M2b (P2 2026-10-23): same guards as 'update-available' above — a later check() firing
    // update-not-available must not downgrade a settled 'ready' (a downloaded update is already
    // on disk; quitAndInstall requires status==='ready') nor clobber an in-flight manual download.
    if (_manualDownload || state.status === 'ready') return
    state.status = 'uptodate'; state.info = i; broadcast()
  })
  // F4 (2026-10-21): download stall watchdog. A hung transfer (proxy drop, dead mirror, firewall)
  // used to keep status='downloading' FOREVER — no progress event, no error event, so the settings
  // page spun and autoInstallOnAppQuit never armed. Every download-progress refreshes
  // _lastProgressAt and re-arms a 90s timer; when it fires with no newer progress and the download
  // is still in flight, we fail through the SAME honest-status + single-backoff-retry path as the
  // 'error' event. Cleared on success/error so a settled state is never re-marked.
  // Test-budget overrides (unit tests only; production uses the defaults — same pattern as the
  // adapter's roundIntervalMs overrides). READ ONCE per init so tests can shorten the windows.
  const STALL_WATCHDOG_MS = Number(process.env.PICKDONE_UPDATER_STALL_MS) || 90 * 1000
  const RETRY_BACKOFF_MS = Number(process.env.PICKDONE_UPDATER_RETRY_MS) || 30 * 1000
  let _stallTimer = null
  let _lastProgressAt = 0
  const clearStallWatchdog = () => { if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null } }
  // F4/D2 (2026-10-21): ONE arming point shared by every 'downloading' entry — a download that
  // hangs BEFORE its first progress event (dead proxy at connect) used to never arm the watchdog
  // (only 'download-progress' armed it) and stall in 'downloading' forever.
  const armStallWatchdog = () => {
    _lastProgressAt = Date.now()
    clearStallWatchdog()
    _stallTimer = setTimeout(() => {
      _stallTimer = null
      if (state.status !== 'downloading' || Date.now() - _lastProgressAt < STALL_WATCHDOG_MS) return
      log.warn('[Updater] download stalled: no progress for ' + (STALL_WATCHDOG_MS / 1000) + 's — failing into the retry path')
      markUpdateError(new Error('update download stalled (no progress for ' + (STALL_WATCHDOG_MS / 1000) + 's)'))
    }, STALL_WATCHDOG_MS)
    if (_stallTimer.unref) _stallTimer.unref()
  }
  _armStallWatchdog = armStallWatchdog // module-level so the manual downloadUpdate entry arms too
  // d-wave fix (2026-10-14): same 'ready' guard — a stray progress event after download completed
  // must not flip the settled 'ready' state back to 'downloading'.
  autoUpdater.on('download-progress', p => {
    if (state.status === 'ready') return
    state.status = 'downloading'; state.info = { percent: Math.round(p.percent || 0) }; broadcast()
    armStallWatchdog()
  })
  autoUpdater.on('update-downloaded', i => { clearStallWatchdog(); state.status = 'ready'; state.info = i; broadcast(); flushOnceOnReady() })
  // Error handling: besides broadcasting, schedule a single backoff retry (checkForUpdates after 30s).
  // Only one retry: transient network/proxy jitter self-heals; persistent failures (e.g. 404, certificate issues) are not retried, avoiding a request storm every 30s. During the retry window, a new error overwrites the state directly without queuing.
  let _retryTimer = null
  // F4: the error bookkeeping (status + broadcast + one 30s backoff retry) is shared by the
  // autoUpdater 'error' event AND the stall watchdog so a stalled download gets the identical
  // retry path instead of hanging in 'downloading' forever.
  function markUpdateError (e) {
    clearStallWatchdog()
    // M2b (P2 2026-10-23): 'ready' is terminal for this process run (same guard style as the
    // 'update-available' handler above) — a stray/late 'error' event (or watchdog fire) after
    // update-downloaded must not downgrade the "restart and install" state; the watchdog is
    // already cleared on success and the manual download settled, so there is nothing to abort.
    if (state.status === 'ready') return
    state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }; broadcast()
    // D2 fix (2026-10-21): if a MANUAL download is hung in flight, settle its promise NOW — the
    // old code left `_manualDownload` holding the dead promise and every later "Download now"
    // click returned the SAME hung promise forever (idempotent-reentry guard with no exit).
    try { if (_manualAbort) _manualAbort() } catch { /* best-effort */ }
    if (_retryTimer || !isActive()) return
    _retryTimer = setTimeout(() => {
      _retryTimer = null
      if (!isActive() || state.status === 'ready') return
      log.warn('[Updater] 自动重试检查更新（仅一次）')
      check().catch(() => {})
    }, RETRY_BACKOFF_MS)
    _retryTimer.unref?.()
  }
  autoUpdater.on('error', e => {
    markUpdateError(e)
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
      // M2b (P2 2026-10-23): same 'ready' guard as markUpdateError — a check() racing the tail of
      // a completed download must not flip the settled 'ready' into 'error'.
      if (state.status !== 'ready') {
        state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }
        broadcast() // 手动检查失败也要推给设置页状态条(error 事件路径之外的 catch 不经过 autoUpdater 事件)(三轮扫荡 P2)
      }
      return { active: true, ...state }
    } finally { _inFlight = null }
  })()
  return _inFlight
}

/** Manual download (settings page "Download now"): only meaningful in the "new version found but not auto-downloaded" state.
 *  D10 (2026-09-27): idempotent — a second click while a manual download is in flight returns the
 *  SAME in-flight promise (identity, not a wrapper) instead of double-calling
 *  autoUpdater.downloadUpdate; and while it runs, the event guards above keep a concurrent check()
 *  from resetting state mid-download. */
let _manualDownload = null
function downloadUpdate () {
  if (_manualDownload) return _manualDownload
  if (!isActive() || state.status !== 'available') return Promise.resolve(false)
  // D2 fix (2026-10-21): abort handle — markUpdateError (watchdog stall or 'error' event) fires
  // this while the underlying downloadUpdate() hangs, so this promise settles and the reentry
  // guard clears; the next click starts a FRESH download instead of receiving the dead one.
  let abortNow = null
  const abortPromise = new Promise(res => { abortNow = res })
  _manualDownload = (async () => {
    // C5 (2026-10-02): the manual path set autoDownload=true and NEVER restored the user's
    // opt-out — after one "Download now" the setting behaved as auto-download-on for the rest
    // of the process (the next check() downloaded without consent until the settings toggle
    // was re-saved). Capture the prior value and restore it in finally: success, failure and
    // the idempotent-reentry path all leave the consent flag exactly as they found it.
    const priorAutoDownload = autoUpdater.autoDownload !== false
    autoUpdater.autoDownload = true
    state.status = 'downloading'; broadcast()
    try { if (_armStallWatchdog) _armStallWatchdog() } catch { /* arming is best-effort */ }
    // The raw promise gets a noop catch so a LATE rejection after an abort cannot surface as an
    // unhandled rejection; the derived `settled` maps both outcomes to a tag.
    const settled = autoUpdater.downloadUpdate().then(() => 'done', () => 'failed')
    settled.catch(() => {}) // belt and braces for the derived promise itself
    try {
      const outcome = await Promise.race([settled, abortPromise.then(() => 'aborted')])
      if (outcome === 'done') return true
      if (outcome === 'aborted') return false // status already 'error' via markUpdateError
      // 'failed': the autoUpdater 'error' event already recorded the failure state
      return false
    } catch (e) {
      state.status = 'error'; state.info = { message: String(e && e.message || e).slice(0, 200) }; broadcast()
      return false
    } finally {
      _manualDownload = null
      _manualAbort = null
      autoUpdater.autoDownload = priorAutoDownload
    }
  })()
  _manualAbort = abortNow
  return _manualDownload
}

// W16 (2026-10-28) pre-install sync-safety settle: quitAndInstall runs OUTSIDE the quit chain
// (it skips will-quit entirely — electron-updater spawns the installer whose customInit
// taskkills the process), so the quit-path flush triggers must be re-fired HERE or everything
// not yet on disk when the installer lands is lost — including the LAN sync round boundary.
// Mirrors flushOnceOnReady's trigger set, synchronously:
//   1. the debounced dbMirror/reminder flush (same scheduler trigger index.js's quit flush uses)
//   2. stopSyncForQuit: closes the in-flight LAN round sockets (each round settles through its
//      normal failure path) and persists pull/push watermarks + the security ring while the DB
//      handle is still open.
// Bounded-wait note: quitAndInstall's contract is a SYNCHRONOUS boolean (index.js's D10
// quit-hang fallback calls it and branches on the return value, so it cannot await). The
// tokenized bounded handshake for renderer-pending writes already ran at 'update-downloaded'
// (flushOnceOnReady -> quit-ack.runFlushRound, 2s cap); this settle hard-commits the
// main-process side at the install moment itself.
function preInstallSyncSettle () {
  try { require('./scheduler').flushFiredNow() } catch (e) { try { log.warn('[Updater] pre-install scheduler flush failed:', e && e.message) } catch { /* best-effort */ } }
  try {
    const lanSync = require('./lan-sync-bootstrap')
    if (typeof lanSync.stopSyncForQuit === 'function') {
      // Fire-and-forget: the stop's internal await chain (server close -> watermark persist)
      // races the installer's taskkill by design margin; quitting without it would race with
      // NO settle at all (in-flight rounds would hold sockets and unsent watermarks into the kill).
      const p = lanSync.stopSyncForQuit()
      if (p && typeof p.catch === 'function') p.catch(() => { /* best-effort */ })
    }
  } catch (e) { try { log.warn('[Updater] pre-install LAN sync settle failed:', e && e.message) } catch { /* best-effort */ } }
}

function quitAndInstall () {
  if (isPortable || state.status !== 'ready') return false
  preInstallSyncSettle()
  autoUpdater.quitAndInstall(true, true) // silent + runAfter: skips the install wizard and auto-launches the new version after update (smooth default)
  return true
}

function getStatus () {
  return { active: isActive(), version: require('electron').app.getVersion(), ...state }
}

module.exports = { init, check, downloadUpdate, quitAndInstall, getStatus, flushOnceOnReady, forwardFlushAck,
  preInstallSyncSettle, // W16: pre-install sync-safety settle (unit-testable: flush triggers fire before the installer spawns)
  syncAutoDownload, // updater-config-read-fail-open fix: unit-testable decision (plain node + __setConfigDir)
}
