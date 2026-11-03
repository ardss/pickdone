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
// Issue #224: lastCheckError carries the CLASSIFIED failure (kind FEED_MISSING vs TRANSIENT +
// message + timestamp) so the settings page can tell "this tag has no published release assets
// (no latest.yml)" apart from a generic network failure. Cleared by the next successful check.
const state = { status: 'idle', info: null, lastCheckError: null } // idle|checking|downloading|available|ready|uptodate|error

// Issue #224 fix 1 (P0 404 retry storm): the pre-fix markUpdateError armed a 30s backoff retry
// whose own checkForUpdates rejection re-fired the autoUpdater 'error' event, which armed ANOTHER
// backoff — an unbounded timer chain (main.log: a 404 on /releases/download/v0.4.0-beta.24/
// latest.yml was re-requested every 30s for minutes). Two bounds now apply:
//   * FEED_MISSING-class failures ("the resource is not there": HTTP 404, DNS ENOTFOUND, no
//     published GitHub versions) are NEVER retried by the backoff — the next periodic/manual
//     check cycle is the retry, at its natural cadence.
//   * TRANSIENT failures (network/proxy jitter) keep the backoff retry but capped at
//     MAX_ERROR_RETRIES per wake (a wake = an externally-initiated check(): 4h periodic or
//     manual); the budget resets at every wake and on every timer we stop scheduling.
const MAX_ERROR_RETRIES = 3
let _errorRetries = 0 // backoff retries spent in the current wake (reset by each externally-initiated check())
// Issue #224 fix 2 (P0 feed consistency): classify update failures so a missing feed/release is
// distinguishable from a transient network fault. electron-updater surfaces the beta.24 case as an
// HttpError (statusCode 404, message mentions the yml asset / HTTP code), DNS outage as
// code ENOTFOUND, and the channel-mismatch case as "No published versions on GitHub".
function classifyUpdateError (e) {
  const msg = String((e && e.message) || e)
  const code = (e && e.statusCode) || (e && e.code) || ''
  if (code === 404 || code === 'ENOTFOUND' || /\b404\b/.test(msg) || /ENOTFOUND/i.test(msg) ||
    /no published versions/i.test(msg)) return 'FEED_MISSING'
  return 'TRANSIENT'
}

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
// W27 (P3): true while ANY download (manual or auto) is in flight — set at every entry into
// 'downloading', cleared on the terminal 'ready' and on every error path. A concurrent check()
// firing update-not-available/checking mid-download used to flip the status to 'uptodate'/
// 'checking' because the existing guards only covered _manualDownload and the settled 'ready'.
let _downloading = false
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
    if (_manualDownload || _downloading || state.status === 'ready') return
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
    if (_manualDownload || _downloading || state.status === 'ready') return
    state.status = autoUpdater.autoDownload ? 'downloading' : 'available'; state.info = i; broadcast()
    if (state.status === 'downloading') _downloading = true // W27: auto-download owns the state from here
    // D2 fix (2026-10-21): the auto-download entry into 'downloading' arms the stall watchdog
    // too — the hang-before-first-progress case is reachable from here just as much.
    if (state.status === 'downloading' && _armStallWatchdog) { try { _armStallWatchdog() } catch { /* arming is best-effort */ } }
  })
  autoUpdater.on('update-not-available', i => {
    // M2b (P2 2026-10-23): same guards as 'update-available' above — a later check() firing
    // update-not-available must not downgrade a settled 'ready' (a downloaded update is already
    // on disk; quitAndInstall requires status==='ready') nor clobber an in-flight manual download.
    if (_manualDownload || _downloading || state.status === 'ready') return
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
    state.status = 'downloading'; _downloading = true // W27: progress confirms a live download
    state.info = { percent: Math.round(p.percent || 0) }; broadcast()
    armStallWatchdog()
  })
  autoUpdater.on('update-downloaded', i => { clearStallWatchdog(); _downloading = false; state.status = 'ready'; state.info = i; broadcast(); flushOnceOnReady() })
  // Error handling: besides broadcasting, schedule a bounded backoff retry (checkForUpdates after 30s).
  // Issue #224 rework (P0): the old "only one retry" claim was false in practice — electron-updater
  // ALSO emits the 'error' event for a checkForUpdates rejection, so the retry's own failure re-armed
  // the backoff forever (a 404 on a missing latest.yml was re-requested every 30s; main.log 02:02-02:04).
  // Now: FEED_MISSING-class failures (404 / ENOTFOUND / no published versions) never arm the backoff —
  // the next periodic/manual check is the retry; TRANSIENT failures keep the backoff but capped at
  // MAX_ERROR_RETRIES per wake. During the retry window, a new error overwrites the state directly
  // without queuing.
  let _retryTimer = null
  // F4: the error bookkeeping (status + broadcast + backoff retry) is shared by the
  // autoUpdater 'error' event AND the stall watchdog so a stalled download gets the identical
  // retry path instead of hanging in 'downloading' forever.
  function markUpdateError (e) {
    clearStallWatchdog()
    _downloading = false // W27: an error is terminal for the in-flight download
    // M2b (P2 2026-10-23): 'ready' is terminal for this process run (same guard style as the
    // 'update-available' handler above) — a stray/late 'error' event (or watchdog fire) after
    // update-downloaded must not downgrade the "restart and install" state; the watchdog is
    // already cleared on success and the manual download settled, so there is nothing to abort.
    if (state.status === 'ready') return
    const kind = classifyUpdateError(e)
    const message = String(e && e.message || e).slice(0, 200)
    const firstSeen = !(state.lastCheckError && state.lastCheckError.kind === kind && state.lastCheckError.message === message)
    state.status = 'error'; state.info = { message }
    // #224 fix 3: expose the classified failure + when it happened (getStatus merges state verbatim)
    state.lastCheckError = { kind, message, at: Date.now() }
    // #224 fix 2: no error toast storm — a REPEATED identical FEED_MISSING failure (every silent
    // poll hitting the same 404) is recorded in state but NOT re-broadcast; first occurrence only.
    if (kind !== 'FEED_MISSING' || firstSeen) broadcast()
    // D2 fix (2026-10-21): if a MANUAL download is hung in flight, settle its promise NOW — the
    // old code left `_manualDownload` holding the dead promise and every later "Download now"
    // click returned the SAME hung promise forever (idempotent-reentry guard with no exit).
    try { if (_manualAbort) _manualAbort() } catch { /* best-effort */ }
    if (kind === 'FEED_MISSING') {
      if (firstSeen) log.warn('[Updater] 更新源缺失（' + message + '）— 不做退避重试，等待下个静默检查周期')
      return // #224 fix 1: the resource is not there — retrying in 30s cannot help
    }
    if (_retryTimer || !isActive() || _errorRetries >= MAX_ERROR_RETRIES) return
    _errorRetries++
    _retryTimer = setTimeout(() => {
      _retryTimer = null
      if (!isActive() || state.status === 'ready') return
      log.warn('[Updater] 自动重试检查更新（第 ' + _errorRetries + '/' + MAX_ERROR_RETRIES + ' 次）')
      runCheck().catch(() => {})
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
// The bare check body (shared by the external check() and the #224 bounded backoff retry — the
// retry must NOT reset its own budget, or the cap could never bind).
async function runCheck () {
  if (!isActive()) return { active: false, ...state }
  if (_inFlight) return _inFlight // 并发重入护栏:4h 定时/手动/错误重试三者可能重叠(2026-09-05 终审 P2)
  _inFlight = (async () => {
    syncAutoDownload() // align with the settings-page toggle before every check (hot-applied, no restart needed)
    try {
      const r = await autoUpdater.checkForUpdates()
      if (r) state.lastCheckError = null // a successful check clears the stale classified failure (#224 fix 3)
      return { active: true, ...state }
    } catch (e) {
      // M2b (P2 2026-10-23): same 'ready' guard as markUpdateError — a check() racing the tail of
      // a completed download must not flip the settled 'ready' into 'error'.
      // W27 (P3): nor may it flip an in-flight download into 'error' — the download's own
      // error/watchdog paths own that transition; respect _downloading like the event handlers.
      if (state.status !== 'ready' && !_downloading) {
        const message = String(e && e.message || e).slice(0, 200)
        const kind = classifyUpdateError(e)
        state.status = 'error'; state.info = { message }
        // #224 fixes 2+3: a check()-path failure (a manual check outside the autoUpdater 'error'
        // event) carries the same classified failure so "no latest.yml for this tag" is readable
        // from state instead of looking like a generic network failure.
        state.lastCheckError = { kind, message, at: Date.now() }
        // #224 fix 2: same no-toast-storm rule as markUpdateError — a repeated identical
        // FEED_MISSING failure is recorded but not re-broadcast (first occurrence only).
        if (kind !== 'FEED_MISSING' || !(state.lastCheckError && state.lastCheckError.kind === kind && state.lastCheckError.message === message)) broadcast()
      }
      return { active: true, ...state }
    } finally { _inFlight = null }
  })()
  return _inFlight
}
/** External check entry (4h periodic / manual / startup): a NEW wake — resets the bounded backoff
 *  retry budget (#224 fix 1) so each wake gets a fresh, capped set of transient-error retries. */
async function check () {
  _errorRetries = 0
  return runCheck()
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
    state.status = 'downloading'; _downloading = true; broadcast() // W27: manual path arms the guard too
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
      _downloading = false // W27: settled (done/failed/aborted) — release the state ownership
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
  classifyUpdateError, // #224: unit-testable feed-missing vs transient classification
}
