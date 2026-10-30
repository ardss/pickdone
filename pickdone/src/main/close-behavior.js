// Pure decision helpers for the close-button behavior (tray-minimize vs quit).
// Kept dependency-free so the unit tests can exercise them without electron.
function isCloseToTray (config) {
  return !config || config.closeActionMinimize !== false
}

// One-shot discovery aid: the first time the window "disappears" into the tray the user
// gets a single balloon explaining what happened and where to change it. Never repeats.
function shouldShowTrayNotice (config) {
  return isCloseToTray(config) && !(config && config.closeTrayNotified)
}

// F1 (2026-10-22 window-chrome review): named three-way decision for the main window's X
// (Alt+F4 fires the same 'close' event):
//   'hide'  → tray mode (default): hide to tray + one-shot balloon (0.1.0 behavior, unchanged)
//   'quit'  → exit mode (closeActionMinimize=false): the user explicitly chose "X quits the app"
//             (onboarding step 4 / Settings→General) — the close must route through the guarded
//             user-quit chain. The old else-branch merely let the window DESTROY while
//             window-all-closed stayed resident, so the promised quit never happened.
//   'close' → a quit chain is already in flight (quitByUser): let the window close for real.
function closeIntent ({ quitByUser, closeToTray }) {
  if (quitByUser) return 'close'
  return closeToTray ? 'hide' : 'quit'
}

module.exports = { isCloseToTray, shouldShowTrayNotice, closeIntent }
