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

/** Purge disk attachments after hard delete (filename prefix = taskId_, same rule as saveAttachment): warn-only on failure, never blocking */
function purgeAttachmentFiles (attachDir, ids) {
  if (!ids || !ids.length) return
  try {
    const dir = attachDir()
    const prefixes = ids.map(id => `${id}_`)
    for (const f of fs.readdirSync(dir)) {
      if (prefixes.some(p => f.startsWith(p))) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (err) { log.warn('[Purge] 附件删除失败:', f, err.message) }
      }
    }
  } catch (err) { log.warn('[Purge] 附件目录遍历失败:', err.message) }
}

module.exports = { makeAssertMainWindow, purgeAttachmentFiles }
