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

module.exports = { isCloseToTray, shouldShowTrayNotice }
