/** Backup/critical-state domain IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const i18nM = require('../i18n')
const dbRecovery = require('../dbRecovery.cjs')
const autoBackup = require('../autoBackup')
const fixUtil = require('../fix-util')
const { resolveBackupDir, defaultBackupRoot, saveAllowedBackupDirs, allowedBackupDirs, loadAllowedBackupDirs } = require('../backup-dirs')
const { makeAssertMainWindow } = require('./shared')

let log
try { log = require('electron-log') } catch { log = { warn () {}, error () {} } }
require('../log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

/** Atomic JSON write (tmp + rename) with temp-file cleanup on failure (P2 2026-09-17: a failed
 *  writeFileSync/renameSync used to leave .tmp-* residue until the 1h sweep at best — and if the
 *  process died before any later backup run, forever). fs is injected so the unit tests can drive
 *  failure injection; returns { ok } and never throws.
 *  main-ipc-2 fsync fix (2026-09-22): the write goes through writeFileDurable (data fsync before
 *  the rename + best-effort dir fsync) — this JSON is the disaster-recovery source, and a power
 *  cut between the OS cache and the rename used to leave a torn file. The fsMod injection is kept
 *  for the residue-cleanup contract; the durable path always uses the real fs. */
function atomicWriteJson (fsMod, dir, name, text) {
  // C3 (2026-09-24): tmp names are unique per call (<file>.<pid>.<ms>.dtmp, see durable-fs.dtmpPath);
  // the failure-cleanup check must target the SAME path the durable writer used.
  const tmp = require('../durable-fs').dtmpPath(path.join(dir, name))
  try {
    require('../durable-fs').writeFileDurable(path.join(dir, name), text, fsMod)
    return { ok: true, file: name }
  } catch (err) {
    try { if (fsMod.existsSync(tmp)) fsMod.unlinkSync(tmp) } catch (e2) { log.warn('[Backup] tmp cleanup failed:', tmp, e2 && e2.message) }
    log.warn('[Backup] auto backup write failed:', err && err.message || err)
    return { ok: false, error: String(err && err.message || err) }
  }
}

/** F21 (dw wave6 2026-09-24): pick a collision-free snapshot filename. Same-tag same-second
 *  snapshots used to silently overwrite each other (evt-<reason> events fire back-to-back; the
 *  atomic rename lands on the same name, the earlier snapshot is gone, yet {ok:true} is still
 *  returned). D17 (2026-10-02): the collision resolution is a `-dup<n>` suffix AFTER the stamp
 *  instead of the old +1s..+900s stamp bumps — the bumps minted FUTURE-dated names, so a real
 *  snapshot landing seconds later collided with (and atomically overwrote) a dedup'd-away dup.
 *  A suffixed name parses as ts=0 in the GFS sort (fix-util.backupNameTs), i.e. it sorts oldest
 *  and is pruned first — acceptable by design: it is a same-second duplicate point, and it must
 *  never shadow a real timestamped snapshot in dedup/retention. Exhaustion (900 dup names)
 *  returns null and the caller reports failure. baseMs is kept in the signature for callers. */
function uniqueSnapshotName (existsSync, dir, tag, stamp, baseMs) {
  void baseMs
  const name = tag + stamp + '.json'
  // Common path (no collision) is byte-identical to the historical naming.
  if (!existsSync(path.join(dir, name))) return name
  for (let n = 1; n <= 900; n++) {
    const dup = tag + stamp + '-dup' + n + '.json'
    if (!existsSync(path.join(dir, dup))) return dup
  }
  return null
}

/** D11 finding 17: the content-dedup twin must come from the SAME tag prefix. The old compare
 *  took existing[0] across ALL tags: when the newest file was an `evt-*` snapshot, a new `auto-`
 *  snapshot with identical content was reported dedup'd against it — and when the evt twin was
 *  later pruned by ITS tier's rotation (eventKeep), that content point vanished from the auto
 *  tier entirely. Pure: returns the newest name carrying `tag` as its prefix (newest-first
 *  input, as fixUtil.sortBackupNamesNewestFirst produces), or null. Exported for unit tests. */
function newestSameTag (namesNewestFirst, tag) {
  const prefix = String(tag || '')
  if (!prefix) return null
  return (namesNewestFirst || []).find(f => typeof f === 'string' && f.startsWith(prefix)) || null
}

// C2 (2026-10-02): 'write-critical-state-backup' / 'run-auto-backup' both take renderer-supplied
// JSON verbatim — an unbounded payload (compromised or buggy renderer) used to be spooled into
// main-process memory (dedup read + atomic write) with no ceiling. The legit critical-state JSON
// is a few MB at worst; 64MB matches the sibling ingress-cap caliber. Enforced at the handler
// entry (the single door for both channels), rejected with a coded error the renderer can
// classify. Exported constants/helpers are for unit tests.
const INGRESS_MAX_BYTES = 64 * 1024 * 1024
function assertIngressSize (jsonText, channel) {
  const bytes = typeof jsonText === 'string' ? Buffer.byteLength(jsonText, 'utf8') : 0
  if (bytes > INGRESS_MAX_BYTES) {
    const err = new Error(channel + ' payload too large: ' + bytes + ' > ' + INGRESS_MAX_BYTES + ' bytes')
    err.code = 'PAYLOAD_TOO_LARGE'
    throw err
  }
}

// D17 P2: the disaster-recovery JSON must be plausible before it is allowed to become the
// FRESHEST snapshot. writeCriticalStateBackupAtomic wrote renderer jsonText verbatim — an empty
// string or non-JSON garbage (crashed renderer, corrupted transfer) overwrote a good
// critical-state-backup.json and poisoned the recovery source. Aligned with the reader-side
// plausibility bar (dbRecovery.backupJsonParseable: must parse; per-segment tolerance stays in
// the restore functions) plus a non-triviality floor: the payload must parse to an OBJECT with
// at least one key (the renderer writes { backup: { todoState, metaState, ... }, ... } — a bare
// 'null' / '123' / empty string is garbage by construction). Exported for unit tests.
function criticalJsonPlausible (jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) return false
  try {
    const raw = JSON.parse(jsonText)
    return !!(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length > 0)
  } catch { return false }
}
function assertCriticalJsonPlausible (jsonText) {
  if (!criticalJsonPlausible(jsonText)) {
    const err = new Error('write-critical-state-backup payload is not plausible backup JSON (empty or unparsable/non-object)')
    err.code = 'INVALID_BACKUP_JSON'
    throw err
  }
}

// C7 (2026-10-02): the dedup twin compare used a full readFileSync + whole-string equality on
// the main thread — two allocations of the entire snapshot per run. Now: (1) size short-circuit —
// different byte length can never be equal (one statSync, zero content reads); (2) chunked
// positional compare — 1MB readSync windows compared against the same offsets of the payload
// buffer, so memory stays O(chunk) instead of O(file) and an unequal prefix bails on the first
// mismatched chunk. fsMod is injected for tests. Exported for unit tests.
function twinMatches (fsMod, filePath, jsonText) {
  let st
  try { st = fsMod.statSync(filePath) } catch { return false }
  const expected = Buffer.byteLength(jsonText, 'utf8')
  if (st.size !== expected) return false
  const buf = Buffer.from(jsonText, 'utf8')
  const CHUNK = 1024 * 1024
  let fd
  try {
    fd = fsMod.openSync(filePath, 'r')
    const scratch = Buffer.alloc(Math.min(CHUNK, expected))
    for (let off = 0; off < expected; off += CHUNK) {
      const len = Math.min(CHUNK, expected - off)
      if (fsMod.readSync(fd, scratch, 0, len, off) !== len) return false
      if (scratch.compare(buf, off, off + len, 0, len) !== 0) return false // scratch[0..len) vs buf[off..off+len)
    }
    return true
  } catch { return false } finally { try { if (fd != null) fsMod.closeSync(fd) } catch { /* best-effort */ } }
}


module.exports = function backupHandlers (ctx) {
  const { isLocked, app, getMainWindow } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)

  return {
    // --- Backup (critical-state aligned) ---
    'write-critical-state-backup': (e, jsonText) => {
      // 灾备唯一源通道:主窗限定+锁定态拒绝(被攻陷的浮窗/快加窗可覆写 critical JSON 投毒恢复源,三轮安全深审 C-2)
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      if (isLocked()) throw new Error('app is locked')
      // C2 (2026-10-02): clamp the renderer-supplied JSON at the door (see assertIngressSize).
      assertIngressSize(jsonText, 'write-critical-state-backup')
      // D17 P2: garbage (empty / unparsable / non-object) must never replace the freshest
      // disaster-recovery snapshot — coded rejection, same convention as the size gate above.
      assertCriticalJsonPlausible(jsonText)
      // External default root (userData parent dir / pickdone-backups): separated from todos.db, so disaster backup remains recoverable even if userData is wiped
      dbRecovery.writeCriticalStateBackupAtomic(defaultBackupRoot(), String(jsonText))
      return true
    },
    'get-default-backup-dir': () => defaultBackupRoot(),
    // D6 P2 (2026-09-22): main-window + locked-state gates — symmetric with every sibling above.
    // Previously ANY window could pop a native directory dialog and, worse, append an arbitrary
    // path to the on-disk backup-dir whitelist (saveAllowedBackupDirs) — widening where future
    // auto backups (full JSON snapshots) land.
    'pick-backup-dir': async (e) => {
      assertMainWindow(e)
      if (isLocked()) throw new Error('app is locked')
      const { dialog } = require('electron')
      const r = await dialog.showOpenDialog(getMainWindow() || undefined, { title: i18nM.mt('pickBackupDir'), properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      loadAllowedBackupDirs()
      const dir = path.resolve(r.filePaths[0])
      allowedBackupDirs.add(dir) // only user-explicitly-picked directories enter the whitelist
      // ES4 fix (2026-10-02): persist failure must propagate — the old code returned the path
      // unconditionally, so the renderer showed "location updated" while the whitelist file kept
      // its old content and the picked dir silently fell back to the default on the next launch.
      const saved = saveAllowedBackupDirs()
      if (!saved || saved.ok !== true) {
        allowedBackupDirs.delete(dir) // never keep an in-memory registration that is not durable
        throw new Error('failed to persist backup-dir whitelist: ' + ((saved && saved.error) || 'unknown'))
      }
      return r.filePaths[0]
    },
    // --- Auto backup (GFS tiered retention: recent N + daily anchors + weekly anchors; content dedup; atomic write) ---
    'run-auto-backup': (e, jsonText, opts) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      if (isLocked()) throw new Error('app is locked')
      // C2 (2026-10-02): clamp the renderer-supplied JSON at the door (see assertIngressSize) —
      // raised OUTSIDE the try so the coded PAYLOAD_TOO_LARGE rejection reaches the renderer
      // intact instead of degrading to a generic {ok:false,error} string.
      assertIngressSize(jsonText, 'run-auto-backup')
      try {
        const o = typeof opts === 'number' ? { recent: opts } : (opts || {})
        const dir = resolveBackupDir(o.backupDir)
        fs.mkdirSync(dir, { recursive: true })
        const d = new Date()
        const pad = n => String(n).padStart(2, '0')
        const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
        // Lowercase uniformly: keeps evt snapshot naming consistent with autoBackup's case-sensitive RE_EVT (no i flag)
        const tag = o.tag ? ('evt-' + String(o.tag).toLowerCase().replace(/[^a-z0-9-]/g, '') + '-') : 'auto-'
        // F21 (dw wave6 2026-09-24): same-tag same-second snapshots used to silently overwrite each
        // other (evt-<reason> events fire back-to-back; the atomic rename lands on the same name,
        // the earlier snapshot is gone, yet {ok:true} is still returned). See uniqueSnapshotName.
        const name = uniqueSnapshotName(fs.existsSync.bind(fs), dir, tag, stamp, d.getTime())
        // P3 fix (2026-09-25): name-space exhaustion used to hand back an ALREADY-TAKEN name and the
        // atomic write silently clobbered that existing snapshot while still returning {ok:true}.
        if (!name) return { ok: false, error: 'snapshot name space exhausted (900 same-tag names taken)' }
        // Sync-9/Fault-15 (D12 2026-10-01): housekeeping (stale .tmp sweep + GFS prune) now runs
        // BEFORE the dedup early-return and across BOTH tiers. The old order had two leaks: (a) a
        // content-dedup hit returned before the sweep/prune ran, so unchanged data meant the
        // backup dir NEVER aged (GFS anchor rotation starved → unbounded growth); (b) the file
        // list was tag-filtered (o.tag ? /^evt-/ : both), so an evt run never pruned the auto
        // tier. selectPrunes keeps the newest of each tier (recent N + daily/weekly anchors), so
        // pruning the pre-write snapshot list can never drop the dedup twin or the freshest point.
        const existing = fixUtil.sortBackupNamesNewestFirst(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)))
        try {
          const stale = autoBackup.selectStaleTmp(fs.readdirSync(dir).map(f => {
            try { return { name: f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs } } catch { return null }
          }))
          for (const dead of stale) { try { fs.rmSync(path.join(dir, dead), { force: true }) } catch {} }
        } catch { /* sweep is best-effort */ }
        // Both tiers, regardless of this run's tag — the two tiers age on ONE shared directory.
        const pruneList = existing
        for (const dead of autoBackup.selectPrunes(pruneList, o)) { try { fs.unlinkSync(path.join(dir, dead)) } catch {} }
        // Content dedup: only compare against the newest file OF THE SAME TAG (D11 finding 17 —
        // see newestSameTag). (The original implementation compared against any old file — when the data was changed back to its original state
        // it would return dedup without writing the new snapshot, yet prune would delete that old snapshot → that point in time ends up with no backup)
        // 排序按名字内嵌时间戳(2026-09-10 P2):字典序 sort() 让 'auto-' 排在同日 'evt-…' 之后/之前错位,
        // 去重会拿一个陈旧文件当"最新"比对 → 误判 dedup 丢快照。复用 fix-util 的纯排序(与 autoBackup.nameToTs 同规则)。
        const twin = newestSameTag(existing, tag)
        if (twin) {
          // C7 (2026-10-02): size short-circuit + chunked positional compare (see twinMatches) —
          // the old full readFileSync + whole-string equality spooled the entire twin on the
          // main thread for every run.
          try {
            if (twinMatches(fs, path.join(dir, twin), jsonText)) {
              return { ok: true, file: twin, dedup: true }
            }
          } catch {}
        }
        // Atomic write: temp file + rename, prevents corruption on interruption; on failure the temp
        // file is cleaned up inline (P2 2026-09-17) and the structured error is returned
        const w = atomicWriteJson(fs, dir, name, jsonText)
        if (!w.ok) return { ok: false, error: w.error }
        return { ok: true, file: name }
      } catch (err) { return { ok: false, error: String(err && err.message || err) } }
    },
    // 备份读取(2026-09-09 P2):此前三层 catch 全静默——「目录不存在(正常空态)」与「读取失败(权限/IO)」
    // 同样返回 ''/[],设置页永远不知道读不了。改为结构化结果:ok/missing/error,渲染端对应展示错误态
    'read-auto-backup': (e, backupDir, fileName) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      if (isLocked()) throw new Error('app is locked')
      const name = path.basename(String(fileName || ''))
      if (!/^(auto|evt)-.+.json$/.test(name)) return { ok: false, error: 'invalid backup file name' } // whitelisted naming, prevents path traversal
      const dir = resolveBackupDir(backupDir)
      try {
        return { ok: true, text: fs.readFileSync(path.join(dir, name), 'utf8') }
      } catch (err) {
        return fixUtil.classifyBackupError(err) === 'missing'
          ? { ok: false, error: 'backup file not found' }
          : { ok: false, error: String(err && err.message || err) }
      }
    },
    'list-auto-backups': (e, backupDir) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      if (isLocked()) throw new Error('app is locked')
      // D17 P2: a MISSING directory is only a benign empty state when it is the never-configured
      // default root. A user-CONFIGURED external dir that vanished (unplugged drive, deleted
      // folder) used to surface as silent {ok:true, files:[]} — the backup list looked empty and
      // healthy while every snapshot was gone. Distinguish the two states explicitly.
      const configured = backupDir !== undefined && backupDir !== null && String(backupDir) !== ''
      const dir = resolveBackupDir(backupDir)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch (err) {
        // 目录不存在 = 正常空态(用户尚未选过备份目录),不算错误;其余读取失败必须上报
        if (fixUtil.classifyBackupError(err) === 'missing') {
          if (configured) return { ok: false, files: [], missing: true, configured: true, error: 'configured backup directory does not exist: ' + dir }
          return { ok: true, missing: true, files: [] }
        }
        return { ok: false, files: [], error: String(err && err.message || err) }
      }
      // 新→旧展示排序也按内嵌时间戳(字典序会把 evt-/auto- 前缀排在时间之前,同日错位)
      // ^(auto|evt)- 白名单天然排除 .tmp-* 原子写残留(2026-09-11 与 run-auto-backup 的清扫同策略)
      return { ok: true, files: fixUtil.sortBackupNamesNewestFirst(names.filter(f => /^(auto|evt)-/.test(f))) }
    },
    'read-critical-state-backup': (e) => {
      // D6 P1 (2026-09-21): the read twin lacked assertMainWindow while the write twin has it —
      // any auxiliary window (compromised float/quick-add) could exfiltrate the full disaster
      // snapshot. Symmetric main-window gate with write-critical-state-backup.
      assertMainWindow(e)
      if (isLocked()) throw new Error('app is locked')
      // Same source of truth as dbRecovery.cjs: external root first, with fallback to legacy files inside userData
      // D10 (2026-09-27): classify like the sibling read-auto-backup — the blanket catch reported
      // EACCES/EBUSY on an EXISTING critical backup as "no backup exists", hiding a real
      // disaster-recovery asset from the renderer. Only a genuinely missing file returns null.
      try { return fs.readFileSync(dbRecovery.criticalBackupPath(app.getPath('userData')), 'utf8') } catch (err) {
        if (fixUtil.classifyBackupError(err) === 'missing') return null
        err.message = 'critical backup exists but is unreadable: ' + (err && err.message || err)
        throw err
      }
    }
  }
}
module.exports.atomicWriteJson = atomicWriteJson
module.exports.uniqueSnapshotName = uniqueSnapshotName
module.exports.newestSameTag = newestSameTag
module.exports.assertIngressSize = assertIngressSize
module.exports.INGRESS_MAX_BYTES = INGRESS_MAX_BYTES
module.exports.twinMatches = twinMatches
module.exports.criticalJsonPlausible = criticalJsonPlausible // D17: unit-test seam
