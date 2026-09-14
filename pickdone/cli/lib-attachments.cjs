/* Attachments sub-module extracted from cli/lib.js (2026-09-15 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require).
 * userData/files + image/4 JSON — replicates main/attachments.js saveAttachment. */
const path = require('path')
const fixUtil = require('../src/main/fix-util.js') // pure helpers (no electron/IO): nextFreePath for attachment collisions

module.exports = ({ resolveTask, liveTasks, patchTodo, userDataDir, CliError }) => {
  /* ---------------- Attachments (userData/files + image/4 JSON — replicates main/attachments.js saveAttachment) ---------------- */
  const ATTACH_MAX_BYTES = 50 * 1024 * 1024
  const ATTACH_IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
  // Allowlist kept in sync with attachments.js (a blocklist was once bypassed via Windows trailing dots; here we reuse the allowlist and trailing-dot stripping rules)
  const ATTACH_ALLOWED_EXT = new Set([...ATTACH_IMG_EXT, 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
  // Key resolution collapses to a basename (renderer/main parity: attachments.js attachmentPath) — a
  // crafted `local://..%2F..%2Fdb.key` row must not resolve outside userData/files when unlinking.
  const attachKeyOf = item => { try { return path.basename(decodeURIComponent(String(item.url || '').replace(/^local:\/\//, ''))) } catch { return '' } }

  function addAttachment (input, file) {
    const t = resolveTask(input, liveTasks())
    const fs = require('fs')
    const path = require('path')
    if (!file || !fs.existsSync(file)) throw new CliError('file not found: ' + file, 'FILE_NOT_FOUND')
    const cleanName = path.basename(file).replace(/[. ]+$/, '')
    const ext = path.extname(cleanName).slice(1).toLowerCase()
    if (!ext || !ATTACH_ALLOWED_EXT.has(ext)) throw new CliError('extension not allowed: ' + (ext || '(none)'), 'EXT_NOT_ALLOWED')
    const raw = fs.readFileSync(file)
    if (!raw.length) throw new CliError('file is empty', 'EMPTY_FILE')
    if (raw.length > ATTACH_MAX_BYTES) throw new CliError('file too large (max 50MB)', 'FILE_TOO_LARGE')
    const dir = path.join(userDataDir(), 'files')
    fs.mkdirSync(dir, { recursive: true })
    const base = `${t.taskId.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
    // Same-millisecond same-name uploads used to silently overwrite each other via writeFileSync; reuse the
    // main process's fix (pure helper, src/main/fix-util.js nextFreePath) so every upload lands on its own file.
    const safe = path.basename(fixUtil.nextFreePath(dir, base, p => fs.existsSync(p)))
    fs.writeFileSync(path.join(dir, safe), raw)
    const item = { url: 'local://' + encodeURIComponent(safe), name: cleanName, size: raw.length }
    const field = ATTACH_IMG_EXT.has(ext) ? 'image' : 'files'
    let list = []
    try { list = JSON.parse(t[field] || '[]'); if (!Array.isArray(list)) list = [] } catch { list = [] }
    list.push(item)
    patchTodo(t.taskId, { [field]: JSON.stringify(list) }, { action: 'attachment.add' })
    return { taskId: t.taskId, kind: field === 'image' ? 'image' : 'file', name: item.name, size: item.size, index: list.length }
  }
  function listAttachments (input) {
    const t = resolveTask(input, liveTasks())
    const parse = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }
    return { taskId: t.taskId, images: parse(t.image), files: parse(t.files) }
  }
  /** Remove the n-th image or file attachment (1-based). Unlinks the physical file best-effort (same as the UI delete flow). */
  function removeAttachment (input, kind, n) {
    const t = resolveTask(input, liveTasks())
    const field = /^(img|image|i)$/i.test(kind) ? 'image' : /^(file|f)$/i.test(kind) ? 'files' : null
    if (!field) throw new CliError('kind must be img|file', 'USAGE')
    let list = []
    try { list = JSON.parse(t[field] || '[]'); if (!Array.isArray(list)) list = [] } catch { list = [] }
    const idx = parseInt(n, 10) - 1
    if (!(idx >= 0 && idx < list.length)) throw new CliError(`attachment #${n} not found (${list.length} total)`, 'ATTACH_NOT_FOUND')
    const [item] = list.splice(idx, 1)
    patchTodo(t.taskId, { [field]: JSON.stringify(list) }, { action: 'attachment.remove' })
    const key = attachKeyOf(item)
    if (!key) throw new CliError('attachment has no resolvable file name (refusing to guess)', 'ATTACH_KEY_INVALID')
    try { require('fs').unlinkSync(path.join(userDataDir(), 'files', key)) } catch { /* already gone is fine */ }
    return { taskId: t.taskId, removed: item.name }
  }
  return { addAttachment, listAttachments, removeAttachment }
}
