/** W29 (2026-11-01) — legacy `local://<host>` attachment-url migration.
 *
 * History: before W16 (2026-10-28) saveAttachment minted HOST-form urls
 * (`local://<encoded-key>`, key in the URL's HOST component). Chromium lowercases AND
 * IDNA/punycode-transcodes the host of every standard-scheme url, so a Chinese or
 * uppercase filename arrived at the local:// handler punycode'd/lowercased and 404'd
 * FOREVER — the user-reported "粘贴的图片显示裂图" incident (three separate reports,
 * every one triggered by a non-ASCII filename). New rows are safe (W16 mints PATH form,
 * `local:///<encoded-key>`), but legacy ROWS still hold the poisoned host form and still
 * 404 on every render.
 *
 * This module is the startup migration: scan todo rows' image/files attachment lists for
 * legacy host-form urls, try to recover the ORIGINAL on-disk filename (punycode decode +
 * percent-decode + case-insensitive directory reverse-lookup, the same uniqueness doctrine
 * as attachments.resolveAttachmentCase W17), and rewrite the row to path form. When the
 * file cannot be recovered the entry gets an explicit `missing: true` marker so the
 * renderer shows an "附件缺失" placeholder instead of a silently broken image.
 *
 * Contracts:
 *  - idempotent: path-form urls and already-missing-marked entries are skipped, so a
 *    second boot rewrites nothing (the meta counter is only written when work happened);
 *  - fail-open: every row is migrated in its own try/catch — one unreadable/poisoned row
 *    can never block boot (db-migrations v10 also wraps the whole call);
 *  - audited: the rewrite counts land in the meta table (`attMigrate.legacyHostForm`)
 *    and in the electron-log trail;
 *  - quiet repair: rows are updated with a raw column UPDATE (no status/updatedAt bump,
 *    no oplog/revision entry) — a url-FORM repair is device-local and must not churn the
 *    sync ledger; every device runs the same migration over its own rows.
 */

const fs = require('fs')
const path = require('path')

/** Legacy host-form detector: `local://<key>` with the key in the HOST component (no
 *  third slash). The W16+ path form (`local:///...`) is never legacy. Non-local urls → false. */
function isLegacyHostFormUrl (url) {
  return typeof url === 'string' && url.startsWith('local://') && !url.startsWith('local:///')
}

/** Best-effort recovery of the ORIGINAL filename behind a Chromium-mangled host key.
 *  Chromium lowercases the host and punycode-transcodes non-ASCII labels, so candidates
 *  are tried in order: percent-decode (malformed encoding → raw key, mirroring
 *  attachmentPath's fallback), then punycode→Unicode per dot-label. Returns the decoded
 *  candidate or null. Pure. */
function decodeLegacyHostKey (encodedKey) {
  let raw = String(encodedKey || '')
  if (!raw) return null
  try { raw = decodeURIComponent(raw) } catch { /* malformed encoding: keep raw */ }
  if (raw.toLowerCase() !== raw) return raw // survived decode with original case: not host-mangled
  // Lowercase (or already-punycode): try punycode recovery per label. No xn-- label and
  // nothing to gain? Return the raw string — the caller's case-insensitive scan still
  // reverse-resolves simple lowercased names like 'screenshot.png'.
  if (!/xn--/i.test(raw)) return raw
  try {
    const punycode = require('node:punycode')
    const labels = raw.split('.')
    const restored = labels.map(l => (/^xn--/i.test(l) ? punycode.toUnicode(l) : l)).join('.')
    return restored || raw
  } catch { return raw }
}

/** Reverse-resolve a decoded candidate against the REAL on-disk names (the directory
 *  listing is the only surviving record of the original case). Unique case-insensitive
 *  match → the real name; zero or several twins → null (the W17 "refusing to guess"
 *  doctrine — an ambiguous rewrite could bind the row to the WRONG twin's bytes). Pure. */
function resolveAgainstDisk (decodedName, diskNames) {
  const want = String(decodedName || '').toLowerCase()
  if (!want) return null
  let hit = null
  let hits = 0
  for (const f of (diskNames || [])) {
    if (String(f).toLowerCase() === want) { hit = f; hits++ }
  }
  return hits === 1 ? hit : null
}

/** Rewrite ONE row's image/files attachment lists. Returns
 *  { image, files, rewritten, missing, changed } — rewritten = host-form urls resolved to
 *  path form; missing = entries marked `missing: true` (unrecoverable file); changed =
 *  whether either list differs and the row must be persisted. Never throws on per-item
 *  poison: an unparsable JSON list is left verbatim. */
function migrateRowAttachments (row, { diskNames } = {}) {
  const out = { image: row && row.image, files: row && row.files, rewritten: 0, missing: 0, changed: false }
  for (const field of ['image', 'files']) {
    let list
    try { list = JSON.parse(row[field] || '[]'); if (!Array.isArray(list)) continue } catch { continue }
    let touched = false
    const next = list.map(item => {
      if (!item || typeof item !== 'object') return item
      const url = item.url
      if (!isLegacyHostFormUrl(url)) return item
      if (item.missing === true) return item // already marked on a previous pass: idempotent no-op
      const decoded = decodeLegacyHostKey(url.slice('local://'.length))
      const resolved = resolveAgainstDisk(decoded, diskNames)
      touched = true
      if (resolved) {
        out.rewritten++
        return { ...item, url: 'local:///' + encodeURIComponent(resolved), key: resolved }
      }
      out.missing++
      return { ...item, missing: true }
    })
    if (touched) {
      out[field] = JSON.stringify(next)
      out.changed = true
    }
  }
  return out
}

/** Boot entry (called from db-migrations v10): migrate every todo row on the live handle.
 *  Returns { scanned, rewritten, missing, changedRows, error: null } and NEVER throws —
 *  a failure here must not block startup (fail-open: legacy rows keep resolving through
 *  the W16-tolerant serve boundary until the next boot retries). */
function migrateLegacyAttachmentUrlsOnBoot (d, deps = {}) {
  const result = { scanned: 0, rewritten: 0, missing: 0, changedRows: 0, error: null }
  try {
    const log = deps.log || (() => { try { return require('electron-log') } catch { return { info: console.error, warn: console.error } } })()
    // Real directory listing = the case/punycode reverse-lookup oracle. attachDir() needs
    // electron's app; require lazily so pure unit tests can inject listDiskNames instead.
    const diskNames = deps.listDiskNames
      ? deps.listDiskNames()
      : fs.readdirSync(require('./attachments').attachDir())
    const rows = d.prepare('SELECT id, image, files FROM todos').all()
    const upd = d.prepare('UPDATE todos SET image = ?, files = ? WHERE id = ?')
    for (const row of rows) {
      result.scanned++
      try {
        const r = migrateRowAttachments(row, { diskNames })
        result.rewritten += r.rewritten
        result.missing += r.missing
        if (r.changed) { upd.run(r.image, r.files, row.id); result.changedRows++ }
      } catch (e) {
        // per-row fail-open: a poisoned row is logged and skipped, boot continues
        log.warn('[attachment-migrate] row ' + row.id + ' skipped: ' + (e && e.message))
      }
    }
    // Audit trail: counts in meta (only when something actually happened — idempotent
    // boots leave the previous stamp untouched) + a log line.
    if (result.changedRows || result.missing) {
      try {
        d.prepare("INSERT INTO meta (key, value) VALUES ('attMigrate.legacyHostForm', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(JSON.stringify({ at: Date.now(), ...result, error: undefined }))
      } catch { /* meta stamp is best-effort — no meta table in some fixtures */ }
    }
    log.info('[attachment-migrate] legacy local:// host-form scan: rows=' + result.scanned +
      ' rewritten=' + result.rewritten + ' missing=' + result.missing + ' changedRows=' + result.changedRows)
    // [w30 P0 supplement] orphan reconciliation rides the same boot pass (its own fail-open
    // try/catch — an audit failure must never fail the migration or the boot): files that sit
    // in userData/files but are referenced by NO todo row and are not bookkeeping/alias-reserved
    // are counted (and swept ONLY when TODO_CLI_ATTACH_ORPHAN_SWEEP=1) so ghosts cannot eat the
    // 64MB quota silently.
    try { result.orphanAudit = reconcileOrphanAttachmentsOnBoot(d, deps) } catch (e) {
      try { log.warn('[attachment-orphan] audit skipped (non-blocking): ' + (e && e.message)) } catch { /* logging is best-effort */ }
    }
  } catch (e) {
    result.error = (e && e.message) || String(e)
    try { require('electron-log').warn('[attachment-migrate] boot migration failed (non-blocking): ' + result.error) } catch { console.error('[attachment-migrate] boot migration failed (non-blocking): ' + result.error) }
  }
  return result
}

module.exports = { isLegacyHostFormUrl, decodeLegacyHostKey, resolveAgainstDisk, migrateRowAttachments, migrateLegacyAttachmentUrlsOnBoot, findOrphanAttachments, reconcileOrphanAttachmentsOnBoot }

/* ---- [w30 P0 supplement] orphan attachment reconciliation ----
 * userData/files accumulates "ghosts": bytes that landed on disk (upload acked, conflict
 * rename residue, a row whose JSON update never persisted) but that NO todo row references
 * anymore. They are invisible to every UI yet count against the attachment quota. This audit
 * lists them at boot — the default action is AUDIT ONLY (a warn log with counts); deletion
 * happens exclusively when TODO_CLI_ATTACH_ORPHAN_SWEEP=1 is set, because a full-row scan miss
 * can still be wrong in edge shapes the reference counters do not model (e.g. a row mid-flush
 * in the renderer's safeUpsert retry queue). */
/** Pure core: given the on-disk names, the DB rows, and the alias map, return the orphan
 *  names — bookkeeping files (aliases.json / atomic-write temp residue) and alias-map
 *  entries (both directions: the renamed on-disk key AND the original key it stands for)
 *  are never orphans; everything else needs at least one image/files reference via
 *  attachments.findKeyRefs (the same resolution rules the unlink guards use). */
function findOrphanAttachments ({ diskNames, rows, aliases } = {}) {
  const { isLocalBookkeepingFile } = require('./protocol')
  const { findKeyRefs } = require('./attachments')
  const reserved = new Set()
  if (aliases && typeof aliases === 'object') {
    for (const [k, v] of Object.entries(aliases)) { reserved.add(String(k)); reserved.add(String(v)) }
  }
  const orphans = []
  for (const name of (diskNames || [])) {
    const n = String(name)
    if (isLocalBookkeepingFile(n)) continue
    if (reserved.has(n)) continue
    if (findKeyRefs(n, rows).length === 0) orphans.push(n)
  }
  return orphans
}

/** Boot entry (piggybacks migrateLegacyAttachmentUrlsOnBoot): audit-only by default.
 *  deps (all optional, unit-test seams): listDiskNames() / attachDirPath / rows /
 *  listAliases() / log / sweepEnv ('1' forces the sweep; undefined reads the real env).
 *  Returns { scanned, orphanCount, deleted, orphans, error } and NEVER throws. */
function reconcileOrphanAttachmentsOnBoot (d, deps = {}) {
  const result = { scanned: 0, orphanCount: 0, deleted: 0, orphans: [], error: null }
  try {
    const log = deps.log || (() => { try { return require('electron-log') } catch { return { info: console.error, warn: console.error } } })()
    const dir = deps.attachDirPath || require('./attachments').attachDir()
    const diskNames = deps.listDiskNames ? deps.listDiskNames() : fs.readdirSync(dir)
    result.scanned = diskNames.length
    const rows = deps.rows || d.prepare('SELECT id, image, files FROM todos').all()
    const aliases = deps.listAliases ? deps.listAliases() : require('./attachments').readAliases()
    result.orphans = findOrphanAttachments({ diskNames, rows, aliases })
    result.orphanCount = result.orphans.length
    // Audit stamp in meta (best-effort, same doctrine as the migration stamp). The names
    // themselves are user content — only counts go to storage/logs.
    try {
      d.prepare("INSERT INTO meta (key, value) VALUES ('attOrphan.audit', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(JSON.stringify({ at: Date.now(), files: result.scanned, orphans: result.orphanCount, deleted: result.deleted }))
    } catch { /* meta table absent in some fixtures */ }
    // Deletion is opt-in via env ONLY. Default: audit and keep — the full-row scan cannot see
    // a row still sitting in the renderer's pending-upsert queue, so "zero references" is not
    // proof of ghosthood within one process lifetime.
    const sweep = deps.sweepEnv !== undefined
      ? (deps.sweepEnv === '1' || deps.sweepEnv === true)
      : process.env.TODO_CLI_ATTACH_ORPHAN_SWEEP === '1'
    if (sweep && result.orphans.length) {
      for (const name of result.orphans) {
        try { fs.unlinkSync(path.join(dir, name)); result.deleted++ } catch (e) {
          log.warn('[attachment-orphan] sweep unlink failed for one file (kept): ' + (e && e.message))
        }
      }
    }
    log.warn('[attachment-orphan] audit: files=' + result.scanned + ' orphans=' + result.orphanCount +
      ' deleted=' + result.deleted + ' sweep=' + (sweep ? 'on' : 'off'))
  } catch (e) {
    result.error = (e && e.message) || String(e)
    try { require('electron-log').warn('[attachment-orphan] audit failed (non-blocking): ' + result.error) } catch { console.error('[attachment-orphan] audit failed (non-blocking): ' + result.error) }
  }
  return result
}
