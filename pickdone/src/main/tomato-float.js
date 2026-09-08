/**
 * Pomodoro float window (aligned with the reference show-tomato-floating / internal reference implementation)
 * 131×44 transparent frameless always-on-top toolbar window, default bottom-right of the screen; whole-card drag = main-process 16ms timer following the cursor
 */
const { BrowserWindow, screen } = require('electron')
const path = require('path')
const log = require('electron-log')

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
/** Re-clamp bounds after wake-from-sleep / monitor unplug: in click-through state the float cannot even be
 *  dragged, so once it drifts off-screen it is unrecoverable. screen 是进程级单例:create() 可能多次执行,
 *  监听器必须在模块级只挂一次(否则随窗口重建无限累积,2026-09-05 终审 P2) */
function ensureScreenHooks () {
  if (screenHooksOn) return
  screenHooksOn = true
  screen.on('display-metrics-changed', () => { if (win && !win.isDestroyed()) setBounds() })
  screen.on('display-removed', () => { if (win && !win.isDestroyed()) setBounds() })
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
  // Window never created (float disabled at startup) or destroyed: lazy-create via show(), otherwise the tray's "show float window" click would never respond (false affordance)
  if (!win || win.isDestroyed()) { module.exports.show(); return }
  win.showInactive(); setBounds()
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
    win.on('blur', () => log.info('[TomatoFloat][dbg] window BLUR ← 幽灵标题栏触发点'))
  }
  // The float only ever serves __tomato-float: block all page-level navigation and popups (prevents anchors/mis-clicks from opening framed child windows)
  // 2026-08-31 root-cause fix: the app:// page occasionally fails to load (any HTML/CSS failure cripples the
  // whole window — error page/unstyled layout; the "rectangle/incomplete/broken" the user kept seeing was
  // this), and after failure it stays stuck on the error page with no retry. Added automatic retry as a backstop
  let loadRetries = 0
  win.webContents.on('did-finish-load', () => { loadRetries = 0 })
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain) return
    if (String(url).includes('__tomato-float') && loadRetries < 5) {
      loadRetries++
      stopHitPoll()
      log.warn('[TomatoFloat] 页面加载失败，重试', loadRetries, code, desc)
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.loadURL('app://app/renderer-dist/index.html#/__tomato-float').catch(() => {})
        }
      }, 400 * loadRetries)
    }
  })
  // 渲染进程崩溃自愈(2026-09-09,与主窗 render-process-gone 同类):did-fail-load 只覆盖加载失败,
  // 渲染进程崩溃后浮窗从此白屏/无响应且永不恢复。崩溃时销毁重建;若崩溃前可见(番茄进行中)则延迟重开。
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details && details.reason
    log.error('[TomatoFloat] render-process-gone:', reason, 'exitCode=', details && details.exitCode)
    if (!reason || reason === 'clean-exit') return
    const wasVisible = !!(win && !win.isDestroyed() && win.isVisible())
    stopDrag()
    stopHitPoll()
    try { if (win && !win.isDestroyed()) win.destroy() } catch (e) { /* already gone */ } // 'closed' 会复位 win=null
    if (wasVisible) setTimeout(() => { try { module.exports.show() } catch (e) { log.warn('[TomatoFloat] 崩溃重建失败', e) } }, 500)
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!String(url).includes('__tomato-float')) e.preventDefault()
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
    win.showInactive()
    // After show, flush the bounds in place to force DWM to repaint the transparent layer (backstop against ghosting; dragging "erases" the ghost via this same mechanism)
    try { win.setBounds(win.getBounds()) } catch (e) { /* empty */ }
  })
  win.on('closed', () => { stopDrag(); stopHitPoll(); win = null })
  return win
}

function stopDrag () {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  dragCtx = null
  // 拖拽结束恢复穿透轮询(dragStart 时挂起,防中途误判 click-through 吞掉 pointerup 造成粘手)
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

function stopHitPoll () {
  if (hitTimer) { clearInterval(hitTimer); hitTimer = null }
}

function startHitPoll () {
  if (hitTimer) return
  let ticks = 0
  hitTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
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

module.exports = {
  dock, undock, isDocked,
  isInsideHit, // hover hit-test pure function (for unit tests)
  clampDrag, // drag clamp pure function (for unit tests)
  /** Show (setBounds + showInactive if already created; common practice: do not steal focus) */
  show () {
    dockedToTray = false // dock 后走 show 等于解除收纳:否则 isDocked 误报、stopDrag 不重启轮询(2026-09-05 终审 P2)
    let w = win
    if (!w || w.isDestroyed()) w = create()
    if (!w.webContents.isLoadingMainFrame()) { w.showInactive(); flushPaint(w) }
    else w.webContents.once('did-finish-load', () => { if (w && !w.isDestroyed()) { w.showInactive(); flushPaint(w) } })
    startHitPoll()
    return true
  },
  hide () {
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
    if (win && !win.isDestroyed()) win.setBounds(defaultBounds())
    return true
  },
  /** Renderer expanded-layer state (⋮ menu/♪ noise/abandon confirm): while expanded the whole window is
      interactive; when collapsed, hit testing returns to the card strip. Window height stays constant at
      320 with no resizing (silky = pure CSS animation inside the window); do not blindly enable click-through
      on collapse: if the cursor still rests on the card strip it should remain clickable (blind click-through
      would swallow rapid consecutive clicks until the next poll round). */
  setPanelOpen (open) {
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
    const cur = screen.getCursorScreenPoint()
    dragCtx = { windowX: b.x, windowY: b.y, cursorX: cur.x, cursorY: cur.y, h: b.height, open: panelOpen } // dragging keeps the current height mode (86/320); size does not change while dragging
    dragTimer = setInterval(() => {
      if (!dragCtx || !win || win.isDestroyed()) { stopDrag(); return }
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
  dragStop () { stopDrag(); return true }
}
