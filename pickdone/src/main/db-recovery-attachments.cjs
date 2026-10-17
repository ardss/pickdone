/**
 * F4 P2 (2026-10-18): attachment-loss visibility across the JSON-restore chain — size-ratchet
 * extraction from dbRecovery.cjs (pure Node, no electron). Todo rows reference attachments as
 * local:// keys into userData/files; a JSON restore re-points rows at files the disk may not
 * hold (fresh machine, wiped userData, migration). Every snapshot now carries a SIDECAR
 * manifest `<snapshot>.attachments.json` (handlers/backup.js writeAttachmentSidecar; the
 * critical backup's sidecar sits beside critical-state-backup.json). For backups without a
 * sidecar the keys are derived from the todoState rows' image/files lists. The report NEVER
 * blocks the JSON restore (main data wins) — it only surfaces + logs the gaps (never touches
 * the restore-proof `proved` gate: attachments are a separate data surface).
 */
module.exports = function createAttachmentLoss ({ parseSegment, logWarn, criticalBackupPath }) {
  const fs = require('fs')
  const path = require('path')

  /** Sidecar manifest path for a backup JSON path (pure). Naming contract: 'att-manifest-<base>'
   *  in the SAME directory (handlers/backup.js attachmentSidecarNameFor) — deliberately OUTSIDE
   *  the ^(auto|evt)- restore namespace. */
  function attachmentManifestPathFor (backupFile) {
    const f = String(backupFile || '')
    return path.join(path.dirname(f), 'att-manifest-' + path.basename(f))
  }

  /** Read the backup's sidecar manifest if one exists (null otherwise). */
  function readAttachmentManifestSidecar (backupFile, fsMod = fs) {
    try { return JSON.parse(fsMod.readFileSync(attachmentManifestPathFor(backupFile), 'utf8')) } catch { return null }
  }

  /** Pure (no IO): collect every local:// attachment key referenced by the backup's todoState
   *  rows (todoList + recycleList, image/files JSON arrays). Self-contained local:// parsing so
   *  this pure-Node module never requires the Electron-dependent attachments.js. */
  function localAttachmentKeysFromTodoRows (raw) {
    const keys = []
    try {
      const seg = parseSegment(raw && raw.backup && raw.backup.todoState, 'todoState')
      if (seg === null) return keys
      const rows = ((seg && seg.todoList) || []).concat((seg && seg.recycleList) || [])
      for (const row of rows) {
        for (const field of ['image', 'files']) {
          let list
          try { list = JSON.parse((row && row[field]) || '[]'); if (!Array.isArray(list)) continue } catch { continue }
          for (const item of list) {
            const url = item && item.url
            if (typeof url !== 'string' || !url.startsWith('local://')) continue
            let k = url.slice(8)
            try { k = decodeURIComponent(k) } catch { /* malformed encoding: raw key (matches attachmentPath) */ }
            k = path.basename(k)
            if (k && !keys.includes(k)) keys.push(k)
          }
        }
      }
    } catch { /* best-effort visibility only */ }
    return keys
  }

  /** Pure over an injected fsMod: which attachment keys does the files dir NOT hold?
   *  Manifest entries win when present (the dump's own inventory); todo-row derivation is the
   *  fallback for older backups. Returns null when no files dir was provided (report skipped). */
  function missingAttachmentsAfterRestore (raw, filesDir, fsMod = fs) {
    if (!filesDir || typeof filesDir !== 'string') return null
    try {
      const manifest = raw && raw.backup && raw.backup.attachments
      const entries = manifest && Array.isArray(manifest.entries) ? manifest.entries : null
      const keys = entries
        ? entries.map(e => path.basename(String((e && e.key) || ''))).filter(Boolean)
        : localAttachmentKeysFromTodoRows(raw)
      const missing = keys.filter(k => { try { return !fsMod.existsSync(path.join(filesDir, k)) } catch { return true } })
      return { checked: keys.length, missing }
    } catch { return null }
  }

  /** Restore-chain entry: prefer the sidecar manifest (the dump's own inventory over the exact
   *  snapshot being restored), fall back to todo-row derivation; mutate `result` with
   *  missingAttachments and log — NEVER throws, NEVER blocks. */
  function reportMissingAfterRestore (result, raw, ud, filesDir) {
    try {
      let manifestRaw = raw
      const side = readAttachmentManifestSidecar(criticalBackupPath(ud))
      if (side) manifestRaw = { backup: { ...(raw && raw.backup), attachments: side } }
      const missing = missingAttachmentsAfterRestore(manifestRaw, filesDir)
      if (missing && missing.missing.length && result) {
        result.missingAttachments = missing.missing
        const head = missing.missing.slice(0, 5).join(', ')
        logWarn(`[dbRecovery] restore: ${missing.missing.length}/${missing.checked} attachment file(s) referenced by restored rows are missing on disk (${head}${missing.missing.length > 5 ? ', …' : ''})`)
      }
    } catch { /* visibility is best-effort; the JSON restore itself is untouched */ }
  }

  return { attachmentManifestPathFor, readAttachmentManifestSidecar, localAttachmentKeysFromTodoRows, missingAttachmentsAfterRestore, reportMissingAfterRestore }
}
