/** Attachment localization (remote attachment → userData/files) — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

function attachDir () {
  const d = path.join(app.getPath('userData'), 'files')
  fs.mkdirSync(d, { recursive: true })
  return d
}
// Attachment constraints: 50MB max per file; extension **whitelist** (after saving, open-file → shell.openPath can execute directly; a blacklist
// could once be bypassed by Windows trailing dots/spaces: 'calc.exe.' has an empty extname → no blacklist hit → the filesystem strips the trailing dot and calc.exe lands on disk)
const MAX_BYTES = 50 * 1024 * 1024
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
/** Upload: offline implementation = copy into userData/files and return a file:// style URL (signature mirrors re-assembling the key after the get7nyUpToken flow) */
async function saveAttachment ({ taskId, name, dataBase64 }) {
  // Strip Windows trailing dots/spaces before extracting the extension (the filesystem strips them at creation; validation and persistence must see the same name)
  const cleanName = String(name || '').replace(/[. ]+$/, '')
  const ext = path.extname(cleanName).slice(1).toLowerCase()
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error('attachment: extension not allowed')
  // Strict base64 validation (2026-09-09 P2): Buffer.from(b64) is lenient — it decodes whatever prefix is
  // valid and never throws, so corrupted/truncated payloads used to land on disk silently. Require the
  // canonical charset/length AND a decode→re-encode roundtrip match before accepting.
  const { strictBase64 } = require('./fix-util')
  const stripped = strictBase64(dataBase64)
  if (!stripped) throw new Error('attachment: invalid base64 payload')
  const raw = Buffer.from(stripped, 'base64')
  if (raw.toString('base64') !== stripped) throw new Error('attachment: base64 roundtrip mismatch')
  if (!raw.length) throw new Error('attachment: empty')
  if (raw.length > MAX_BYTES) throw new Error('attachment: too large (max 50MB)')
  const safe = `${String(taskId).replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
  const dest = path.join(attachDir(), safe)
  fs.writeFileSync(dest, raw)
  const url = `local://${encodeURIComponent(safe)}`
  return { url, key: safe, name, size: fs.statSync(dest).size, ext }
}
function attachmentPath (key) { return path.join(attachDir(), path.basename(decodeURIComponent(key))) }

module.exports = { attachDir, saveAttachment, attachmentPath }
