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

/** Pure decision for the startup meta GC (extracted 2026-09-19 from index.js for unit testing —
 *  the P1 fix itself is the `deleted: 0` filter at the getAll call site in index.js, so the
 *  deleted/live boundary stays observable here): given meta keys, live categories and todo rows,
 *  returns the orphan keys to delete. A repeatId referenced only by a recycle-bin row anchors its
 *  rule ONLY if the caller passes deleted rows in — index.js passes `deleted: 0`, so deleted tasks
 *  never keep repeatRule meta alive. Pure: returns keys, never performs IO. */
function computeMetaGc (metaKeys, categories, todos) {
  const live = new Set((categories || []).map(c => String(c.id || c.categoryId)))
  const liveRids = new Set((todos || []).map(t => t.repeatId).filter(Boolean))
  const dead = []
  for (const k of metaKeys || []) {
    let m = k.match(/^repeatRule:(.+)$/)
    if (m && !liveRids.has(m[1])) { dead.push(k); continue }
    m = k.match(/^(?:projectDeadline|projectMilestones):(.+)$/)
    if (m && !live.has(m[1])) dead.push(k)
  }
  return dead
}

module.exports = { makeAssertMainWindow, purgeAttachmentFiles, ownsAttachmentFile, computeMetaGc }
