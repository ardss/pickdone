/**
 * Pomodoro float window (aligned with the reference show-tomato-floating / internal reference implementation)
 * 131×44 transparent frameless always-on-top toolbar window, default bottom-right of the screen; whole-card drag = main-process 16ms timer following the cursor
 */
const { BrowserWindow, screen, ipcMain } = require('electron')
const path = require('path')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const { attachLoadGuard } = require('./aux-load-guard')
const db = require('./db')

const W = 240
const H = 320 // Fixed-height window: 240×86 card docked at the bottom, upper space reserved for the ⋮ menu/♪ noise/abandon-confirm expansion (2026-09-02 second decision: back to constant height)
const CARD_H = 86 // Persistent card height (DIP)
// Record of the two decision rounds on window height:
//  - Constant 320: ⋮/♪ expand/collapse is a pure CSS animation inside the window (GPU-composited, silky);
//    the cost is 234px of idle transparent area on top, where DWM "ghost repaint" once appeared
//    (drawing the system title text at the top-left) — root cause: a non-empty window title gets used by DWM.
//    Setting title:'' in create() leaves it nothing to draw, cutting off the ghost; the empty area blocking the
//    desktop is handled by main-process click-through polling (click-through whenever the cursor is outside
//    the interactive area, see isInsideHit/startHitPoll).
//  - Content-fitted (idle 86, expands to 320): the ghost indeed has no surface to appear on, but every
//    expand/collapse requires an OS-level setBounds, the fade-out gets hard-clipped and races the CSS
//    animation, losing all smoothness (rejected by the user). Kept as decision rationale to avoid backsliding.

let win = null
let dragTimer = null
let dragCtx = null
let dockedToTray = false // docked to tray: window hidden but the instance kept; the tray icon carries the state
let screenHooksOn = false
// M2 P3 (2026-10-09): the reopen-during-load path used to append a fresh did-finish-load once
// listener on EVERY reopen call while the frame was still loading — N wakes during one load
// queued N closures and all of them fired (N redundant showInactive+flushPaint rounds) when the
// load finished. Bound single-handler pattern (same shape as windows.js's replayed shortcuts):
// mount removes the previous handler first, so at most one is ever attached.
let pendingLoadShow = null

/* ---- C10 (2026-09-25): crash-rebuild cap (aligned with windows.js crashReloadCount<3) ----
 * W16 (2026-10-28) re-baselined: the cap used to be "3 CONSECUTIVE rebuilds, refilled as soon as a
 * rebuilt window reached ready-to-show" — and ready-to-show is exactly the fake-health signal behind
 * the recurring "window exists, content invisible" incident (HWND alive, isVisible=true, load events
 * fired, screen blank). Two changes:
 *   1. the refill signal is now the RENDER HEALTH HANDSHAKE (noteRenderHandshake — the float page
 *      reports it only after its card DOM is actually mounted; see __renderHealth below);
 *   2. the budget is a rolling 5-minute window of at most 3 auto-rebuilds (crash OR handshake
 *      failure share the same budget), so a slow-drip failure mode cannot live forever on resets.
 * Beyond the budget the float stays down until the user opens it explicitly (an explicit show()
 * also resets — a deliberate user action is the strongest health signal we get) and ONE structured
 * 'float-recovery-exhausted' report goes to the main window over the existing syncEvent channel.
 * Exported as `crashRebuild` (pure, unit-testable without booting Electron windows). */
const CRASH_REBUILD_CAP = 3
const RECOVERY_WINDOW_MS = 5 * 60_000
let recoveryStamps = []
const crashRebuild = {
  /** Consume one rebuild slot within the rolling window; false once the cap is exhausted
   *  (no further auto-rebuild until stamps expire out of the window or reset() runs). */
  allow (now = Date.now(), windowMs = RECOVERY_WINDOW_MS, cap = CRASH_REBUILD_CAP) {
    recoveryStamps = recoveryStamps.filter(t => now - t < windowMs)
    if (recoveryStamps.length >= cap) return false
    recoveryStamps.push(now)
    return true
  },
  reset () { recoveryStamps = [] },
  get count () {
    recoveryStamps = recoveryStamps.filter(t => Date.now() - t < RECOVERY_WINDOW_MS)
    return recoveryStamps.length
  },
}

/* ---- W16 (2026-10-28): render-health handshake ----
 * The float page calls the EXISTING 'set-tomato-float-bounds' IPC (preload facade unchanged) once its
 * Vue component has mounted AND $nextTick confirmed the card (.tomato) is actually in the DOM — see
 * TomatoFloatPage.vue mounted(). module.exports.setBounds (the only caller of that channel) records
 * the handshake here. aux-load-guard arms a HANDSHAKE_TIMEOUT_MS watch after every did-finish-load;
 * a handshake that never arrives inside the window drives the bounded rebuild path. Ready-to-show /
 * did-finish-load are NOT consulted anywhere as proof of health anymore. */
const HANDSHAKE_TIMEOUT_MS = 10000
let lastHandshakeAt = 0
function noteRenderHandshake (now = Date.now()) {
  lastHandshakeAt = now
  crashRebuild.reset() // proof of health = card DOM alive, not ready-to-show (W16)
}
/** Pure decision (exported via __renderHealth for unit tests): is the last handshake RECENT?
 * W20 fix (2026-10-30): the previous "handshake arrived since armedAt" semantics deadlocked on the
 * real boot sequence — vue-router's post-mount same-document navigations fire a SECOND did-finish-load
 * ~50ms AFTER the one-shot handshake (the channel repositions the window, so it must stay one-shot),
 * which re-arms armedAt ABOVE lastHandshakeAt; every 10s check then fails → destroy+rebuild loop at
 * ~11s cadence, self-sustaining because each cycle's own handshake calls crashRebuild.reset(). The
 * health fact the handshake proves ("card DOM mounted, page JS running") does not expire because a
 * later arm happened, so health is now RECENCY-based: any handshake within 2× the timeout window.
 * A genuinely dead window never handshakes → its age grows unbounded → still caught. */
function handshakeHealthySince (_armedAt, now = Date.now()) {
  return now - lastHandshakeAt < HANDSHAKE_TIMEOUT_MS * 2
}

/* ---- W16: bounded recovery exhaustion report (one structured message per session per cause) ----
 * Emitted over the EXISTING 'syncEvent' Device-Center channel to the MAIN window (window-ref — no
 * reverse require of index.js). Renderer side picks it up in utils/syncDegradedToast.js with the
 * sync.floatRecoveryExhausted i18n key (en/zh). The diagnostics probe stays available afterwards. */
let exhaustionReported = false
function reportRecoveryExhausted (code) {
  if (exhaustionReported) return
  exhaustionReported = true
  log.error('[TomatoFloat] float recovery exhausted (' + code + '); auto-rebuild stopped until the user reopens the float; diagnose() remains available')
  // Structured report over the EXISTING Device-Center syncEvent channel (lan-sync-bootstrap's
  // emitSyncEvent — the r6 gate requires emit sites and renderer evt.type consumers to stay
  // set-equal, so the emit MUST go through it rather than a raw webContents.send).
  try {
    const bootstrap = require('./lan-sync-bootstrap')
    if (typeof bootstrap.emitSyncEvent === 'function') bootstrap.emitSyncEvent('float-recovery-exhausted', { code })
    else throw new Error('emitSyncEvent unavailable')
  } catch (e) {
    // degrade: direct send to the main window over the same 'syncEvent' channel (window-ref — no
    // reverse require of index.js); renderer still surfaces it via syncDegradedToast.
    try {
      const { getMainWindow } = require('./window-ref')
      const mw = getMainWindow()
      if (mw && !mw.isDestroyed()) mw.webContents.send('syncEvent', { type: 'float-recovery-exhausted', code, at: Date.now() })
    } catch (e2) { /* renderer notification is best-effort */ }
  }
}

/** W16: shared bounded rebuild for the handshake-failure path (render-process-gone keeps its own
 *  handler but consumes the SAME windowed budget via crashRebuild). Destroy → delayed reopen: the
 *  500ms gap lets 'closed' reset the module state before reopen() lazily recreates a fresh window
 *  (same shape as the crash path). */
function rebuildAfterHandshakeFailure (code) {
  stopDrag()
  stopHitPoll()
  if (!crashRebuild.allow()) { reportRecoveryExhausted(code); return }
  log.warn('[TomatoFloat] ' + code + ' — rebuilding float window (' + crashRebuild.count + '/' + CRASH_REBUILD_CAP + ' auto-rebuilds in the last 5min)')
  try { if (win && !win.isDestroyed()) win.destroy() } catch (e) { /* already gone */ }
  setTimeout(() => { try { module.exports.reopen() } catch (e) { log.warn('[TomatoFloat] handshake-failure rebuild failed', e) } }, 500)
}

/* ---- "user explicitly closed the float" marker (F12, 2026-09-24 adversarial-review round 2) ----
 * Persisted in the todo DB meta table so it survives restarts; the renderer main.js auto-show gate
 * (6s after start) reads it via todo-db:call getMeta and must not resurrect a float the user closed.
 * OWNERSHIP lives HERE, in the single convergence point of every open/close path — an earlier attempt
 * wrapped window.todoAPI.showTomatoFloat in the renderer, but contextBridge objects are read-only
 * (strict-mode ESM assignment throws; the wrapper never installed). All paths converge on this module:
 *   close paths → hide() (TomatoBar toggle, float ✕ while idle, SettingsModal switch off — all via
 *                 'hide-tomato-float'; during focus/rest the float ✕ opens the give-up confirm instead);
 *                 dock() is deliberately NOT a close (undock restores the same session intent).
 *   open paths  → show() AND undock() clear the marker (IPC 'show-tomato-float' from SettingsModal /
 *                 TomatoPanel / TomatoBar, tray undock, auto-show itself — harmless no-op there). */
const CLOSED_BY_USER_KEY = 'tomatoFloatClosedByUser'

function setUserClosed (closed) {
  try {
    if (!db.isOpen()) return // DB not initialized yet (early startup / bare unit env): nothing to persist
    db.call(closed ? 'setMeta' : 'deleteMeta', closed ? [CLOSED_BY_USER_KEY, '1'] : CLOSED_BY_USER_KEY)
  } catch (e) { log.warn('[TomatoFloat] persist closed-marker failed', e) }
}

function isUserClosed () {
  try {
    if (!db.isOpen()) return false
    return db.call('getMeta', CLOSED_BY_USER_KEY) === '1'
  } catch (e) { return false }
}
/** Re-clamp bounds after wake-from-sleep / monitor unplug: in click-through state the float cannot even be
 *  dragged, so once it drifts off-screen it is unrecoverable. screen 是进程级单例:create() 可能多次执行,
 *  监听器必须在模块级只挂一次(否则随窗口重建无限累积,2026-09-05 终审 P2) */
function ensureScreenHooks () {
  if (screenHooksOn) return
  screenHooksOn = true
  screen.on('display-metrics-changed', () => safeReclamp())
  screen.on('display-removed', () => safeReclamp())
}

// C8 (2026-09-26): both screen-event callbacks synchronously ran setBounds() → defaultBounds()
// → screen.getPrimaryDisplay().bounds with no try/catch — a throw from the screen API during
// the display-removal transition fired an UNCAUGHT EXCEPTION in the main process. Same hardening
// convention as startHitPoll's tick ('transient screen API errors must not break the poll') and
// undock's applyIgnore: the re-clamp intent stays, a failure becomes a logged no-op.
// W16 (2026-10-28) refinement: the clamp used to fire on EVERY display-metrics-changed (incl. DPI
// changes on OTHER monitors), yanking an on-screen float (e.g. dragged onto a secondary display)
// back to the primary display's default corner. Now it only repositions when the float's current
// bounds are off-screen on EVERY display — the monitor-unplug "float left at dead coordinates"
// case the clamp exists for — via the pure floatBoundsVisible test (same center-or-corner rule
// as windows.js windowBoundsVisible).
/** Pure geometry test (exported for unit tests): a float counts as on-screen when its CENTER or
 *  ANY CORNER lies inside some display's workArea. */
function floatBoundsVisible (b, displays) {
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

function safeReclamp () {
  try {
    if (!win || win.isDestroyed()) return
    let visible = null // null = display topology could not be read at all
    try { visible = floatBoundsVisible(win.getBounds(), screen.getAllDisplays()) } catch (e) { /* fall through to the legacy guarded clamp */ }
    if (visible === true) return // on-screen: leave the user's placement alone (W16 P1 — no more primary-display yank)
    // off-screen (the monitor-unplug case this clamp exists for) OR topology unreadable → guarded
    // clamp; setBounds → defaultBounds → getPrimaryDisplay throws land in THIS catch and are logged
    setBounds()
  } catch (e) { try { log.warn('[TomatoFloat] display-change re-clamp failed', e) } catch { /* logging is best-effort */ }
  }
}

function dock () {
  dockedToTray = true
  // 拖拽中入托盘:必须清 dragCtx,否则 16ms 轮询永久空转搬运隐藏窗口,undock 后仍被旧 ctx 挟持跟 cursor
  // (hide() 同款语义,dock 侧对称补齐 2026-09-05 回归审查 P1)
  stopDrag()
  stopHitPoll()
  applyIgnore(true)
  if (win && !win.isDestroyed()) win.hide()
}

function undock () {
  dockedToTray = false
  setUserClosed(false) // re-opening via the tray is an explicit user open: the close marker must not survive it
  // Window never created (float disabled at startup) or destroyed: lazy-create via show(), otherwise the tray's "show float window" click would never respond (false affordance)
  if (!win || win.isDestroyed()) { module.exports.show(); return }
  win.showInactive()
  // Fault-11 (D12 2026-10-01): the bare setBounds() → defaultBounds() → screen.getPrimaryDisplay()
  // chain threw out of the tray-menu click handler when the display unplug landed mid-undock —
  // an uncaught exception in the main process. Route through the C8 guarded re-clamp: the intent
  // stays, a screen-API throw becomes a logged no-op (same convention as the screen-event hooks).
  safeReclamp()
  // dock() 走 stopHitPoll+applyIgnore(true),undock 必须对称补链:否则轮询不重启且 lastIgnore 卡死 true,
  // 窗口永久 click-through——看得见、点不到、拖不动(2026-09-05 "浮窗拖不动"根因一)
  startHitPoll()
  try { applyIgnore(!isInsideHit(screen.getCursorScreenPoint(), win.getBounds(), panelOpen, CARD_H)) } catch (e) { /* backstopped by the next poll round */ }
}

function isDocked () { return dockedToTray }

/** Restore default bounds (called when undocking from tray; same logic as the module-exported setBounds) */
function setBounds () {
  if (win && !win.isDestroyed()) win.setBounds(defaultBounds())
}

function defaultBounds () {
  const { width, height } = screen.getPrimaryDisplay().bounds
  return { x: width - W - 40, y: height - 124 - H, width: W, height: H }  // card bottom edge sits 124 (DIP) above the taskbar
}

function create () {
  ensureScreenHooks()
  win = new BrowserWindow({
    ...defaultBounds(),

    // 2026-08-31 root cause confirmed: without backgroundColor, BrowserWindow defaults to white —
    // the culprit behind pre-first-frame and corner/box white flashes. Transparent window + explicit
    // fully transparent background (officially recommended) makes the rounded corners stable
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    useContentSize: true,
    frame: false,
    show: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    // 2026-09-02 root cause decision: focusable:false (non-activatable). Known regression in Electron
    // 35/36/37 (electron#46882: a transparent frameless window gets its non-client area repainted by
    // DWM on blur = a system title bar appears out of nowhere; the official fix #47386 only lands in v39)
    // — a window that never activates never blurs, eliminating the trigger condition rather than patching it.
    // Community testing on 35.x confirmed focusable:false yields no title bar. Side benefit: clicking the
    // float no longer steals focus from the user's working window (a float shouldn't steal focus anyway).
    // Cost: the float receives no keyboard input (only Escape closes menus; menus already have ✕/re-click
    // to close, acceptable). Re-evaluate after upgrading to v39.
    focusable: false,
    resizable: false,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    // thickFrame:false removes WS_THICKFRAME: transparent frameless windows on Windows occasionally show DWM ghosting
    // (a system title bar/minimize rectangle appears behind the window and only disappears after one drag); the root cause is the system border layer not repainting with the transparent pixels
    thickFrame: false,
    // roundedCorners:false (2026-09-02 third decision): Win11 native rounded corners = DWM compositing of a
    // right-angle rectangle plus a corner mask; when a content transition (e.g. the abandon popover tf-pop)
    // triggers full-window recompositing, the mask briefly fails → right-angle corners flash on the card
    // (another manifestation of the electron#46882 family, confirmed by user screenshots). Rounded corners
    // are handled by CSS instead: the card already draws its own --radius-lg corners + border, and with the
    // native layer off the right-angle rectangle has no carrier. Cost: a very low probability of CSS corner
    // compositing failure falling back to right angles (historically covered by the native layer); less
    // frequent than this ghost, so worth the trade.
    roundedCorners: false,
    // Title must be empty: the DWM ghost repaint draws the window title text (it once drew "拾事"
    // in the top-left of the idle transparent area). Now that the window is back to constant 320 height
    // with an idle area, an empty title leaves the ghost nothing to draw (2026-09-02 second decision)
    title: '',
    // Aligns with the community-verified ghost-free combination on 35.x (electron#46882 comments): the
    // system shadow layer of a transparent window is also a source of DWM repaint residue, and the float's
    // visual boundary is already a self-drawn 1px border (shadow disabled), so nothing is lost
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'dock', 1)
  win.setVisibleOnAllWorkspaces(true)
  win.setMenu(null)
  // Trigger-chain observability (active when FLOAT_HIT_DBG=1): the trigger chain of the electron#46882 ghost
  // title bar = activate → blur → DWM repaints the non-client area. With focusable:false, focus/blur never
  // fire = the trigger chain physically cannot exist
  if (process.env.FLOAT_HIT_DBG) {
    win.on('focus', () => log.info('[TomatoFloat][dbg] window FOCUS（旧版在此后 blur 时长出标题栏）'))
    win.on('blur', () => {
      // D10: a mid-drag blur (renderer froze / OS stole activation) must end the drag — the
      // sender-gated dragStop may never arrive.
      if (dragCtx) stopDrag()
      log.info('[TomatoFloat][dbg] window BLUR ← 幽灵标题栏触发点')
    })
  }
  // The float only ever serves __tomato-float: block all page-level navigation and popups (prevents anchors/mis-clicks from opening framed child windows)
  // 2026-08-31 root-cause fix: the app:// page occasionally fails to load (any HTML/CSS failure cripples the
  // whole window — error page/unstyled layout; the "rectangle/incomplete/broken" the user kept seeing was
  // this), and after failure it stays stuck on the error page with no retry. F16 refactor (2026-09-24):
  // the retry/destroy policy moved to the shared aux-load-guard (quick-add.js had drifted to have none).
  attachLoadGuard(win, {
    url: 'app://app/renderer-dist/index.html#/__tomato-float',
    routeMark: '__tomato-float',
    tag: 'TomatoFloat',
    onRetry: () => stopHitPoll(),
    onExhausted: () => { stopDrag(); stopHitPoll() },
    // W16: did-finish-load alone is NOT health — watch for the renderer handshake (the float page
    // reports it after its card DOM is mounted) and rebuild within the bounded budget otherwise.
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    isHandshakeHealthy: (armedAt) => handshakeHealthySince(armedAt),
    onHandshakeTimeout: () => rebuildAfterHandshakeFailure('render-handshake-timeout'),
  })
  // 渲染进程崩溃自愈(2026-09-09,与主窗 render-process-gone 同类):did-fail-load 只覆盖加载失败,
  // 渲染进程崩溃后浮窗从此白屏/无响应且永不恢复。崩溃时销毁重建;若崩溃前可见(番茄进行中)则延迟重开。
  // C10 (2026-09-25): the rebuild used to be UNLIMITED — a renderer that crashes in a tight loop
  // (poisoned local state, GPU driver death spiral) turned self-heal into a crash-loop generator.
  // Aligned with the main window's precedent (windows.js:135-144, crashReloadCount<3): at most 3
  // consecutive auto-rebuilds, counter reset when a rebuilt window actually reaches ready-to-show
  // (same "reset on proof of health" semantics). Beyond the cap the float stays down until the
  // user opens it explicitly (an explicit show() also resets — a deliberate user action is the
  // strongest health signal we get).
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details && details.reason
    log.error('[TomatoFloat] render-process-gone:', reason, 'exitCode=', details && details.exitCode)
    if (!reason || reason === 'clean-exit') return
    const wasVisible = !!(win && !win.isDestroyed() && win.isVisible())
    stopDrag()
    stopHitPoll()
    try { if (win && !win.isDestroyed()) win.destroy() } catch (e) { /* already gone */ } // 'closed' 会复位 win=null
    if (wasVisible && crashRebuild.allow()) {
      setTimeout(() => { try { module.exports.reopen() } catch (e) { log.warn('[TomatoFloat] 崩溃重建失败', e) } }, 500)
    } else if (wasVisible) {
      reportRecoveryExhausted('render-process-gone') // W16: structured one-shot report (logs in EN above)
      log.error('[TomatoFloat] 崩溃重建超限(' + CRASH_REBUILD_CAP + ' 次),浮窗不再自动重建,等待用户手动打开')
    }
  })
  win.webContents.on('will-navigate', (e, url) => {
    // Same-origin prefix guard, aligned with the main window (index.js): a substring match would let
    // any scheme through via the route marker (e.g. https://evil.com/#__tomato-float)
    if (!/^app:\/\/app\//i.test(String(url))) e.preventDefault()
  })
  // The page <title> writes back to the window title after load (index.html's "拾事…" is shared across
  // all pages); once the window title is non-empty, the DWM ghost repaint has text to draw again (the
  // project name surfaces at the top-left of the idle transparent area) — intercept it here permanently:
  // keep the title as an empty string so the ghost has nothing to draw (2026-09-03 root fix; title:'' only
  // guards the initial frame)
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault()
    if (win && !win.isDestroyed() && win.getTitle() !== '') win.setTitle('')
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL('app://app/renderer-dist/index.html#/__tomato-float').catch(e => log.error('[TomatoFloat] loadURL failed', e))
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    // W16: crashRebuild.reset() REMOVED from here — ready-to-show is the fake-health signal behind
    // the "window alive, content invisible" incident. The budget now refills on the render-health
    // handshake (noteRenderHandshake) instead.
    win.showInactive()
    // After show, flush the bounds in place to force DWM to repaint the transparent layer (backstop against ghosting; dragging "erases" the ghost via this same mechanism)
    try { win.setBounds(win.getBounds()) } catch (e) { /* empty */ }
  })
  // F10 (2026-09-24): panelOpen must reset here too. 'closed' fires on every destroy path (user destroy
  // after did-fail-load retries exhausted, render-process-gone rebuild); without the reset the module-level
  // panelOpen stayed true into the NEXT window instance, so startHitPoll hit-tested the fresh 320px window
  // as "panel open" = whole window (incl. ~234px transparent idle area) clickable — an invisible wall
  // blocking the desktop until the renderer happened to report panel state again.
  win.on('closed', () => { stopDrag(); stopHitPoll(); panelOpen = false; lastIgnore = null; win = null })
  // P2 2026-09-20: the hit poll self-stops after ~1s of hidden ticks; an OS-level restore
  // (un-minimize) or focus/activation makes the window visible again WITHOUT going through
  // show() — the poll then stayed stopped and the card never became hoverable/clickable again.
  // 'restore' covers minimize→restore; 'focus' covers activation paths that imply visibility
  // (best-effort: the window is focusable:false on some platforms, so 'focus' may not fire —
  // 'restore' is the load-bearing event). Guarded: only restarts when actually visible.
  const ensureHitPoll = () => {
    try { if (win && !win.isDestroyed() && win.isVisible() && !dockedToTray) startHitPoll() } catch { /* window dying */ }
  }
  win.on('restore', ensureHitPoll)
  win.on('focus', ensureHitPoll)
  return win
}

// D10 (2026-09-27): drag failsafe cap. The 16ms drag loop's only exits were a destroyed window or
// a thrown setBounds — if the float renderer freezes/crashes mid-drag its pointerup/pointercancel
// (dragStop, sender-gated) never arrives and the card tracks the cursor at 60fps indefinitely
// (hit-poll deliberately suspended during drag). Cap any single drag at 60s.
const DRAG_MAX_MS = 60_000
/** Pure failsafe decision (exported for unit tests): true once a drag has outlived the cap. */
function dragExpired (startedAt, now = Date.now(), capMs = DRAG_MAX_MS) {
  return Number.isFinite(startedAt) && startedAt > 0 && now - startedAt >= capMs
}

function stopDrag () {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  dragCtx = null
  // 拖拽结束恢复穿透轮询(dragStart 时挂起,防中途误判 click-through 吞掉 pointerup 造成粘手)
  // D10: this re-arm is unconditional-on-visibility — the failsafe path (and blur) guarantees the
  // suspended hit poll can never stay suspended after the drag loop ends for ANY reason.
  if (win && !win.isDestroyed() && win.isVisible() && !dockedToTray) startHitPoll()
}

/* ---- Hover hit detection: main process polls the cursor (2026-09-02 root fix) ----
   Old approach = renderer mousemove (forwarded via setIgnoreMouseEvents forward:true) driving flip-through
   click-through. In practice the whole forward chain breaks at 150% scaling on Windows (the renderer
   receives no mousemove at all when the cursor is over the card), so the click-through state never flips
   → the float can be neither clicked nor dragged. Switched to the main process polling the screen cursor
   position: the Electron screen API is DIP throughout (getCursorScreenPoint/getBounds share one coordinate
   system), naturally DPI-safe, scaling/multi-monitor agnostic, and independent of any OS event forwarding. */
let hitTimer = null
let panelOpen = false // when the renderer has an expanded layer (⋮ menu/♪ noise/abandon confirm), the whole window responds
let lastIgnore = null

/** Test-only getter (F10): pins that 'closed' resets the module-level panel state */
function isPanelOpen () { return panelOpen }

/** Hit-test pure function (exported for unit tests): whether the cursor is over an interactive area = the bottom card strip, or the whole window when an expanded layer is open */
function isInsideHit (cursor, bounds, open, cardH) {
  const inX = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width
  if (!inX) return false
  if (open) return cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
  return cursor.y >= bounds.y + bounds.height - cardH && cursor.y <= bounds.y + bounds.height
}

function applyIgnore (ignore) {
  if (ignore === lastIgnore) return
  lastIgnore = ignore
  if (win && !win.isDestroyed()) {
    try {
      win.setIgnoreMouseEvents(ignore)
      if (process.env.FLOAT_HIT_DBG) log.info('[TomatoFloat][dbg] applyIgnore', ignore)
    } catch (e) { log.warn('[TomatoFloat] setIgnore failed', e) }
  }
}

// P2 2026-09-17: while the window is hidden/destroyed the poll used to spin forever (40ms interval,
// no work). Count consecutive hidden ticks and self-stop after ~1s; startHitPoll resets the counter.
const HITPOLL_MAX_HIDDEN_TICKS = 25 // 25 × 40ms ≈ 1s
let hitHiddenTicks = 0

function stopHitPoll () {
  if (hitTimer) { clearInterval(hitTimer); hitTimer = null }
  hitHiddenTicks = 0
}

function startHitPoll () {
  if (hitTimer) { hitHiddenTicks = 0; return }
  let ticks = 0
  hitHiddenTicks = 0
  hitTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) {
      if (++hitHiddenTicks >= HITPOLL_MAX_HIDDEN_TICKS) stopHitPoll()
      return
    }
    hitHiddenTicks = 0
    try {
      // Every ~4s flush the bounds in place: even with the trigger chain blocked, DWM ghost repaint
      // (black frame/right-angle rectangle/title text) can still be brought in by occasional compositor
      // repaints; periodically force-repaint the transparent layer to wipe the residue
      if (++ticks % 100 === 0) flushPaint(win)
      const cursor = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = isInsideHit(cursor, b, panelOpen, CARD_H)
      if (process.env.FLOAT_HIT_DBG) log.info('[TomatoFloat][dbg] tick', JSON.stringify(cursor), 'bounds=' + JSON.stringify(b), 'panel=' + panelOpen, inside)
      applyIgnore(!inside)
    } catch (e) { /* transient screen API errors must not break the poll */ }
  }, 40)
}

/** 拖拽夹紧纯函数(导出供单测):折叠态夹"可见卡片"贴 workArea(顶可达贴顶、底不没入任务栏),
    展开态(整窗可见)维持夹窗口矩形+50px 保底。折叠/展开下边语义不对称会放卡片整个没入任务栏下方
    (2026-09-05 回归审查 P1:顶修了底没修) */
function clampDrag (x, y, h, open, area) {
  const topPad = open ? 0 : (h - CARD_H)
  const yMax = open ? area.y + area.height - Math.min(h, 50) : area.y + area.height - h
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - Math.min(W, 100))),
    y: Math.max(area.y - topPad, Math.min(y, yMax))
  }
}

/** Union rectangle of all displays' work areas (common-practice a()); used to constrain drag positions */
function workAreaUnion () {
  try {
    const displays = screen.getAllDisplays()
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const d of displays) {
      const wa = d.workArea
      x0 = Math.min(x0, wa.x); y0 = Math.min(y0, wa.y)
      x1 = Math.max(x1, wa.x + wa.width); y1 = Math.max(y1, wa.y + wa.height)
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  } catch (e) {
    const wa = screen.getPrimaryDisplay().workArea
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
  }
}

/** After show, flush the bounds in place to force DWM to repaint the transparent layer (backstop for Windows transparent frameless ghosting) */
function flushPaint (w) {
  try { if (w && !w.isDestroyed()) w.setBounds(w.getBounds()) } catch (e) { /* empty */ }
}

/* ---- W16 (2026-10-28): layered diagnostics probe ----
 * The recurring incident ("HWND exists, isVisible=true, load events fired, screen shows nothing")
 * was indistinguishable from a healthy float because the only signals were ready-to-show / load
 * events — fake health. diagnose() separates the three failure layers:
 *   route    — getURL(): is the webContents still on the #__tomato-float route?
 *   DOM      — executeJavaScript(): does the .tomato card exist, with non-zero geometry and
 *              computed visibility/opacity? (component render failure / CSS-hidden layer)
 *   paint    — capturePage(): non-empty raster with size info (blank-paint / compositor layer)
 * plus the handshake age and window geometry. NO automatic polling — this runs only when the
 * diagnostics command is invoked. Registered as the read-only 'tomato-float-diagnose' IPC command
 * (main window's sender only; the float/quick-add/trapped windows must not trigger it), reusing
 * the plain ipcMain.handle pattern so the main-window diagnostics surface can call it via the
 * todoAPI.tomatoFloatDiagnose() preload facade. */
async function diagnose () {
  const out = { at: Date.now(), hasWindow: !!(win && !win.isDestroyed()) }
  if (!out.hasWindow) { out.reason = 'no-window (never created / destroyed / not docked-recreated yet)'; return out }
  const w = win
  const wc = w.webContents
  try { out.visible = w.isVisible(); out.bounds = w.getBounds() } catch (e) { out.boundsError = String((e && e.message) || e) }
  try {
    out.url = wc.getURL()
    out.urlOk = String(out.url).includes('__tomato-float')
  } catch (e) { out.url = null; out.urlError = String((e && e.message) || e) }
  out.renderHandshakeAgeMs = lastHandshakeAt ? (Date.now() - lastHandshakeAt) : null
  try {
    // DOM layer: card presence + geometry + computed paint-affecting styles
    out.dom = await wc.executeJavaScript("(() => { const el = document.querySelector('.tomato'); if (!el) return { present: false }; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { present: true, width: r.width, height: r.height, visibility: cs.visibility, opacity: cs.opacity, display: cs.display } })()", true)
  } catch (e) { out.dom = { error: String((e && e.message) || e) } }
  try {
    const img = await wc.capturePage()
    if (!img || img.isEmpty()) out.capture = { empty: true }
    else { const size = img.getSize(); out.capture = { width: size.width, height: size.height, pngBytes: img.toPNG().length } }
  } catch (e) { out.capture = { error: String((e && e.message) || e) } }
  return out
}

let diagnoseIpcRegistered = false
function ensureDiagnoseIpc () {
  // Guarded so bare unit-test electron stubs (no ipcMain) can still load this module.
  if (diagnoseIpcRegistered || !ipcMain || typeof ipcMain.handle !== 'function') return
  diagnoseIpcRegistered = true
  ipcMain.handle('tomato-float-diagnose', async (e) => {
    // read-only probe: the MAIN window's diagnostics surface only
    try {
      const { getMainWindow } = require('./window-ref')
      const mw = getMainWindow()
      if (!mw || !e || e.sender !== mw.webContents) throw new Error('forbidden: main window only (tomato-float-diagnose)')
    } catch (err) {
      if (err && /forbidden/.test(String(err.message))) throw err
      return Promise.resolve({ hasWindow: false, reason: 'diagnose unavailable: ' + String((err && err.message) || err) })
    }
    return diagnose()
  })
}
ensureDiagnoseIpc()

module.exports = {
  dock, undock, isDocked,
  crashRebuild, // C10 crash-rebuild cap policy, W16: now a rolling 5min window (unit-testable; see above)
  isInsideHit, // hover hit-test pure function (for unit tests)
  dragExpired, // D10 drag failsafe pure decision (for unit tests)
  DRAG_MAX_MS, // D10 drag failsafe cap
  isPanelOpen, // panel-state getter (unit tests pin the F10 'closed' reset)
  isUserClosed, // closed-marker getter (unit tests pin the F12 marker lifecycle)
  clampDrag, // drag clamp pure function (for unit tests)
  safeReclamp, // C8: guarded re-clamp (unit tests prove the screen-event path cannot throw)
  floatBoundsVisible, // W16 P1: pure off-screen test used by safeReclamp (unit-testable)
  diagnose, // W16 P0-1: layered route/DOM/paint probe (diagnostics command surface)
  HANDSHAKE_TIMEOUT_MS, // W16 P0-2: render-health handshake watch window
  __renderHealth: { note: noteRenderHandshake, healthySince: handshakeHealthySince, timeoutMs: HANDSHAKE_TIMEOUT_MS }, // W16 test seam
  __forceWin (w) { win = w }, // C8 test seam: inject a stub window so the guarded path is reachable
  __clearWin () { win = null }, // C8 test seam
  /** Show (setBounds + showInactive if already created; common practice: do not steal focus) */
  show () {
    crashRebuild.reset() // C10: an explicit user open is the strongest health signal — refill rebuild slots
    exhaustionReported = false // W16: a deliberate user open re-arms the exhaustion report for the next failure chain
    return module.exports.reopen()
  },
  /** Open WITHOUT touching the crash-rebuild counter — the crash self-heal path uses this so an
   *  auto-rebuild cannot refill its own slots through show() (C10 cap would be a no-op). */
  reopen () {
    dockedToTray = false // dock 后走 show 等于解除收纳:否则 isDocked 误报、stopDrag 不重启轮询(2026-09-05 终审 P2)
    setUserClosed(false) // every open path converges here (SettingsModal/TomatoPanel/TomatoBar IPC, auto-show): clear the close marker
    let w = win
    if (!w || w.isDestroyed()) w = create()
    if (!w.webContents.isLoadingMainFrame()) { w.showInactive(); flushPaint(w) }
    else {
      // M2 P3 (2026-10-09): bound single handler — remove the previous did-finish-load closure
      // before appending the new one, so N reopens during one load fire the show exactly once.
      try { if (pendingLoadShow) w.webContents.removeListener('did-finish-load', pendingLoadShow) } catch { /* stale handler already gone */ }
      pendingLoadShow = () => {
        pendingLoadShow = null
        if (w && !w.isDestroyed()) { w.showInactive(); flushPaint(w) }
      }
      w.webContents.once('did-finish-load', pendingLoadShow)
    }
    startHitPoll()
    return true
  },
  hide () {
    setUserClosed(true) // explicit user close (TomatoBar toggle / float ✕ / settings switch off): persists across restarts
    stopDrag()
    stopHitPoll()
    applyIgnore(true) // hidden = restore full click-through, avoiding residual clickable state before the next show
    if (win && !win.isDestroyed()) win.hide()
    return true
  },
  /** Whether the float is currently visible (initializes the TomatoBar hover button's on state; nonexistent/destroyed counts as hidden) */
  isVisible () {
    return !!(win && !win.isDestroyed() && win.isVisible())
  },
  /** Erase DWM ghost residue after content transitions (full-window recompositing from popovers like tf-pop
      can surface right-angle repaints; in-place setBounds forces DWM to repaint the transparent layer —
      the most reliable erasure method measured in this project) */
  flushNow () {
    if (win && !win.isDestroyed()) flushPaint(win)
    return true
  },
  setBounds () {
    // W16 render-health handshake: the ONLY renderer caller of the 'set-tomato-float-bounds' channel
    // is TomatoFloatPage.vue mounted() — and it sends it only after $nextTick confirmed the card
    // (.tomato) is actually mounted. That makes this call the "render health" proof (no new IPC
    // channel needed; ready-to-show/did-finish-load are no longer treated as health anywhere).
    noteRenderHandshake()
    if (win && !win.isDestroyed()) win.setBounds(defaultBounds())
    return true
  },
  /** Renderer expanded-layer state (⋮ menu/♪ noise/abandon confirm): while expanded the whole window is
      interactive; when collapsed, hit testing returns to the card strip. Window height stays constant at
      320 with no resizing (silky = pure CSS animation inside the window); do not blindly enable click-through
      on collapse: if the cursor still rests on the card strip it should remain clickable (blind click-through
      would swallow rapid consecutive clicks until the next poll round). */
  setPanelOpen (sender, open) {
    // F-A5 (2026-09-23): sender check symmetric with dragStart/dragStop — the panel (and the
    // click-through state it drives) is the float's own UI state; a foreign/trapped window
    // must not flip it. (handlers/tomato.js forwards e.sender; `open` is unchanged.)
    if (!module.exports.isSelfSender(sender)) return false
    panelOpen = !!open
    if (!panelOpen && win && !win.isDestroyed()) {
      try { applyIgnore(!isInsideHit(screen.getCursorScreenPoint(), win.getBounds(), false, CARD_H)) } catch (e) { /* backstopped by the next poll round */ }
    }
    return true
  },
  /** Double-click card → summon the main window: sender validation accepts only the float window's own webContents (prevents misuse by other windows/injection) */
  isSelfSender (sender) {
    return !!(win && !win.isDestroyed() && sender === win.webContents)
  },
  /** Drag start: sender check allows only the float window itself (aligned with the reference e.sender === p.webContents) */
  dragStart (sender) {
    if (!win || win.isDestroyed() || sender !== win.webContents) return false
    stopDrag()
    // 拖拽期间挂起穿透轮询并强制可点:hit-poll 若在拖动中途误判 outside 会把窗口打成 click-through,
    // 吞掉 pointerup/pointercancel → stopDrag 永不触发、窗口粘手(2026-09-05 "拖不动/手感劣化"根因二)
    stopHitPoll()
    applyIgnore(false)
    const b = win.getBounds()
    // Fault-13 (D12 2026-10-01): getCursorScreenPoint throws synchronously when the session's
    // cursor is unavailable (RDP disconnect / display teardown). Thrown out of dragStart it
    // escaped as a raw IPC error AND left the hit poll suspended (stopHitPoll above already ran),
    // so the float stayed click-through forever. Read the cursor under a guard: on failure log,
    // re-arm the poll (the suspended state must never survive), and refuse the drag.
    let cur
    try {
      cur = screen.getCursorScreenPoint()
    } catch (e) {
      log.warn('[TomatoFloat] dragStart: cursor point unavailable, drag refused', e)
      startHitPoll()
      return false
    }
    dragCtx = { windowX: b.x, windowY: b.y, cursorX: cur.x, cursorY: cur.y, h: b.height, open: panelOpen, startedAt: Date.now() } // dragging keeps the current height mode (86/320); size does not change while dragging
    dragTimer = setInterval(() => {
      if (!dragCtx || !win || win.isDestroyed()) { stopDrag(); return }
      // D10: failsafe — a lost pointerup/pointercancel (frozen/crashed float renderer) must not
      // track the cursor forever; end the drag and re-arm the hit poll.
      if (dragExpired(dragCtx.startedAt)) { log.warn('[TomatoFloat] drag failsafe: exceeded ' + DRAG_MAX_MS + 'ms, force-stopping'); stopDrag(); return }
      try {
        const c = screen.getCursorScreenPoint()
        let x = Math.round(dragCtx.windowX + c.x - dragCtx.cursorX)
        let y = Math.round(dragCtx.windowY + c.y - dragCtx.cursorY)
        const h = dragCtx.h
        const area = workAreaUnion()
        // 夹"可见卡片"而非窗口顶边:恒定 320 高后可见卡只占底部 86px,夹窗口顶会让卡片永远悬在
        // 屏幕顶下方 234px——用户感知的"无形墙,拖不到屏幕上面"(2026-09-05 根因三)。展开态(面板开)
        // 整窗可见,维持夹窗口顶。见 clampDrag 纯函数(单测覆盖)
        const clamped = clampDrag(x, y, h, dragCtx.open, area)
        x = clamped.x; y = clamped.y
        const gb = win.getBounds()
        if (gb.x !== x || gb.y !== y || gb.width !== W || gb.height !== h) {
          win.setBounds({ x, y, width: W, height: h }, false)
        }
      } catch (e) { log.warn('[TomatoFloat] drag failed', e); stopDrag() }
    }, 16)
    return true
  },
  // F-A5 (2026-09-23): sender check aligned with dragStart — only the float's own webContents
  // may end a drag. Unchecked, a trapped/foreign window could clearInterval the drag timer
  // mid-drag (yank the card out of the user's hand).
  dragStop (sender) {
    if (!module.exports.isSelfSender(sender)) return false
    stopDrag(); return true
  }
}
