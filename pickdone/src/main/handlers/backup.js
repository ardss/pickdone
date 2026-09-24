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
 *  returned). Collision is resolved by bumping the embedded stamp +1s per taken name instead of a
 *  "-1" suffix: the GFS sort/prune parsers (fix-util.backupNameTs / autoBackup.nameToTs) only
 *  recognize the strict auto-YYYYMMDD-HHMMSS.json / evt-<reason>-... shape — a suffixed name
 *  parses as ts=0, sorts oldest and gets pruned first, which would defeat the fix itself. */
function uniqueSnapshotName (existsSync, dir, tag, stamp, baseMs) {
  const pad = n => String(n).padStart(2, '0')
  const fmt = x => { const d = new Date(x); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) }
  let name = tag + stamp + '.json'
  for (let bump = 1; bump <= 900 && existsSync(path.join(dir, name)); bump++) {
    name = tag + fmt(baseMs + bump * 1000) + '.json' // 900 bumped names deep: give up deterministically rather than loop forever
  }
  return name
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
      allowedBackupDirs.add(path.resolve(r.filePaths[0])) // only user-explicitly-picked directories enter the whitelist
      saveAllowedBackupDirs()
      return r.filePaths[0]
    },
    // --- Auto backup (GFS tiered retention: recent N + daily anchors + weekly anchors; content dedup; atomic write) ---
    'run-auto-backup': (e, jsonText, opts) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      if (isLocked()) throw new Error('app is locked')
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
        // Content dedup: only compare against the newest file. (The original implementation compared against any old file — when the data was changed back to its original state
        // it would return dedup without writing the new snapshot, yet prune would delete that old snapshot → that point in time ends up with no backup)
        // 排序按名字内嵌时间戳(2026-09-10 P2):字典序 sort() 让 'auto-' 排在同日 'evt-…' 之后/之前错位,
        // 去重会拿一个陈旧文件当"最新"比对 → 误判 dedup 丢快照。复用 fix-util 的纯排序(与 autoBackup.nameToTs 同规则)。
        const existing = fixUtil.sortBackupNamesNewestFirst(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)))
        if (existing.length) {
          try {
            // newest-first sort → the dedup twin is existing[0]; the tail was the OLDEST file (review P1 2026-09-10:
            // dedup never fired in the common case, and a stale snapshot could be returned as "the" backup)
            if (fs.readFileSync(path.join(dir, existing[0]), 'utf8') === jsonText) {
              return { ok: true, file: existing[0], dedup: true }
            }
          } catch {}
        }
        // Atomic write: temp file + rename, prevents corruption on interruption; on failure the temp
        // file is cleaned up inline (P2 2026-09-17) and the structured error is returned
        const w = atomicWriteJson(fs, dir, name, jsonText)
        if (!w.ok) return { ok: false, error: w.error }
        // P2 2026-09-11: sweep interrupted .tmp-* residue — a crash between writeFileSync and renameSync
        // used to accumulate temp files in the backup dir forever (the prune filter below only matches
        // ^(auto|evt)-). Only files older than 1h are swept, so a concurrent in-flight write is safe.
        try {
          const stale = autoBackup.selectStaleTmp(fs.readdirSync(dir).map(f => {
            try { return { name: f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs } } catch { return null }
          }))
          for (const dead of stale) { try { fs.rmSync(path.join(dir, dead), { force: true }) } catch {} }
        } catch { /* sweep is best-effort */ }
        const files = fs.readdirSync(dir).filter(f => (o.tag ? /^evt-/.test(f) : /^(auto|evt)-/.test(f)))
        for (const dead of autoBackup.selectPrunes(files, o)) { try { fs.unlinkSync(path.join(dir, dead)) } catch {} }
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
      const dir = resolveBackupDir(backupDir)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch (err) {
        // 目录不存在 = 正常空态(用户尚未选过备份目录),不算错误;其余读取失败必须上报
        if (fixUtil.classifyBackupError(err) === 'missing') return { ok: true, missing: true, files: [] }
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
      try { return fs.readFileSync(dbRecovery.criticalBackupPath(app.getPath('userData')), 'utf8') } catch { return null }
    }
  }
}
module.exports.atomicWriteJson = atomicWriteJson
module.exports.uniqueSnapshotName = uniqueSnapshotName
