/** Attachment localization (remote attachment → userData/files) — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
const fixUtil = require('./fix-util')
const { app } = require('electron')

function attachDir () {
  const d = path.join(app.getPath('userData'), 'files')
  fs.mkdirSync(d, { recursive: true })
  return d
}
// Attachment constraints: 50MB max per file; extension **whitelist** (after saving, open-file → shell.openPath can execute directly; a blacklist
// could once be bypassed by Windows trailing dots/spaces: 'calc.exe.' has an empty extname → no blacklist hit → the filesystem strips the trailing dot and calc.exe lands on disk)
// D6 P2 (2026-09-21): svg REMOVED — it is script-capable and open-file/download-file-and-open hand
// it to shell.openPath → the OS browser executes it OUTSIDE the app CSP. Dropping the extension
// entirely is the root fix (svg attachments are rare; download-only carve-outs would be overkill).
const MAX_BYTES = 50 * 1024 * 1024
// P2-4 (R4 2026-09-21): per-file limits were enforced but the upload-attachment channel had NO
// aggregate quota — a compromised renderer could fill the disk with 50MB files forever. Align
// the total budget with the LAN attachment-transfer round budget (64MB, att-transfer.js) and cap
// the file count. Best-effort check (concurrent uploads can race past it slightly; still caps
// the unbounded growth).
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_FILES = 200
function dirUsage (dir) {
  let bytes = 0
  let count = 0
  for (const f of fs.readdirSync(dir)) {
    try { bytes += fs.statSync(path.join(dir, f)).size; count++ } catch { /* vanished mid-scan */ }
  }
  return { bytes, count }
}
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
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
  // P2-4 (R4 2026-09-21): aggregate quota (64MB total / 200 files, matching the LAN transfer budget)
  const { bytes: usedBytes, count: usedFiles } = dirUsage(attachDir())
  if (usedBytes + raw.length > MAX_TOTAL_BYTES) throw new Error('attachment: storage quota exceeded (max 64MB total)')
  if (usedFiles >= MAX_FILES) throw new Error('attachment: too many attachment files (max 200)')
  const safe = `${String(taskId).replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
  // P2 2026-09-12: two uploads in the same millisecond with the same task/name produced the same
  // Date.now() filename and writeFileSync silently overwrote the first attachment. Suffix -1/-2…
  // (pure helper in fix-util, testable) so every upload lands on its own file.
  const dest = fixUtil.nextFreePath(attachDir(), safe, p => fs.existsSync(p))
  fs.writeFileSync(dest, raw)
  const finalName = path.basename(dest)
  const url = `local://${encodeURIComponent(finalName)}`
  return { url, key: finalName, name, size: fs.statSync(dest).size, ext }
}
function attachmentPath (key) {
  // Malformed percent-encoding (e.g. 'a%zz.png') made decodeURIComponent throw URIError; protocol.js
  // already maps the handler-level throw to a 404 — fall back to the raw key so both layers agree and
  // a weird-but-harmless key can still resolve to a real file instead of hard-failing the request.
  let decoded = key
  try { decoded = decodeURIComponent(key) } catch { decoded = key }
  return path.join(attachDir(), path.basename(decoded))
}

module.exports = { attachDir, saveAttachment, attachmentPath }
