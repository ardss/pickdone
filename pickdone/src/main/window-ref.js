/** Main window reference registry — removes the reverse require of scheduler/notify-sound → index (a de facto circular dependency that would break once index was split)
 *  index.js sets it in createMainWindow; all other modules only get it. */
let mainWindow = null

function setMainWindow (win) { mainWindow = win }
function getMainWindow () { return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null }

/** Park a --no-focus test window where it cannot disturb the user: on the secondary
 *  display's bottom-right corner when one exists, otherwise just off-screen to the left
 *  of the primary. Deliberately NOT minimize(): minimized windows stop painting and
 *  geometry-dependent tests (real-mouse clicks, measurements, visual baselines) go flaky. */
function parkForTest (win, { screen } = {}) {
  if (!win || win.isDestroyed()) return
  win.showInactive()
  const b = win.getBounds()
  let target = null
  try {
    const primary = screen.getPrimaryDisplay()
    target = screen.getAllDisplays().find(d => d.id !== primary.id) || null
  } catch { /* screen module unavailable (early startup) — off-screen fallback */ }
  if (target) {
    const wa = target.workArea
    win.setPosition(wa.x + wa.width - b.width - 24, wa.y + wa.height - b.height - 24)
  } else {
    win.setPosition(-(b.width + 120), b.y)
  }
}

module.exports = { setMainWindow, getMainWindow, parkForTest }
