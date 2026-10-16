/**
 * Corrupt-scene retention — extracted from dbRecovery.cjs (F1 2026-10-17 size-cap trim; pure fs,
 * no domain deps). Keeps the most recent N sets of .corrupt-<stamp> forensic files, grouped by
 * stamp; older sets are deleted.
 */
const fs = require('fs')
const path = require('path')

/** 只保留最近 3 套 .corrupt-<stamp> 现场文件,按 stamp 分组,更早的删除 */
function pruneCorruptScenes (ud, keep = 3) {
  try {
    const byStamp = new Map()
    for (const f of fs.readdirSync(ud)) {
      const i = f.indexOf('.corrupt-')
      if (i < 0) continue
      const stamp = f.slice(i + '.corrupt-'.length)
      if (!byStamp.has(stamp)) byStamp.set(stamp, [])
      byStamp.get(stamp).push(f)
    }
    const stamps = [...byStamp.keys()].sort()
    for (const s of stamps.slice(0, Math.max(0, stamps.length - keep))) {
      for (const f of byStamp.get(s)) { try { fs.rmSync(path.join(ud, f), { force: true }) } catch {} }
    }
  } catch { /* 清理失败不阻断恢复 */ }
}

module.exports = { pruneCorruptScenes }
