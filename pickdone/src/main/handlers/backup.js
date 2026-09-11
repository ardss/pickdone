/** Backup/critical-state domain IPC handlers (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const i18nM = require('../i18n')
const dbRecovery = require('../dbRecovery.cjs')
const autoBackup = require('../autoBackup')
const fixUtil = require('../fix-util')
const { resolveBackupDir, defaultBackupRoot, saveAllowedBackupDirs, allowedBackupDirs, loadAllowedBackupDirs } = require('../backup-dirs')
const { makeAssertMainWindow } = require('./shared')

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
    'pick-backup-dir': async () => {
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
        const name = tag + stamp + '.json'
        const tmp = path.join(dir, '.tmp-' + name)
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
        // Atomic write: temp file + rename, prevents corruption on interruption
        fs.writeFileSync(tmp, jsonText)
        fs.renameSync(tmp, path.join(dir, name))
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
    'read-critical-state-backup': () => {
      if (isLocked()) throw new Error('app is locked')
      // Same source of truth as dbRecovery.cjs: external root first, with fallback to legacy files inside userData
      try { return fs.readFileSync(dbRecovery.criticalBackupPath(app.getPath('userData')), 'utf8') } catch { return null }
    }
  }
}
