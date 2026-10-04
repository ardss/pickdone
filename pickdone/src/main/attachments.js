/** Attachment localization (remote attachment → userData/files) — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
const fixUtil = require('./fix-util')
const { app } = require('electron')

function attachDir () {
  const d = path.join(app.getPath('userData'), 'files')
  fs.mkdirSync(d, { recursive: true })
  if (!_tmpSweepDone) {
    _tmpSweepDone = true
    try { sweepTmpResidue(d) } catch { /* sweep is best-effort, never blocks attachDir */ }
  }
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
// C14 (2026-09-25): `noise-custom.*` is the custom white-noise pick (handlers/attachments.js),
// NOT an attachment — it has its own entry point (and, since C5, its own per-file cap) and is a
// single fixed-name slot that overwrites itself. Counting it against the attachment quota meant
// one ~60MB audio file nearly starved ALL attachment uploads (63.5MB noise + 1MB upload = quota
// exceeded). Excluded from BOTH the byte sum and the file count.
const NOISE_CUSTOM_RE = /^noise-custom\./
function isUnownedNoiseFile (f) { return NOISE_CUSTOM_RE.test(String(f)) }
// Lifecycle fix (2026-10-02): aliases.json is the device-local alias map's own storage (see the
// alias-map block below) — bookkeeping, not an attachment. It used to be counted by BOTH quota
// scanners (dirUsage/dirTotalBytes): 1 phantom file toward MAX_FILES=200 and its bytes toward the
// 64MB budget. Same rationale as the C14 noise-slot exclusion.
function isAppOwnedBookkeeping (f) { return isUnownedNoiseFile(f) || String(f) === 'aliases.json' }
// D19-DOM1 (2026-10-02): crash-residue `.att-tmp-*` files (crash spool leftovers) are invisible
// to the sync protocol and nothing reads them — counting them punished the crash victim with a
// permanently shrunken 64MB/200-file budget. Excluded from quota accounting here AND age-swept
// on startup (sweepTmpResidue below) so they cannot accumulate either.
const ATT_TMP_RE = /\.att-tmp-\d+-\d+$/
const TMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000
function isCrashTmpResidue (f) { return ATT_TMP_RE.test(String(f)) }
/** Age-based crash-residue sweep: unlink `.att-tmp-*` older than 24h. A YOUNG tmp file may be
 *  a concurrent transfer's in-flight spool — never touched. Pure-ish over injected fs for tests;
 *  returns the removed count. */
function sweepTmpResidue (dir, { now = Date.now(), maxAgeMs = TMP_SWEEP_MAX_AGE_MS, fsMod = fs } = {}) {
  let removed = 0
  try {
    for (const f of fsMod.readdirSync(dir)) {
      if (!isCrashTmpResidue(f)) continue
      let old = false
      try { old = now - fsMod.statSync(path.join(dir, f)).mtimeMs > maxAgeMs } catch { old = false }
      if (!old) continue
      try { fsMod.unlinkSync(path.join(dir, f)); removed++ } catch { /* best-effort */ }
    }
  } catch { /* unreadable dir: nothing to sweep */ }
  return removed
}
// Startup sweep runs ONCE per process, lazily, on the first attachDir() (every quota/write/
// resolve path funnels through it) — no separate init hook needed.
let _tmpSweepDone = false
function dirUsage (dir) {
  let bytes = 0
  let count = 0
  for (const f of fs.readdirSync(dir)) {
    // C14: white-noise slot; lifecycle: alias map; D19: crash-residue .att-tmp-* — none are attachment quota
    if (isAppOwnedBookkeeping(f) || isCrashTmpResidue(f)) continue
    try { bytes += fs.statSync(path.join(dir, f)).size; count++ } catch { /* vanished mid-scan */ }
  }
  return { bytes, count }
}
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
// main-ipc-4 quota fix (2026-09-22): the wave-C aggregate quota is also exposed as a pure,
// unit-testable decision (withinStorageQuota) plus a byte-size scanner — same flood guard,
// testable without 64MB fixtures.
// Test hook: lets unit tests shrink the quota without writing 500MB of fixture data.
let _totalQuotaOverride = null
function __setTotalQuota (bytes) { _totalQuotaOverride = bytes } // test-only
/** Pure quota decision (unit-testable): does existing + incoming stay within the cap? */
function withinStorageQuota (existingBytes, incomingBytes, quotaBytes) {
  const q = quotaBytes == null ? (_totalQuotaOverride || MAX_TOTAL_BYTES) : quotaBytes
  return (Number(existingBytes) || 0) + (Number(incomingBytes) || 0) <= q
}
/** Current total byte size of the attachment directory (missing/unreadable files count 0 — the
 *  quota is a best-effort flood guard, not an accounting ledger). C14: noise-custom.* excluded
 *  (see dirUsage) so the white-noise slot cannot starve attachment uploads. */
function dirTotalBytes (dir) {
  let n = 0
  for (const f of fs.readdirSync(dir)) {
    if (isAppOwnedBookkeeping(f) || isCrashTmpResidue(f)) continue
    try { n += fs.statSync(path.join(dir, f)).size } catch { /* raced delete */ }
  }
  return n
}
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
  // C5/C12 architecture wave (2026-09-25): the per-file size cap + aggregate quota now route
  // through attachments-guards (single source shared with the white-noise pick entry — its
  // guards.assertWriteAllowed enforces the SAME caps). Lazy require: guards itself requires
  // this module for the exported pure gates, so the cycle must stay call-time only.
  require('./attachments-guards').assertWriteAllowed({ incomingBytes: raw.length, dir: attachDir() })
  const safe = `${String(taskId).replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${cleanName.replace(/[\\/:*?"<>|]/g, '_')}`
  // P2 2026-09-12: two uploads in the same millisecond with the same task/name produced the same
  // Date.now() filename and writeFileSync silently overwrote the first attachment. Suffix -1/-2…
  // (pure helper in fix-util, testable) so every upload lands on its own file.
  const dest = fixUtil.nextFreePath(attachDir(), safe, p => fs.existsSync(p))
  // D20-B11: atomic write (spool to .att-tmp-* + rename, mirroring att-transfer.js writeAtomic).
  // The bare writeFileSync left a TORN file looking healthy forever (existence-only guards);
  // a crash mid-write now leaves only .att-tmp residue, which the D19 startup sweep ages out.
  const tmp = `${dest}.att-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  try {
    fs.writeFileSync(tmp, raw)
    fs.renameSync(tmp, dest)
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
  }
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
  const base = path.basename(decoded)
  // LAN conflict rename (att-transfer-rename-ref-mismatch fix): when a pulled file with the same
  // name but DIFFERENT content was renamed to `name-1` on disk, the synced row still says
  // local://name — consult the device-local alias map FIRST so this device's resolution lands on
  // the renamed bytes (the row itself must stay untouched: rewriting it would diverge from the
  // sender's row and re-sync forever).
  const alias = readAliases()[base]
  return path.join(attachDir(), alias ? path.basename(alias) : base)
}

/* ---------- device-local attachment alias map (never synced) ----------
 * Logical local:// key -> actual on-disk name, recorded when the LAN pull renames a
 * same-name-different-content conflict to `name-1` (att-transfer.js writeAtomic). Synced rows
 * keep the ORIGINAL name; device-local by design — syncing the map would corrupt both ends. */
function aliasesPath () { return path.join(attachDir(), 'aliases.json') }
function readAliases () {
  try { const o = JSON.parse(fs.readFileSync(aliasesPath(), 'utf8')); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch { /* no map / unreadable: empty */ }
  return {}
}
// D18 (2026-10-02): the alias map used to be written with a bare writeFileSync — a torn write
// silently WIPED the map (readAliases' catch→{}). Route writes through durable-fs (fsync+rename).
function writeAliasesDurable (map) {
  try { require('./durable-fs').writeFileDurable(aliasesPath(), JSON.stringify(map, null, 1)) } catch { /* best-effort */ }
}
function setAlias (key, diskName) {
  const k = path.basename(String(key || ''))
  const n = path.basename(String(diskName || ''))
  if (!k || !n || k === n) return false
  const map = readAliases()
  map[k] = n
  writeAliasesDurable(map)
  return true
}
function deleteAlias (key) {
  const k = path.basename(String(key || ''))
  if (!k) return false
  const map = readAliases()
  if (!(k in map)) return false
  delete map[k]
  writeAliasesDurable(map)
  return true
}
/** Lifecycle fix (2026-10-02): purge/delete-todo-files/hardDelete remove owned files in bulk but
 *  never touched the alias map — entries whose TARGET died with the purge leaked forever AND went
 *  stale: attachmentPath() kept translating the dead key to the missing renamed file, so the
 *  missing-file guard could never recognize the gap and re-pull. Dropping an alias whose target
 *  is missing is always safe (resolution falls back to the base name). `exists` injectable. */
function pruneMissingAliases (exists = p => fs.existsSync(p)) {
  const map = readAliases()
  let removed = 0
  for (const k of Object.keys(map)) {
    let gone = false
    try { gone = !exists(path.join(attachDir(), path.basename(String(map[k] || '')))) } catch { gone = false }
    if (gone) { delete map[k]; removed++ }
  }
  if (removed) writeAliasesDurable(map)
  return removed
}

module.exports = { attachDir, saveAttachment, attachmentPath, withinStorageQuota, dirTotalBytes, MAX_TOTAL_BYTES, __setTotalQuota,
  // Alias map (LAN same-name conflict resolution): read/set/delete + list for tests/consumers.
  readAliases, setAlias, deleteAlias, aliasesPath, pruneMissingAliases,
  // C5/C14 (2026-09-25): MAX_BYTES/MAX_FILES and the noise-slot classifier are exported so
  // attachments-guards.js is the shared gate for every write entry without duplicating caps.
  MAX_BYTES, MAX_FILES, isUnownedNoiseFile, dirUsage,
  // D19-DOM1: crash-residue classifier + age sweep (exported for unit tests / the att-tmp quota fix).
  isCrashTmpResidue, sweepTmpResidue, TMP_SWEEP_MAX_AGE_MS,
  // Domain-1 F-A2 refactor (2026-09-23): the whitelist is exported so the LAN attachment
  // receiver (lan-sync/att-transfer.js) enforces the SAME extension set on inbound files —
  // one whitelist, two doors (upload IPC + sync ingress); keep it tighten-only (D6 svg root-fix).
  ALLOWED_EXT }
