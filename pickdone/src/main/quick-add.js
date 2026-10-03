/**
 * Global quick-add mini window — the mini input bar summoned from anywhere via the global shortcut.
 * 480×64 frameless always-on-top toolbar window, upper-center of the screen; hides on Esc/blur, collapses automatically after creating on Enter.
 * Creation is performed by the renderer's QuickAddPage through the normal store addTodo path (same origin as the main window: identical sorting/day grouping/backup).
 */
const { BrowserWindow, screen } = require('electron')
const path = require('path')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const { attachLoadGuard } = require('./aux-load-guard')

const W = 480
const H = 64

let win = null
let ignoreBlur = false // toggle path: while show→focus is still in flight the blur event is untrustworthy; swallow it once to prevent a flash-hide
let lockProbe = null // lock-screen probe, injected by index.js (setLockProbe): while locked, the global shortcut does not summon the quick-add window (a submit would be rejected = silently lost task)

/** Pure helper (unit-testable): center the 480×64 bar on the given display's work area.
 *  C11 (P3 2026-10-02): the summon used to ALWAYS land on the primary display even when the user
 *  was working on a secondary one. The caller now resolves the cursor's display; same bounds
 *  contract (upper-center of the work area), just the right screen. */
function boundsForDisplay (display) {
  const d = display || null
  const width = d && d.bounds ? d.bounds.width : 0
  const workArea = (d && d.workArea) || { x: 0, y: 0, width: d && d.bounds ? d.bounds.width : 0, height: 0 }
  return {
    x: (workArea.x || 0) + Math.round(((workArea.width || width) - W) / 2),
    y: (workArea.y || 0) + Math.round((workArea.height || 0) * 0.18),
    width: W,
    height: H
  }
}

function defaultBounds () {
  // C11: prefer the display the user is currently working on (cursor position); fall back to the
  // primary display when the cursor probe fails (headless/test environments, races at startup).
  let display = null
  try { display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) } catch { /* fall back below */ }
  if (!display) {
    try { display = screen.getPrimaryDisplay() } catch { /* boundsForDisplay tolerates null */ }
  }
  return boundsForDisplay(display)
}

function create () {
  win = new BrowserWindow({
    ...defaultBounds(),
    skipTaskbar: true,
    useContentSize: true,
    transparent: true,
    frame: false,
    show: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    resizable: false,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver', 2)
  win.setMenu(null)
  // The quick-add window only serves app://app (route #/__quick-add): block all other navigation.
  // Same-origin prefix guard aligned with the main window — the old substring check let any scheme
  // through via the route marker (e.g. https://evil.com/#__quick-add)
  win.webContents.on('will-navigate', (e, url) => {
    if (!/^app:\/\/app\//i.test(String(url))) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL('app://app/renderer-dist/index.html#/__quick-add').catch(e => { try { log.warn('[QuickAdd] loadURL failed', e) } catch {} })
  // F16 (2026-09-24): did-fail-load used to be unhandled here — a failed page load left the window
  // alive on the error page and toggle()'s reuse branch kept show()+send-ing into it (typed input
  // silently lost). Shared self-heal with tomato-float.js (aux-load-guard): retry with backoff,
  // destroy on exhaustion; 'closed' resets win=null and toggle() lazily recreates.
  attachLoadGuard(win, {
    url: 'app://app/renderer-dist/index.html#/__quick-add',
    routeMark: '__quick-add',
    tag: 'QuickAdd'
  })
  // 首次唤起 focus 早于页面加载必丢(2026-09-10 P2):toggle 在 loadURL 尚未完成时就 send('quick-add-focus'),
  // 渲染端监听器还没注册 → 第一次按快捷键输入框不聚焦。did-finish-load 后若窗仍可见则补发一次。
  win.webContents.on('did-finish-load', () => {
    // P2 2026-09-19: ignoreBlur used to be a strict one-shot consumed by the next blur — summoned
    // with --no-focus (parkForTest, never focused → no blur ever fires) it latched true forever and
    // swallowed the FIRST REAL blur after a focus summons too. Reset here and via a short timer in
    // toggle: the flag must only cover the in-flight show/focus window, nothing longer.
    ignoreBlur = false
    try { if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('quick-add-focus') } catch { /* gone */ }
  })
  // 渲染进程崩溃自愈(2026-09-10 P1,仿 tomato-float):崩溃后 quick-add 窗白屏且永不恢复,
  // toggle 的复用分支(win.isVisible())还会对死窗 send → 静默失败。销毁即可,'closed' 复位 win=null,
  // toggle 的 `if (!win || win.isDestroyed()) create()` 分支天然惰性重建,无需额外状态。
  win.webContents.on('render-process-gone', (_e, details) => {
    const reason = details && details.reason
    log.error('[QuickAdd] render-process-gone:', reason, 'exitCode=', details && details.exitCode)
    if (!reason || reason === 'clean-exit') return
    try { if (win && !win.isDestroyed()) win.destroy() } catch { /* already gone */ } // 'closed' 复位 win=null
  })
  // Auto-collapse on blur (disappears when the user clicks back to work, without interrupting flow)
  win.on('blur', () => {
    if (ignoreBlur) { ignoreBlur = false; return }
    if (win && !win.isDestroyed() && win.isVisible()) hide()
  })
  win.on('closed', () => { win = null })
  return win
}

/** Toggle show/hide (global shortcut entry): collapse if visible and focused, otherwise summon and focus the input */
function toggle () {
  try {
    if (typeof lockProbe === 'function' && lockProbe()) return
    if (win && !win.isDestroyed() && win.isVisible()) { hide(); return }
    if (!win || win.isDestroyed()) create()
    win.setBounds(defaultBounds())
    ignoreBlur = true // prevent the first press's in-flight show/focus blur from self-hiding when the shortcut is pressed twice quickly
    // P2 2026-09-19: the flag must not latch when no blur follows (e.g. a --no-focus summon never
    // blurs). Time-box the latch: after it expires the next blur is a real one and must hide.
    setTimeout(() => { ignoreBlur = false }, 1000).unref?.()
    // --no-focus test instances: park inactive on the secondary display / off-screen (same policy as the main window)
    if (process.argv.includes('--no-focus')) {
      require('./window-ref').parkForTest(win, { screen })
    } else {
      win.show()
      win.focus()
    }
    win.webContents.send('quick-add-focus')
  } catch (e) {
    log.error('[QuickAdd] 唤起失败', e)
  }
}

function hide () {
  if (win && !win.isDestroyed()) win.hide()
}

function is_visible () { return !!(win && !win.isDestroyed() && win.isVisible()) }

/** main-ipc wave (2026-09-25): sender ownership test for the 'quick-add-hide' gate in
 *  handlers/tomato.js (same shape as tomato-float.isSelfSender). true only for the quick-add
 *  window's own webContents. */
function isSelfSender (sender) {
  return !!(win && !win.isDestroyed() && sender === win.webContents)
}

/** Lock-screen probe injection (index.js holds isLocked, avoiding a circular require) */
function setLockProbe (fn) { lockProbe = fn }

module.exports = { toggle, hide, isVisible: is_visible, setLockProbe, isSelfSender, boundsForDisplay }
