/** Shared guard/helpers for IPC handler modules (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const log = require('electron-log')

/** Dangerous-channel guard: only the main window may call (lock-screen/float/quick-add and all other renderer windows are rejected) */
function makeAssertMainWindow (getMainWindow) {
  return (e) => {
    const w = getMainWindow()
    if (!w || e.sender !== w.webContents) {
      log.warn('[IPC] 拒绝非主窗调用危险通道, sender:', e.sender.id)
      throw new Error('forbidden: main window only')
    }
  }
}

/** Ownership test for attachment filenames (P2 2026-09-17). saveAttachment names files
 *  `${taskId}_${Date.now()}_${name}`, so a bare startsWith(taskId + '_') let a task whose id is a
 *  prefix of another id ('a' vs 'a_b') delete the other task's files. The segment right after the
 *  id must be the all-digit timestamp: 'a_b_1.png' fails for id 'a' ('b' is not digits) while
 *  'a_173…_x.png' matches. Exported for unit tests. */
function ownsAttachmentFile (f, id) {
  const s = String(id)
  if (!s || !f.startsWith(s + '_')) return false
  const seg = f.slice(s.length + 1).split('_', 1)[0]
  return /^\d+$/.test(seg)
}

/** Purge disk attachments after hard delete (filename prefix = taskId_, same rule as saveAttachment): warn-only on failure, never blocking */
function purgeAttachmentFiles (attachDir, ids) {
  if (!ids || !ids.length) return
  try {
    const dir = attachDir()
    for (const f of fs.readdirSync(dir)) {
      if (ids.some(id => ownsAttachmentFile(f, id))) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (err) { log.warn('[Purge] 附件删除失败:', f, err.message) }
      }
    }
  } catch (err) { log.warn('[Purge] 附件目录遍历失败:', err.message) }
}

module.exports = { makeAssertMainWindow, purgeAttachmentFiles, ownsAttachmentFile }
