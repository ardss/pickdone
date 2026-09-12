/** Notification sound: delegate to the renderer to play the real file via Audio (previously beep was one-size-fits-all, ignoring the user's sound/file settings).
 *  The main process has no audio playback capability, and ogg is not supported by PowerShell SoundPlayer; the renderer's Electron allows playback without a user gesture by default.
 *  Falls back to the system beep when there is no live window, so notifications are never silent.
 *  The renderer page runs on the app:// origin, so the absolute disk path must be converted to an app:// URL —
 *  a raw Windows path resolves as a relative app:// URL and the Audio silently fails (reminders played muted, 2026-09-03). */
/** Pure URL mapping (exported for plain-node tests): file → app://app/<rel> when inside appRoot,
 *  otherwise a file:// URL. The old fallback had two broken branches: (1) cross-drive path.relative
 *  on Windows returns an ABSOLUTE path that does not start with '..' → a malformed 'app://app/K:/...'
 *  URL; (2) a real '..' escape fell back to the raw Windows path, which the app:// page cannot
 *  resolve. The renderer can play file:// audio, so out-of-root files go there. */
function toSoundUrl (file, appRoot) {
  const path = require('path')
  const rel = path.relative(appRoot, file)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return 'app://app/' + rel.split(path.sep).join('/')
  }
  // H7 (2026-09-12 P2): hand-rolled encodeURI left '#', '?' and '%' unescaped — a sound file named
  // "ring#1.mp3" produced 'file:///...ring#1.mp3' where '#1.mp3' parsed as a fragment and Audio played
  // nothing. Node's built-in pathToFileURL percent-encodes every reserved character.
  const { pathToFileURL } = require('url')
  return pathToFileURL(file).href
}

function sound (file) {
  try {
    if (file) {
      const win = require('./window-ref').getMainWindow()
      if (win) {
        const path = require('path')
        const appRoot = path.join(__dirname, '..', '..')
        win.webContents.send('play-sound', toSoundUrl(file, appRoot))
        return
      }
    }
    const { spawn } = require('child_process')
    if (process.platform === 'win32') {
      spawn('powershell.exe', ['-c', '[console]::beep(880,180)'], { detached: true, stdio: 'ignore' }).unref()
    } else {
      // 非 win32 兜底(2026-09-09 P2):此前 macOS/Linux 上无存活主窗时提醒完全无声;
      // Electron shell.beep() 是同步系统蜂鸣,无窗/无文件场景下保证提醒可闻
      try { require('electron').shell.beep() } catch (e) { /* no shell available */ }
    }
  } catch (e) { /* ignore */ }
}
module.exports = { sound, toSoundUrl }
