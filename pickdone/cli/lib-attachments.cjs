/* Attachments sub-module extracted from cli/lib.js (2026-09-15 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require).
 * userData/files + image/4 JSON — replicates main/attachments.js saveAttachment. */
const path = require('path')
const fixUtil = require('../src/main/fix-util.js') // pure helpers (no electron/IO): nextFreePath for attachment collisions

// src/main/attachments.js is an Electron main module (it requires('electron') at load), but under
// plain node `require('electron')` resolves to the binary path STRING, so every export loads fine —
// only attachDir() touches app.getPath. Before the first require we install a minimal electron stub
// into the require cache that routes app.getPath('userData') through user-dir.js (the CLI's single
// userData source), so attachmentPath()/deleteAlias() below run under plain node too.
const { userDataDir } = require('../src/main/user-dir.js')
try {
  const electronId = require.resolve('electron')
  let real = null
  try { real = require('electron') } catch { /* not installed */ }
  // Replace the entry ONLY when it is not an object (the plain-node path string). An existing
  // OBJECT — real Electron, or another module's stub (e.g. a test's dialog double installed
  // before cli/lib loads via import/index.js:226) — must be left alone: clobbering it breaks
  // every later require('electron') consumer in the same process (2026-10-04 TOCTOU red).
  if (!real || typeof real !== 'object') {
    require.cache[electronId] = { id: electronId, filename: electronId, loaded: true, exports: { app: { getPath: () => userDataDir() } } }
  }
} catch { /* electron not resolvable: attachments.js still loads (only attachDir would need it) */ }
const attachments = require('../src/main/attachments.js')

module.exports = ({ resolveTask, liveTasks, patchTodo, userDataDir, CliError }) => {
  /* ---------------- Attachments (userData/files + image/4 JSON — replicates main/attachments.js saveAttachment) ---------------- */
  const ATTACH_MAX_BYTES = 50 * 1024 * 1024
  // Raster-image subset (drives the image-vs-files field classification only). svg was dropped from
  // the main allowlist as script-capable (D6 root fix) — the hand-copied set here must not re-admit it.
  const ATTACH_IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])
  // B1: the allowlist is no longer a hand copy that silently drifted — derive it from
  // attachments.js's exported ALLOWED_EXT (svg removal is inherited automatically; a blocklist was
  // once bypassed via Windows trailing dots; the CLI reuses the same allowlist and stripping rules).
  const ATTACH_ALLOWED_EXT = attachments.ALLOWED_EXT
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
    fs.mkdirSync(dir, { recursive: true }) // the quota scanner readdir's the dir — it must exist before the gate runs
    // B7: the shared aggregate write gate (per-file cap + 64MB storage quota + 200-file count —
    // attachments-guards.assertWriteAllowed, the same gate every main-process write entry funnels
    // through). Without it the CLI could fill the disk with 50MB files past the quota the App enforces.
    try {
      require('../src/main/attachments-guards.js').assertWriteAllowed({ incomingBytes: raw.length, dir })
    } catch (e) {
      throw new CliError(String((e && e.message) || e), 'QUOTA_EXCEEDED')
    }
    const base = `${t.taskId.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
    // Same-millisecond same-name uploads used to silently overwrite each other via writeFileSync; reuse the
    // main process's fix (pure helper, src/main/fix-util.js nextFreePath) so every upload lands on its own file.
    const safe = path.basename(fixUtil.nextFreePath(dir, base, p => fs.existsSync(p)))
    fs.writeFileSync(path.join(dir, safe), raw)
    // D19-DOM2 (#10, App parity): the row's `name` keeps the RAW basename — the App's
    // saveAttachment (src/main/attachments.js) persists the raw `name` and strips trailing
    // dots/spaces only for the on-disk key. The CLI used to persist the STRIPPED name, so the
    // same file displayed differently (and de-duplicated differently) per channel. cleanName
    // remains the extension-validation + filesystem-key surface only.
    const item = { url: 'local://' + encodeURIComponent(safe), name: path.basename(file), size: raw.length }
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
    // Validate before write: attach-key resolution must happen BEFORE patchTodo — an unresolvable url
    // used to mutate the row (attachment dropped from the JSON) and only then error, so a retry hit
    // ATTACH_NOT_FOUND with the row already changed (non-atomic, 2026-09-15). unlink stays best-effort.
    const key = attachKeyOf(item)
    if (!key) throw new CliError('attachment has no resolvable file name (refusing to guess)', 'ATTACH_KEY_INVALID')
    patchTodo(t.taskId, { [field]: JSON.stringify(list) }, { action: 'attachment.remove' })
    // B6: resolve through attachments.attachmentPath (percent-decode + LAN-conflict alias map),
    // NOT the raw key — after a LAN same-name/different-content pull the row's local://key no
    // longer matches the on-disk `name-1` rename, so unlinking the raw key left the real bytes
    // as an orphan. Same contract as the App's delete-file handler: unlink the RESOLVED path,
    // then drop the alias entry (both best-effort, already-gone is fine).
    try { require('fs').unlinkSync(attachments.attachmentPath(key)) } catch { /* already gone is fine */ }
    try { attachments.deleteAlias(key) } catch { /* best-effort, same as delete-file */ }
    return { taskId: t.taskId, removed: item.name }
  }
  return { addAttachment, listAttachments, removeAttachment }
}
