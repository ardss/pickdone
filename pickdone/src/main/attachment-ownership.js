/** Attachment filename ownership rules (electron-free domain module, D3 2026-09-24).
 *  Extracted from handlers/shared.js so the CLI (cli/lib.js, which runs in pure Node) can
 *  depend on this module WITHOUT dragging in the electron-log require that shared.js carries.
 *  Dependency direction: handlers/shared.js and cli/lib.js → here; nothing electron-related
 *  may appear in this file. */
const fs = require('fs')

/** Ownership test for attachment filenames (P2 2026-09-17). saveAttachment names files
 * `${taskId}_${Date.now()}_${name}`, so a bare startsWith(taskId + '_') let a task whose id is a
 * prefix of another id ('a' vs 'a_b') delete the other task's files. The segment right after the
 * id must be the all-digit timestamp: 'a_b_1.png' fails for id 'a' ('b' is not digits) while
 * 'a_173…_x.png' matches. Exported for unit tests. */
function ownsAttachmentFile (f, id) {
  const s = String(id)
  if (!s || !f.startsWith(s + '_')) return false
  const seg = f.slice(s.length + 1).split('_', 1)[0]
  return /^\d+$/.test(seg)
}

/** D3 (2026-09-24, verbatim extraction from handlers/todo.js hardDelete pre-collection):
 *  list the attachment files in attachDir owned by a single task id, BEFORE the row is
 *  deleted (files-before-rows, P3 R4 2026-09-21). Caller keeps its warn-only try/catch. */
function collectOwnedAttachmentFiles (attachDir, id) {
  return fs.readdirSync(attachDir()).filter(f => ownsAttachmentFile(f, id))
}

module.exports = { ownsAttachmentFile, collectOwnedAttachmentFiles }
