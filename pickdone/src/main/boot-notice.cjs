/**
 * boot-notice.cjs — startup honesty for the data-location boot file (2026-10-22 UX round).
 * A boot redirect whose target dir has VANISHED falls back to the default userData silently
 * (readBootRedirect → null); the data is safe (the source was never deleted), but the user
 * must KNOW the configured location was not honored. index.js snapshots readBootRedirectState()
 * during module init (before whenReady, before anything can rewrite the boot file) and calls
 * surfaceMissingBootTarget once a window exists to host the dialog.
 */
function surfaceMissingBootTarget ({ getMainWindow, i18n, log }, state) {
  // no-op unless the boot file named a REAL dir that has since vanished; isolated/test instances
  // (TODO_USER_DATA_DIR / TODO_DB_DIR) never consult the production boot file anyway
  if (!state || state.status !== 'missing' || process.env.TODO_USER_DATA_DIR || process.env.TODO_DB_DIR) return
  try {
    log.warn('[Init] boot redirect target missing, fell back to default:', state.dir)
    const { dialog } = require('electron')
    const win = getMainWindow ? getMainWindow() : undefined
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'warning',
      title: i18n.mt('dataLocMissingTitle'),
      message: i18n.mt('dataLocMissingMsg', { dir: state.dir }),
    }).catch(() => {})
  } catch (e) { /* dialog is best-effort */ }
}

module.exports = { surfaceMissingBootTarget }
