/** Attachment localization (remote attachment → userData/files) — moved verbatim from index.js (content unchanged) */
const path = require('path')
const fs = require('fs')
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
// W16 (2026-10-28 P2): crash-claim phantoms. claimSlot reserves the final name with an exclusive
// 0-byte placeholder; a process crash between the claim and the publish rename left that 0-byte
// FINAL-named file behind forever — invisible to the D19 `.att-tmp-*` sweep and counted by both
// quota scanners, so every crash permanently shrank the 64MB/200-file budget. There are NO
// legitimate 0-byte attachments: saveAttachment rejects empty payloads and LAN ingress rides the
// same whitelist/size gates, so a 0-byte non-bookkeeping file is always an in-flight claim
// placeholder (young) or a crashed claim (old). Same 24h age gate as .att-tmp-*: a young one may
// be a concurrent upload mid-claim and is never touched; an old one is swept, and a row still
// referencing it hits the existing missing-file guard (re-pull from peer / re-upload) — self-healing.
function isCrashClaimPhantom (f, stat, { now = Date.now(), maxAgeMs = TMP_SWEEP_MAX_AGE_MS } = {}) {
  const name = String(f)
  if (isAppOwnedBookkeeping(name) || isCrashTmpResidue(name)) return false
  try { return stat.size === 0 && now - stat.mtimeMs > maxAgeMs } catch { return false }
}
/** Age-based crash-residue sweep: unlink `.att-tmp-*` older than 24h. A YOUNG tmp file may be
 *  a concurrent transfer's in-flight spool — never touched. Pure-ish over injected fs for tests;
 *  returns the removed count. W16: also unlinks 0-byte crash-claim phantoms (see above). */
function sweepTmpResidue (dir, { now = Date.now(), maxAgeMs = TMP_SWEEP_MAX_AGE_MS, fsMod = fs } = {}) {
  let removed = 0
  try {
    for (const f of fsMod.readdirSync(dir)) {
      let stat = null
      try { stat = fsMod.statSync(path.join(dir, f)) } catch { continue }
      const isTmp = isCrashTmpResidue(f)
      if (!isTmp && !isCrashClaimPhantom(f, stat, { now, maxAgeMs })) continue
      if (now - stat.mtimeMs > maxAgeMs) {
        try { fsMod.unlinkSync(path.join(dir, f)); removed++ } catch { /* best-effort */ }
      }
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
    // C14: white-noise slot; lifecycle: alias map; D19: crash-residue .att-tmp-*; W16: crash-claim
    // 0-byte phantoms — none are attachment quota
    let stat = null
    try { stat = fs.statSync(path.join(dir, f)) } catch { /* vanished mid-scan */ }
    if (isAppOwnedBookkeeping(f) || isCrashTmpResidue(f) || (stat && isCrashClaimPhantom(f, stat))) continue
    if (stat) { bytes += stat.size; count++ }
  }
  return { bytes, count }
}
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'txt', 'md', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'zip', 'mp3', 'wav', 'ogg', 'mp4', 'webm', 'json'])
// F3 (2026-10-19): filename control-char sanitizer (0x00-0x1F). Built from char codes because a
// literal control-char class is an eslint no-control-regex error.
const CTRL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g')
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
    let stat = null
    try { stat = fs.statSync(path.join(dir, f)) } catch { /* raced delete */ }
    if (isAppOwnedBookkeeping(f) || isCrashTmpResidue(f) || (stat && isCrashClaimPhantom(f, stat))) continue
    if (stat) n += stat.size
  }
  return n
}
/** Upload: offline implementation = copy into userData/files and return a file:// style URL (signature mirrors re-assembling the key after the get7nyUpToken flow) */
// P3 F3 TOCTOU (2026-10-19): claim a free filename with an exclusive 0-byte placeholder. Unlike
// the old existsSync probe, openSync('wx') is atomic at the OS level — two concurrent uploads
// aiming at the same name cannot both claim it; the loser gets EEXIST and bumps to name-1, -2…
// fsMod injectable for unit tests. Exported so the claim contract stays directly testable.
function claimSlot (dir, fileName, fsMod = fs) {
  const p = require('path')
  const ext = p.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  let candidate = p.join(dir, fileName)
  for (let i = 0; i < 1000; i++) {
    try { fsMod.closeSync(fsMod.openSync(candidate, 'wx')); return candidate } catch (e) {
      if (e.code !== 'EEXIST') throw e
      candidate = p.join(dir, stem + '-' + (i + 1) + ext)
    }
  }
  candidate = p.join(dir, stem + '-' + Date.now() + ext)
  fsMod.closeSync(fsMod.openSync(candidate, 'wx'))
  return candidate
}
async function saveAttachment ({ taskId, name, dataBase64 }) {
  // Strip Windows trailing dots/spaces before extracting the extension (the filesystem strips them at creation; validation and persistence must see the same name)
  // P3 F3 (2026-10-19): control chars 0x00-0x1F in the name make CreateFile fail outright on
  // Windows (a name like 'a\u0007b.png' lands as a NUL/bell-bearing path → the whole upload 500s
  // instead of one bad attachment). Sanitized FIRST, same style as the reserved-name prefix above:
  // replaced with '_', so extension extraction and every downstream join see the same name.
  // (CTRL_RE is built from char codes — a literal control-char class trips eslint no-control-regex.)
  const cleanName = String(name || '').replace(CTRL_RE, '_').replace(/[. ]+$/, '')
  const ext = path.extname(cleanName).slice(1).toLowerCase()
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error('attachment: extension not allowed')
  // P3 (2026-10-09): Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) fail
  // CreateFile outright even with an extension ('con.png'), and a very long basename can push the
  // full userData/files path past MAX_PATH (ENAMETOOLONG). Fix both here, before the name is
  // joined into the final filename: prefix a reserved basename with '_' (case-insensitive, base
  // before the extension) and cap the whole basename at ~120 chars preserving the extension —
  // the taskId + timestamp prefix in `safe` below adds overhead on top of this.
  const extPart = cleanName.slice(cleanName.length - ext.length - 1) // original-case '.<ext>'
  let stem = cleanName.slice(0, cleanName.length - ext.length - 1)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = '_' + stem
  if (stem.length + extPart.length > 120) stem = stem.slice(0, 120 - extPart.length)
  const displayName = stem + extPart
  // Strict base64 validation (2026-09-09 P2): Buffer.from(b64) is lenient — it decodes whatever prefix is
  // valid and never throws, so corrupted/truncated payloads used to land on disk silently. Require the
  // canonical charset/length AND a decode→re-encode roundtrip match before accepting.
  const { strictBase64 } = require('./fix-util')
  // d-wave fix (2026-10-14): the strictBase64 decode + roundtrip re-encode below operate on the
  // FULL string, so a 1GB base64 payload peaked at 4-5GB of process memory before the 50MB gate
  // rejected it. Cheap length precheck first: decoded bytes ≈ len*3/4 — if that alone exceeds the
  // per-file cap, reject before touching a Buffer. (MAX_BYTES import must stay lazy/call-time to
  // mirror the attachments-guards cycle note below.)
  const lenBytes = Math.floor((dataBase64 ? String(dataBase64).length : 0) * 3 / 4)
  if (lenBytes > MAX_BYTES) throw new Error('attachment: too large (max 50MB)')
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
  // F3 control-char hardening mirrors the cleanName fix: taskId comes from IPC and the cleanName
  // sanitize above does not reach it — a control char in either part would kill CreateFile again.
  const safe = `${String(taskId).replace(CTRL_RE, '_').replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_')}_${Date.now()}_${displayName.replace(CTRL_RE, '_').replace(/[\\/:*?"<>|]/g, '_')}`
  // P2 2026-09-12: two uploads in the same millisecond with the same task/name produced the same
  // Date.now() filename and writeFileSync silently overwrote the first attachment. Suffix -1/-2…
  // (pure helper in fix-util, testable) so every upload lands on its own file.
  // P3 F3 TOCTOU (2026-10-19): nextFreePath's existsSync probe raced concurrent uploads — both
  // picked the same free name, the later rename overwrote the first upload's bytes and -1/-2
  // dedup was dead in the gap. claimSlot below closes it: each candidate is CLAIMED with an
  // exclusive fs.openSync('wx') 0-byte placeholder (a losing racer's 'wx' throws EEXIST and it
  // bumps to the next suffix), then the durable spool renames over OUR OWN placeholder. The
  // writeFileDurable tmp -> fsync -> rename order is untouched (D22 durability contract holds);
  // a failed write cleans up the placeholder in the finally below.
  const dest = claimSlot(attachDir(), safe)
  // D20-B11: atomic write (spool to .att-tmp-* + rename, mirroring att-transfer.js writeAtomic).
  // The bare writeFileSync left a TORN file looking healthy forever (existence-only guards);
  // a crash mid-write now leaves only .att-tmp residue, which the D19 startup sweep ages out.
  const tmp = `${dest}.att-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  let published = false
  try {
    // D22 (P2 2026-10-02): the upload twin of the LAN-receive writeAtomic (att-transfer.js D21)
    // — route the spool through writeFileDurable (tmp -> fsync -> rename) so the final rename
    // cannot hit disk before the uploaded bytes after a power cut. The bare writeFileSync left
    // the two doors with DIFFERENT durability. The .att-tmp name is kept so the D19 startup
    // residue sweep still matches crash trash from either door.
    require('./durable-fs').writeFileDurable(tmp, raw, fs)
    fs.renameSync(tmp, dest)
    published = true
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    if (!published) { try { fs.unlinkSync(dest) } catch { /* placeholder cleanup best-effort */ } }
  }
  const finalName = path.basename(dest)
  const url = `local://${encodeURIComponent(finalName)}`
  return { url, key: finalName, name, size: fs.statSync(dest).size, ext }
}
/** F2 (2026-10-15): resolve the on-disk key a `local://` url refers to — percent-decode + basename,
 *  with attachmentPath's same malformed-encoding fallback (raw key). Non-local:// urls → null.
 *  Pure (no IO), so both the App delete-file handler and the CLI remove path count references
 *  through the SAME resolution rules the unlink itself uses. */
function attachmentKeyOfUrl (url) {
  if (typeof url !== 'string' || !url.startsWith('local://')) return null
  let k = url.slice(8)
  try { k = decodeURIComponent(k) } catch { /* malformed encoding: raw key, matches attachmentPath */ }
  return path.basename(k)
}

/** F2 (2026-10-15): scan todo rows' image/files metadata for references to a local:// attachment
 *  key. Deleting a single attachment used to unlink by key alone — task B's only physical copy
 *  died when task A deleted its entry for the same local:// key (shared after copy/paste or a
 *  repeat template). Pure (rows in, hits out): callers pass db.getAll rows (App) or liveTasks()
 *  (CLI); `excludeTaskId` drops one row (the task whose own entry was already spliced out in
 *  memory — its UPDATED list is scanned by the caller as a pseudo-row). Returns [{taskId, field}];
 *  empty array = no other row references the key = safe to unlink. */
function findKeyRefs (key, rows, { excludeTaskId = null } = {}) {
  const target = path.basename(String(key || ''))
  if (!target) return []
  const hits = []
  for (const row of (rows || [])) {
    if (!row || (excludeTaskId != null && String(row.taskId) === String(excludeTaskId))) continue
    for (const field of ['image', 'files']) {
      let list
      try { list = JSON.parse(row[field] || '[]'); if (!Array.isArray(list)) continue } catch { continue }
      for (const item of list) {
        if (attachmentKeyOfUrl(item && item.url) === target) hits.push({ taskId: row.taskId, field })
      }
    }
  }
  return hits
}

/** W16 (2026-10-28 P2): case-insensitive resolve fallback for local:// keys. The key minted by
 *  saveAttachment preserves the user file's ORIGINAL case, and Chromium lowercases the HOST part
 *  of standard-scheme URLs — on a case-sensitive filesystem a local://Fetch.PNG request for
 *  fetch.PNG (or vice versa) used to 404 outright (Windows was accidentally masked by its
 *  case-insensitive FS, while aliases.json / findKeyRefs kept comparing original case, so a
 *  case-only rename could strand refs or delete the wrong twin). Minimal, storage-neutral fix:
 *  resolve on-disk at the SERVE boundary only — exact stat first, else the unique
 *  case-insensitive basename match; the raw path when nothing matches (the caller keeps its 404
 *  contract). No DB rows are touched and no keys are rewritten. */
function resolveAttachmentCase (resolvedPath, fsMod = fs) {
  try { if (fsMod.statSync(resolvedPath).isFile()) return resolvedPath } catch { /* fall through to scan */ }
  let base
  try { base = path.basename(resolvedPath) } catch { return resolvedPath }
  try {
    const dir = path.dirname(resolvedPath)
    const hit = fsMod.readdirSync(dir).find(f => f.toLowerCase() === base.toLowerCase())
    if (hit) return path.join(dir, hit)
  } catch { /* unreadable dir: keep the raw path */ }
  return resolvedPath
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
  // F3: exclusive-claim slot allocator (TOCTOU fix) — exported for its own regression tests.
  claimSlot,
  // Alias map (LAN same-name conflict resolution): read/set/delete + list for tests/consumers.
  readAliases, setAlias, deleteAlias, aliasesPath, pruneMissingAliases,
  // F2: shared-reference counting for single-key deletes (App delete-file + CLI attachment rm).
  attachmentKeyOfUrl, findKeyRefs,
  // W16: serve-side case-insensitive key resolve fallback (local:// host lowercasing).
  resolveAttachmentCase,
  // C5/C14 (2026-09-25): MAX_BYTES/MAX_FILES and the noise-slot classifier are exported so
  // attachments-guards.js is the shared gate for every write entry without duplicating caps.
  MAX_BYTES, MAX_FILES, isUnownedNoiseFile, dirUsage,
  // D19-DOM1: crash-residue classifier + age sweep (exported for unit tests / the att-tmp quota fix).
  isCrashTmpResidue, sweepTmpResidue, TMP_SWEEP_MAX_AGE_MS,
  // W16: crash-claim 0-byte phantom classifier (startup sweep + quota exclusion).
  isCrashClaimPhantom,
  // Domain-1 F-A2 refactor (2026-09-23): the whitelist is exported so the LAN attachment
  // receiver (lan-sync/att-transfer.js) enforces the SAME extension set on inbound files —
  // one whitelist, two doors (upload IPC + sync ingress); keep it tighten-only (D6 svg root-fix).
  ALLOWED_EXT }
