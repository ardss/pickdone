'use strict'
/**
 * Audit-archive single source (F-B6/F-B8, dw wave 3): the App (src/main/audit.js) already rotated
 * cli-audit.jsonl to timestamped archives with pruning; the CLI (cli/audit.js) still used the
 * destructive fixed '.1' rename — since BOTH ends rotate the SAME file from different processes
 * (parallel CLI sessions, SOP-08), the CLI's unlinkSync('.1') could delete the archive the App
 * (or a sibling CLI) had JUST renamed into place. Both ends now call the same rotateArchive /
 * pruneArchives; timestamped targets make concurrent renames non-destructive.
 *
 * Also carries the shared snapshot vocabulary (SNAPSHOT_FIELDS + snapshot()) that both ends kept
 * as a verbatim twin, with the F-B8 privacy cap: content-bearing fields (taskContent/taskDescribe/
 * subtasks) are truncated to CONTENT_CAP chars before hitting disk — the 5MB×4 archive set must
 * not be a 25MB plaintext history of task contents.
 */
const fs = require('fs')
const path = require('path')

const ARCHIVES_TO_KEEP = 4

/** Keep at most the `keep` newest timestamped archives of `file`; delete the rest (best-effort). */
function pruneArchives (file, keep = ARCHIVES_TO_KEEP) {
  const prefix = path.basename(file) + '.'
  const archives = fs.readdirSync(path.dirname(file))
    .filter(n => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
  for (const name of archives.slice(0, Math.max(0, archives.length - keep))) {
    try { fs.unlinkSync(path.join(path.dirname(file), name)) } catch { /* best-effort */ }
  }
}

/** Rotate `file` to a timestamped archive name (cli-audit.jsonl.<ms>), then prune old archives.
 *  2026-09-10 P2: the old fixed `.1` target let the two writers (App + CLI rotate the SAME JSONL
 *  from different processes) destroy each other's data — A's unlinkSync('.1') could delete the 5MB
 *  file B had JUST renamed into '.1'. Timestamped targets make both renames non-destructive (a
 *  same-millisecond collision bumps the stamp instead of overwriting), and pruning keeps the
 *  archive set bounded. */
/** Retry/backoff knobs (2026-09-25 rotation-robustness fix): Windows EPERM — the other dual writer
 *  (App or CLI process) holding the file open mid-append — used to make renameSync throw ONCE and the
 *  empty catch in the caller swallowed it, so e.g. .dev-data/cli-audit.jsonl grew to 51MB+ with rotation
 *  silently dead. Now: limited retry with backoff, then a non-destructive fallback (rename the oversized
 *  file to a `.corrupt-<ts>` sibling so a NEW trail starts), and never silent — `warn` fires on fallback
 *  and on final failure (truncate-to-empty as the last resort to respect the size threshold). */
const ROTATE_RETRIES = 3
const ROTATE_BACKOFF_MS = 50
// Adversarial-review fix: `.corrupt-<ts>` fallback siblings are not matched by pruneArchives' /^\d+$/
// filter, so a long-lived EPERM environment could accumulate unbounded oversized copies. On every
// SUCCESSFUL normal rotation, best-effort delete corrupt siblings older than a bounded window.
const CORRUPT_KEEP_MS = 7 * 86400000

function pruneCorruptSiblings (file, now = Date.now()) {
  const prefix = path.basename(file) + '.corrupt-'
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.startsWith(prefix)) continue
      const full = path.join(path.dirname(file), name)
      try { if (now - fs.statSync(full).mtimeMs > CORRUPT_KEEP_MS) fs.unlinkSync(full) } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

function sleepSync (ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* degraded host: skip backoff */ }
}

function rotateArchive (file, warn = console.warn) {
  const notify = typeof warn === 'function' ? warn : () => {}
  for (let attempt = 0; attempt < ROTATE_RETRIES; attempt++) {
    if (attempt > 0) sleepSync(ROTATE_BACKOFF_MS * attempt) // backoff: give the other writer's handle a beat to close
    let stamp = Date.now() + attempt
    let rolled = file + '.' + stamp
    while (fs.existsSync(rolled)) rolled = file + '.' + (++stamp)
    try {
      fs.renameSync(file, rolled)
      pruneArchives(file)
      pruneCorruptSiblings(file)
      return rolled
    } catch (e) {
      if (attempt < ROTATE_RETRIES - 1) continue
      // All retries exhausted. Fallback 1: a non-numeric, always-unique target name often succeeds where
      // the `<ms>` name raced a same-ms sibling; `.corrupt-` marks it as not a regular archive.
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const corrupt = file + '.corrupt-' + ts
      try {
        fs.renameSync(file, corrupt)
        notify('[audit-rotate] rename failed after ' + ROTATE_RETRIES + ' attempts (' + e.message + '); oversized trail moved to ' + path.basename(corrupt))
        return corrupt
      } catch (e2) {
        // Fallback 2 (last resort): truncate in place so the main file respects the threshold again.
        try { fs.truncateSync(file, 0); notify('[audit-rotate] rotation failed (' + e.message + '); trail truncated in place — archives NOT rotated') } catch (e3) {
          notify('[audit-rotate] rotation AND truncate failed (' + e3.message + '); oversized trail keeps growing')
        }
      }
    }
  }
}

/* ================= shared snapshot vocabulary ================= */

// Semantic snapshot fields kept in changes (enough to answer "what did the write change"; large
// fields like image/attachments excluded so lines stay small). Identical on both ends.
const SNAPSHOT_FIELDS = [
  'taskContent', 'taskDescribe', 'complete', 'completedAt', 'todoTime', 'reminderTime',
  'reminderOffsets', 'reminderExtra', 'dayStart', 'deletedAt', 'priority', 'deadlineTs', 'important', 'urgent',
  'categoryId', 'repeatId', 'subtasks', 'delete', 'status', 'updateTime'
]

// F-B8 privacy cap: content-bearing fields are truncated before the audit line lands on disk.
// BEHAVIOR CHANGE (deliberate, minimal-necessary): audit snapshots keep task identity + timing +
// semantics, but no longer carry unlimited plaintext content. taskId always survives in
// targets/changes, so content remains reconstructible from the DB, not from the audit trail.
const CONTENT_FIELDS = new Set(['taskContent', 'taskDescribe', 'subtasks'])
const CONTENT_CAP = 50

function capContent (v) {
  const s = String(v)
  return s.length > CONTENT_CAP ? s.slice(0, CONTENT_CAP) + '…(' + s.length + ' chars)' : s
}

function snapshot (t) {
  if (!t) return null
  const o = {}
  for (const k of SNAPSHOT_FIELDS) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') {
      o[k] = CONTENT_FIELDS.has(k) ? capContent(t[k]) : t[k]
    }
  }
  return Object.keys(o).length ? o : null
}

module.exports = { rotateArchive, pruneArchives, SNAPSHOT_FIELDS, snapshot, capContent, CONTENT_CAP, ARCHIVES_TO_KEEP }
