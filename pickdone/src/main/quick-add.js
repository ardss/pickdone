/**
 * Global quick-add mini window — the mini input bar summoned from anywhere via the global shortcut.
 * 480×64 frameless always-on-top toolbar window, upper-center of the screen; hides on Esc/blur, collapses automatically after creating on Enter.
 * Creation is performed by the renderer's QuickAddPage through the normal store addTodo path (same origin as the main window: identical sorting/day grouping/backup).
 */
const { BrowserWindow, screen } = require('electron')
const path = require('path')
const log = require('electron-log')

const W = 480
const H = 64

let win = null
let ignoreBlur = false // toggle path: while show→focus is still in flight the blur event is untrustworthy; swallow it once to prevent a flash-hide
let lockProbe = null // lock-screen probe, injected by index.js (setLockProbe): while locked, the global shortcut does not summon the quick-add window (a submit would be rejected = silently lost task)

function defaultBounds () {
  const { width } = screen.getPrimaryDisplay().bounds
  const { workArea } = screen.getPrimaryDisplay()
  return { x: Math.round((width - W) / 2), y: workArea.y + Math.round(workArea.height * 0.18), width: W, height: H }
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
  // The quick-add window only serves __quick-add: block all page-level navigation and popups
  win.webContents.on('will-navigate', (e, url) => {
    if (!String(url).includes('__quick-add')) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadURL('app://app/renderer-dist/index.html#/__quick-add').catch(e => { try { log.warn('[QuickAdd] loadURL failed', e) } catch {} })
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

/** Lock-screen probe injection (index.js holds isLocked, avoiding a circular require) */
function setLockProbe (fn) { lockProbe = fn }

module.exports = { toggle, hide, isVisible: is_visible, setLockProbe }
