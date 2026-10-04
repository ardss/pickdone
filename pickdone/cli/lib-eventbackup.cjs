/* Event snapshot sub-module (D18-DOM2 #9, 2026-10-02): the CLI purge used to run with NO pre-purge
 * snapshot while the App writes evt-purge-*.json before every permanent deletion (renderer/js/store/
 * todo.js purgeIds → dispatch('writeEventBackup', 'purge')). The App's writeEventBackupCore is not
 * CLI-reachable (renderer ESM + window.todoAPI IPC), so this is the minimal CLI-side port over the
 * same db/meta surface the CLI's own backups use: a JSON snapshot of the rows about to be purged
 * (live + recycle + their chip snapshots / estimate meta), written atomically into the SAME backup
 * directory and naming family the main process's run-auto-backup handler uses
 * (evt-<reason>-<YYYYMMDD-HHMMSS>.json, rolling keep of the newest 10 evt-* snapshots).
 * Best-effort by contract: a snapshot failure NEVER blocks the purge, but it must be LOUD
 * (console.error) — mirroring the App's "[todo] purge proceeded WITHOUT its pre-delete event
 * snapshot" honesty rule. */
const fs = require('fs')
const path = require('path')

/** Rolling keep for evt-* snapshots (same eventKeep: 10 policy as writeEventBackupCore) */
const EVT_KEEP = 10

/** D20-DOMB7 (2026-10-02): the write is now the App twin's durable-fs.writeFileDurable
 *  (tmp + fsync(file) + rename + best-effort dir fsync — handlers/backup.js uses the same
 *  helper for its snapshots). The hand-rolled writeFileSync+renameSync ordered nothing: after
 *  a power cut the rename could persist while the snapshot data was still only in the OS cache.
 *  tmp residue on failure is removed inside writeFileDurable. */
function atomicWriteJson (dir, name, text) {
  require('../src/main/durable-fs').writeFileDurable(path.join(dir, name), text)
  return true
}

/** Write the best-effort pre-purge event snapshot. @returns {ok, file?, error?} — never throws. */
function writePurgeEventSnapshot ({ dir, rows, liveRows, metaEntries, reason = 'purge', now = new Date() }) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const pad = n => String(n).padStart(2, '0')
    const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
    // Unique-name guard (F21 parity): a same-second re-run must not silently overwrite the
    // earlier snapshot — suffix the millisecond until the name is free (bounded attempts).
    let name = `evt-${String(reason).toLowerCase().replace(/[^a-z0-9-]/g, '')}-${stamp}.json`
    for (let i = 0; fs.existsSync(path.join(dir, name)) && i < 900; i++) {
      name = `evt-${String(reason).toLowerCase().replace(/[^a-z0-9-]/g, '')}-${stamp}-${now.getTime() + i}.json`
    }
    const dump = {
      backup: {
        reason: String(reason),
        createdAt: now.toISOString(),
        source: 'cli-purge',
        purgedRows: rows || [],
        liveRows: liveRows || [],
        metaEntries: metaEntries || []
      }
    }
    atomicWriteJson(dir, name, JSON.stringify(dump))
    // Rolling keep: prune the oldest evt-* snapshots (same tier policy as the App — the auto-
    // tier is never touched by an evt run). Newest first (mtime), grouped by reason below.
    const evts = fs.readdirSync(dir).filter(f => /^evt-/.test(f) && f.endsWith('.json'))
      .map(f => { try { return { f, m: fs.statSync(path.join(dir, f)).mtimeMs } } catch { return null } })
      .filter(Boolean).sort((a, b) => b.m - a.m)
    // B8-P3 (2026-10-02, App parity autoBackup.selectPrunes): the flat newest-10-total prune used to
    // starve one reason when another fired more often (10 evt-cleanup snapshots evicted every
    // evt-purge snapshot). The App's GFS keeps eventKeep PER REASON (autoBackup.evtGroups); the
    // importable selectPrunes also runs the auto-tier day/week anchors, so the CLI replicates just
    // the per-reason grouping here (source: src/main/autoBackup.js evtGroups block).
    const groups = new Map()
    for (const e of evts) {
      const m = /^evt-([a-z0-9-]+?)-\d{8}-\d{6}(?:-[A-Za-z0-9]+)?\.json$/.exec(e.f) // same shape as autoBackup RE_EVT
      const key = (m && m[1]) || '(unparsed)'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(e)
    }
    for (const [, list] of groups) {
      for (const old of list.slice(EVT_KEEP)) { try { fs.unlinkSync(path.join(dir, old.f)) } catch { /* best-effort */ } }
    }
    return { ok: true, file: name }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

module.exports = { writePurgeEventSnapshot, EVT_KEEP }
