/** Notification sound: delegate to the renderer to play the real file via Audio (previously beep was one-size-fits-all, ignoring the user's sound/file settings).
 *  The main process has no audio playback capability, and ogg is not supported by PowerShell SoundPlayer; the renderer's Electron allows playback without a user gesture by default.
 *  Falls back to the system beep when there is no live window, so notifications are never silent.
 *  The renderer page runs on the app:// origin, so the absolute disk path must be converted to an app:// URL —
 *  a raw Windows path resolves as a relative app:// URL and the Audio silently fails (reminders played muted, 2026-09-03). */
function sound (file) {
  try {
    if (file) {
      const win = require('./window-ref').getMainWindow()
      if (win) {
        const path = require('path')
        const appRoot = path.join(__dirname, '..', '..')
        const rel = path.relative(appRoot, file).split(path.sep).join('/')
        const url = rel.startsWith('..') ? file : 'app://app/' + rel
        win.webContents.send('play-sound', url)
        return
      }
    }
    const { spawn } = require('child_process')
    if (process.platform === 'win32') {
      spawn('powershell.exe', ['-c', '[console]::beep(880,180)'], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) { /* ignore */ }
}
module.exports = { sound }
