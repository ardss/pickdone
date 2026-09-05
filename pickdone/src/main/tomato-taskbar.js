/**
 * Pomodoro taskbar integration (Windows-native differentiation) — the countdown no longer lives only in the tray tooltip:
 * 1. Taskbar icon progress bar: focus = normal fill, rest/paused = paused yellow state, remaining time visible at a glance (setProgressBar)
 * 2. Live mm:ss in the taskbar/Alt-Tab title: readable seconds on hover, without interrupting current work
 * 3. Thumbnail toolbar (setThumbarButtons): give up directly from the taskbar preview without activating the window (the pomodoro has no pause semantics)
 * Icons are programmatically composed 16×16 native bitmaps (no third-party asset dependency). Non-Windows platforms automatically degrade to progress bar + title only.
 */
const { nativeImage } = require('electron')
const { drawTrayPixels, drawBadgePixels, BRAND_WORK, BRAND_REST } = require('./core/pixel-icons')
const log = require('electron-log')
const { mt } = require('./i18n')

const S = 16 // toolbar icon size

let mainWin = null
let baseTitle = '' // original window title captured at init; base name for the countdown suffix
let last = { mode: 'none', title: '' } // debounce: repeated progress/title sets flicker
let buttonsSet = false
let tray = null
let trayIconPath = '' // original icon restored when idle
let traySig = '' // tray redraw debounce: setImage only when phase+minutes change
let badgeSig = '' // badge debounce: setOverlayIcon only when today's count changes

/** 16×16 BGRA bitmap composition (premultiplied BGRA, white glyph on transparent base) */
function icon (kind) {
  const px = new Uint8Array(S * S * 4)
  const set = (x, y, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return
    const i = (y * S + x) * 4
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = a
  }
  const fill = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y) }
  if (kind === 'stop') { fill(4, 4, 11, 11) }
  return nativeImage.createFromBuffer(Buffer.from(px.buffer), { width: S, height: S })
}

function clearButtons () {
  if (!mainWin || mainWin.isDestroyed() || process.platform !== 'win32') return
  try { mainWin.setThumbarButtons([]) } catch (e) { /* early windows may not support it */ }
  buttonsSet = false
}


/** Tray progress ring + today's pomodoro badge (must be called before the thumbnail branch's early return) */
function trayAndBadge (p, status, paused, remain, total) {

  // 4) Tray progress ring: redraw only when phase+minutes change (tray setImage has system overhead)
  const minutes = Math.ceil(remain / 60)
  const tSig = `${status}|${paused}|${minutes}`
  if (tray && !tray.isDestroyed() && tSig !== traySig) {
    traySig = tSig
    try { tray.setImage(drawTrayPixels(1 - remain / total, minutes, status === 'startRestTime' ? BRAND_REST : BRAND_WORK)) } catch (e) { /* */ }
  }

  // 5) Today's pomodoro badge: redraw only when the count changes; no badge at 0
  const count = Math.max(0, Number(p.todayDone) || 0)
  const bSig = String(count)
  if (bSig !== badgeSig) {
    badgeSig = bSig
    try { mainWin.setOverlayIcon(count > 0 ? drawBadgePixels(count) : null, p.overlayDesc || mt('appName')) } catch (e) { /* */ }
  }
}

/** Renderer's per-second pomodoro state push → the taskbar five-piece set */
function update (p = {}) {
  if (!mainWin || mainWin.isDestroyed()) return
  const status = p.status || 'default'
  const running = status === 'startTomatoTime' || status === 'startRestTime'
  const paused = !!p.paused
  const total = Math.max(1, Number(p.totalSec) || 0)
  const remain = Math.max(0, Number(p.remainSec) || 0)

  // 1) Progress bar: running/paused = elapsed fraction (focus normal, rest/paused paused yellow); idle = clear (-1)
  const mode = !running && !paused ? 'none' : (status === 'startTomatoTime' && !paused ? 'normal' : 'paused')
  const value = running || paused ? Math.min(1, Math.max(0, 1 - remain / total)) : 0
  if (mode !== last.mode || (mode !== 'none' && Math.abs(value - (last.value || 0)) > 0.004)) {
    try { mainWin.setProgressBar(mode === 'none' ? -1 : value, { mode }) } catch (e) { /* */ }
    last.mode = mode; last.value = value
  }

  // 2) Title countdown: mm:ss prefix; idle restores the plain app name
  const mm = String(Math.floor(remain / 60)).padStart(2, '0')
  const ss = String(remain % 60).padStart(2, '0')
  const title = running || paused ? `${mm}:${ss} ${p.phaseText || ''} · ${baseTitle}` : baseTitle
  if (title !== last.title) {
    try { mainWin.setTitle(title) } catch (e) { /* */ }
    last.title = title
  }

  // 4/5) Tray progress ring and today's badge: must be called before the thumbnail branch's early return below; updated in the idle state too
  trayAndBadge(p, status, paused, remain, total)

  // 3) Thumbnail toolbar: attach [Give up] while timing (the pomodoro has no pause semantics — final decision: sleep = completes normally when the wall clock runs out)
  if (process.platform !== 'win32') return
  const wantButtons = running || paused
  if (!wantButtons) { if (buttonsSet) clearButtons(); return }
  if (buttonsSet) return
  try {
    mainWin.setThumbarButtons([
      { tooltip: p.btnStopText || mt('trayQuit'), icon: icon('stop'), click: () => send('giveup') }
    ])
    buttonsSet = true
  } catch (e) { log.warn('[TomatoTaskbar] thumbar 设置失败', e) }
}

function send (action) {
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send('tomato-taskbar-cmd', { action }) } catch (e) { /* */ }
  }
}

module.exports = {
  /** Inject references and initialize once the main window is ready */
  init (win) {
    mainWin = win
    last = { mode: 'none', title: '' }
    try { baseTitle = (win.getTitle() || '').trim() } catch (e) { baseTitle = '' }
  },
  update,
  /** Tray icon hookup: redraw the progress ring while a pomodoro runs, restore the original icon when idle */
  attachTray (trayRef, iconPath) {
    tray = trayRef
    trayIconPath = iconPath || ''
    traySig = ''
  },
  /** Clean up taskbar traces on window close/minimize-to-tray and similar scenarios */
  reset () {
    last = { mode: 'none', title: '' }
    traySig = ''
    if (tray && !tray.isDestroyed() && trayIconPath) {
      try { tray.setImage(trayIconPath) } catch (e) { /* */ }
    }
    if (mainWin && !mainWin.isDestroyed()) {
      try { mainWin.setProgressBar(-1) } catch (e) { /* */ }
      try { mainWin.setOverlayIcon(null, '') } catch (e) { /* */ }
      clearButtons()
    }
    badgeSig = ''
  }
}
