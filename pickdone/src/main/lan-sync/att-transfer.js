'use strict'

/**
 * Attachment FILE transfer over LAN sync (feature: peers previously received only the
 * attachment metadata rows — todo.image/todo.files reference `local://<key>` files that
 * lived only on the uploading device).
 *
 * Pull-based, over the EXISTING authenticated + AES-GCM-framed sync session:
 *   receiver -> sender: att-req    {ids:[key,...]}            (bounded batch)
 *   sender -> receiver: att-meta   {id, size, hash}           (sha256, per file)
 *                       att-chunk  {id, index, data, final}   (base64, ~1MB frames)
 *                       att-missing{id, reason?}              (peer lacks it / too large)
 *                       att-end    {sent, missing}            (terminal for the batch)
 *
 * Guards: single-file ceiling (reject >50MB with a log), per-round batch caps
 * (20 files / 64MB), per-peer request-rate cap per session, and a per-session failed-set
 * so a file neither peer has cannot retry-loop (a LATER session may retry).
 *
 * Pure Node (fs/crypto injectable for tests); CommonJS; no Electron imports.
 */

const ENTRY_CHUNK_BYTES = 1024 * 1024
const path = require('node:path')
const { createHash } = require('node:crypto')
// C8 (2026-10-09): log-isolation at MODULE LOAD — the old inline require ran AFTER the warn it
// accompanied, so under TODO_DB_DIR/TODO_USER_DATA_DIR the first warn leaked into the REAL user
// log (same pattern as transport.js/lan-sync siblings).
require('../log-isolation')

// Domain-1 F-A2 (2026-09-23): extension whitelist on RECEIVED files. The upload door
// (attachments.js saveAttachment) enforces ALLOWED_EXT, but the LAN pull used to land ANY
// hash-verified file — a peer holding the pairing secret could write script-capable files
// (e.g. .svg / .html) into userData/files, bypassing the D6 "svg out of the whitelist" root
// fix (open-file hands them to shell.openPath → OS browser executes outside the app CSP).
// Reuses the SAME Set instance as the upload door (single whitelist, two doors).
function extAllowed (key) {
  let allowed = null
  try { allowed = require('../attachments').ALLOWED_EXT } catch { allowed = null }
  if (!allowed) return false // whitelist unavailable: fail closed
  // Same trailing-dot/space strip as saveAttachment: the filesystem drops them at creation,
  // so validation and persistence must see the same extension ('x.png.' must not pass as 'x.')
  const base = path.basename(String(key)).replace(/[. ]+$/, '')
  const ext = path.extname(base).slice(1).toLowerCase()
  return !!ext && allowed.has(ext)
}
// C14-cross (2026-09-25 adversarial-review follow-up): `noise-custom.*` is the LOCAL
// white-noise pick slot and is EXEMPT from the attachment quota since C14 (attachments.js
// isUnownedNoiseFile). The LAN ingress must never land such files: a malicious (or buggy)
// peer could otherwise park a quota-exempt file under every whitelisted extension
// (noise-custom.png, noise-custom.pdf, …) that no white-noise write ever overwrites (the
// pick only ever writes noise-custom.<mp3|wav|ogg>) — a persistent quota escape.
function reservedNoiseSlot (key) {
  const base = path.basename(String(key))
  try { return require('../attachments').isUnownedNoiseFile(base) } catch { return /^noise-custom\./.test(base) }
}
// Single-file ceiling (mirrors the upload handler's 50MB limit): the sender refuses to
// serve anything larger and the receiver refuses to accept anything larger.
const MAX_FILE_BYTES = 50 * 1024 * 1024
// Per-round batch caps (both sides): one round pulls at most 20 files / 64MB. Byte budgets
// are enforced on ACTUAL file sizes (att-meta), not worst-case guesses — the receiver skips
// any file that would overflow the budget and the sender answers it with att-missing.
const MAX_FILES_PER_ROUND = 20
const MAX_BYTES_PER_ROUND = 64 * 1024 * 1024
// Per-session per-peer request cap (rate guard): a pathological library cannot spam a
// peer with unbounded att-req batches; later sessions reset the budget.
const MAX_REQUESTS_PER_SESSION = 200
// P2-e (2026-09-19 data-safety round): failed-set entries expire after 24h — a file that failed
// once (peer offline, transient write error) becomes pullable again the next day instead of
// being blocked for the whole app-session lifetime.
const FAILED_TTL_MS = 24 * 60 * 60 * 1000

/* ---------- pure helpers (unit-tested) ---------- */

/** Extract deduped `local://` attachment keys from one todo row's image/files JSON fields. */
function extractLocalKeys (row) {
  const out = []
  if (!row || typeof row !== 'object') return out
  for (const field of ['image', 'files']) {
    const raw = row[field]
    if (typeof raw !== 'string' || !raw) continue
    let list = null
    try { list = JSON.parse(raw) } catch { continue }
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const url = item && item.url
      if (typeof url === 'string' && url.startsWith('local://')) {
        let key = url.slice(8)
        try { key = decodeURIComponent(key) } catch { /* malformed encoding: use raw */ }
        if (key) out.push(key)
      }
    }
  }
  return out
}

/** All attachment keys referenced by `rows` that are MISSING on this device (deduped). */
function collectMissingKeys (rows, existsFn) {
  const seen = new Set()
  const out = []
  for (const row of rows || []) {
    for (const key of extractLocalKeys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      try { if (!existsFn(key)) out.push(key) } catch { /* stat failure counts as present: skip */ }
    }
  }
  return out
}

function sha256Hex (buf, hashFn) {
  if (hashFn) return hashFn(buf)
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(buf).digest('hex')
}

// D14 C7 (2026-10-02): chunked positional sha256 of an on-disk file — the receive-side dedup
// used to readFileSync the WHOLE existing file (up to 50MB) on the main process just to compare
// hashes against the (already in-memory) incoming buffer. Same pattern as the serve-side C8
// fix: one ENTRY_CHUNK_BYTES window resident at a time.
function sha256FileChunked (fs, fp) {
  const fd = fs.openSync(fp, 'r')
  try {
    const hasher = createHash('sha256')
    const buf = Buffer.alloc(ENTRY_CHUNK_BYTES)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      hasher.update(n === buf.length ? buf : buf.subarray(0, n))
    }
    return hasher.digest('hex')
  } finally { fs.closeSync(fd) }
}

/** Default disk layer over the user-data attachments dir. Injectable for tests.
 *  depsOverride.attachmentsMod lets unit tests stub the electron-side attachments module
 *  (attachDir / readAliases / setAlias) without Electron; production passes nothing. */
function makeDeps (depsOverride = {}) {
  const fs = require('node:fs')
  const path = require('node:path')
  const attachmentsMod = depsOverride.attachmentsMod || require('../attachments')
  let dir = null
  const attachDir = () => {
    if (dir) return dir
    // Fail closed on WRITE (fix 2026-10-06): a single attachDir() failure used to be answered
    // with process.cwd() AND CACHED — every later attachment write silently landed outside the
    // managed dir (unmanaged files, quota bypass, no cleanup). writeAtomic calls attachDir()
    // directly so the failure THROWS into the puller's failed-set; read-side helpers use
    // tryDir() and degrade to "missing" instead (an unreadable dir has nothing to serve).
    dir = attachmentsMod.attachDir()
    return dir
  }
  const tryDir = () => { try { return attachDir() } catch { return null } }
  // att-transfer-rename-ref-mismatch fix: a LAN pull that hit a same-name-different-content
  // conflict was renamed to `name-1` on disk, but the synced row still references the ORIGINAL
  // key — every local resolution (serving, missing-detection, open/read) must translate through
  // the device-local alias map (attachments.readAliases) FIRST. Never synced; peers resolve
  // through their own map.
  const resolveKey = (key, baseDir) => {
    const base = path.basename(String(key))
    try {
      const alias = attachmentsMod.readAliases()[base]
      if (alias) return path.join(baseDir, path.basename(alias))
    } catch { /* electron-free unit context: no alias map */ }
    return path.join(baseDir, base)
  }
  return {
    exists: key => { const d = tryDir(); return d != null && fs.existsSync(resolveKey(key, d)) },
    size: key => { const d = tryDir(); if (d == null) return 0; try { return fs.statSync(resolveKey(key, d)).size } catch { return 0 } },
    // C8 (daily 2026-09-24): positional chunked read — reads ONLY the requested [start..end]
    // byte range via fs.readSync. The old default readFileSync'd the WHOLE file (up to 50MB)
    // and sliced it, so every serve pass kept the full file resident and blocked the main process.
    read: (key, start, end) => {
      const d = tryDir()
      if (d == null) return Buffer.alloc(0)
      const fp = resolveKey(key, d)
      const len = Math.max(0, end - start + 1)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(fp, 'r')
      try {
        const n = fs.readSync(fd, buf, 0, len, start)
        return n === len ? buf : buf.subarray(0, n)
      } finally { fs.closeSync(fd) }
    },
    writeAtomic: (key, buf) => {
      // P2-c (2026-09-19 data-safety round): never silently overwrite an existing local file with
      // DIFFERENT content under the same basename (two devices can mint the same filename for
      // different files — an overwrite would corrupt the first todo's attachment). Identical
      // content is a dedup no-op; differing content renames the incoming file with a numeric
      // suffix (mirrors attachments.js nextFreePath semantics).
      // att-transfer-rename-ref-mismatch fix: writeAtomic now RETURNS the final stored basename
      // and RECORDS a device-local alias (attachments.setAlias) for the conflict rename, so the
      // synced row's original local://name keeps resolving to the INCOMING content on this device
      // (the row itself is never rewritten — that would diverge it from the sender).
      // P2-b: the tmp file is unlinked in finally — a rename failure used to leave .att-tmp-*
      // residue that accumulated across retries.
      // F-A2 defense-in-depth: the whitelist also gates the disk layer itself, so a future
      // caller bypassing the puller cannot land a script-capable file (extAllowed fail-closed).
      if (!extAllowed(key)) throw new Error('attachment: extension not allowed')
      // C14-cross: the quota-exempt white-noise slot name shape never arrives over LAN
      // (disk-layer twin of the puller gate below — defense in depth, same as F-A2).
      if (reservedNoiseSlot(key)) throw new Error('attachment: reserved white-noise slot name')
      const dst = path.join(attachDir(), path.basename(String(key)))
      // D19-DOM1 (C9 quota precheck ordering): the cheap dedup check runs FIRST and the quota
      // gate runs BEFORE the tmp spool — the old order wrote up to 50MB of tmp + hashed it and
      // only THEN consulted assertWriteAllowed. An identical-content dedup no-op stays
      // quota-exempt (it lands no new file), now without ever spooling tmp.
      if (fs.existsSync(dst)) {
        let same = false
        try { same = sha256FileChunked(fs, dst) === sha256Hex(buf) } catch { same = false }
        if (same) return path.basename(dst)
      }
      // att-transfer-quota-bypass fix: the LAN receive door enforces the SAME caps as the
      // upload door (attachments-guards.assertWriteAllowed: 50MB/file + 64MB total + 200-file
      // count). A refusal throws into the puller's catch → markFailed (24h failed-set, no
      // retry loop) BEFORE anything touched the disk.
      require('../attachments-guards').assertWriteAllowed({ incomingBytes: buf.length, dir: attachDir() })
      const tmp = `${dst}.att-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      let finalDst = dst
      try {
        // D21 (P2 2026-10-02): route the spool through writeFileDurable (tmp → fsync → rename)
        // instead of a bare writeFileSync — without the file-data fsync the final rename could hit
        // disk before the received bytes, leaving a truncated/hash-mismatched attachment after a
        // power cut. The .att-tmp name is kept so the D19 residue sweep still matches crash trash.
        require('../durable-fs').writeFileDurable(tmp, buf, fs)
        if (fs.existsSync(dst)) {
          // Non-dedup conflict: same-name DIFFERENT content (the identical case returned above).
          const ext = path.extname(dst)
          const stem = dst.slice(0, dst.length - ext.length)
          let n = 1
          while (fs.existsSync(`${stem}-${n}${ext}`)) n += 1
          finalDst = `${stem}-${n}${ext}`
        }
        // D19-DOM1: authoritative POST-write re-check kept for TOCTOU (the dir state can change
        // between the precheck and the rename — the rename still only happens inside quota).
        fs.renameSync(tmp, finalDst)
        if (finalDst !== dst) {
          // Conflict rename landed: alias the original key to the new on-disk name so the
          // synced row's local://original-key resolves to the incoming bytes on THIS device.
          // Phantom-success guard (fix 2026-10-06): a swallowed setAlias failure left the row's
          // key resolving to the OLD file's basename while the bytes live under `name-N` — the
          // missing-file guard kept re-pulling forever. Fail the write instead (the puller
          // records a failed-set entry); the renamed file stays on disk for forensics.
          let aliased = false
          try { attachmentsMod.setAlias(path.basename(String(key)), path.basename(finalDst)); aliased = true } catch { aliased = false }
          if (!aliased) throw new Error('attachment: conflict rename landed (' + path.basename(finalDst) + ') but alias registration failed — refusing phantom success')
        }
        return path.basename(finalDst)
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      }
    },
  }
}
function defaultDeps () { return makeDeps() }

/* ---------- sender (server role) ---------- */

/**
 * Serves att-req batches for connected peers. One instance per node (per-session rate
 * bookkeeping lives here). deps (exists/size/read) default to the real attachments dir.
 */
function createAttachmentServer (deps = {}) {
  const d = { ...defaultDeps(), ...deps }
  const maxFileBytes = Number(deps.maxFileBytes) || MAX_FILE_BYTES
  const maxRoundBytes = Number(deps.maxRoundBytes) || MAX_BYTES_PER_ROUND
  const perPeerCap = Number(deps.perPeerCap) || MAX_REQUESTS_PER_SESSION
  const requestsByPeer = new Map() // deviceId -> att-req batches served this session

  /**
   * Serve one att-req. Returns {sent, missing} for logging; every answer travels through
   * `send` (the encrypted session path). Never throws at the caller.
   * P2 2026-09-20: `send` now reports delivery (boolean). A failed frame send means the peer's
   * socket is dead — abort the remaining serving immediately (the receiver's connection-error
   * handler surfaces the round error promptly) instead of streaming the rest of the batch into
   * the void until the receiver's 120s round deadline.
   */
  function serve (peer, msg, send) {
    const emit = m => {
      let ok = false
      try { ok = send(m) !== false } catch { ok = false }
      return ok
    }
    const ids = Array.isArray(msg && msg.ids) ? msg.ids.slice(0, MAX_FILES_PER_ROUND) : []
    const peerId = (peer && peer.deviceId) || 'unknown'
    const count = requestsByPeer.get(peerId) || 0
    if (count >= perPeerCap) {
      try { require('electron-log').warn('[LanSync] att-req rate-capped for', peerId) } catch { /* noop */ }
      // (log-isolation now loads at module top — C8 2026-10-09)
      emit({ type: 'att-end', sent: 0, missing: ids.length })
      return { sent: 0, missing: ids.length, capped: true }
    }
    requestsByPeer.set(peerId, count + 1)
    let sent = 0
    let missing = 0
    let roundBytes = 0
    let budgetSkipped = 0 // C9: files skipped by the round byte budget (reported on the result)
    for (const rawId of ids) {
      const id = String(rawId || '')
      if (!id || /[\\/]|\.\./.test(id)) { missing += 1; if (!emit({ type: 'att-missing', id, reason: 'bad-id' })) return { sent, missing, aborted: true }; continue }
      // Fix (2026-10-09): the exists() precheck used to sit OUTSIDE the per-file try below —
      // a vanished/fs-error file threw straight out of serve() and aborted the WHOLE batch
      // with no att-end, so the requester burned its full 120s round deadline. ROOT cause:
      // the D14 C8 per-file try only covered the read path, not the precheck that consults
      // the same disk state. Moved inside: any precheck/read throw now answers the
      // att-missing error shape (read-error) and the batch still terminates with att-end.
      try {
      if (!d.exists(id)) { missing += 1; if (!emit({ type: 'att-missing', id, reason: 'not-found' })) return { sent, missing, aborted: true }; continue }
      const size = d.size(id)
      if (size > maxFileBytes) {
        missing += 1
        try { require('electron-log').warn('[LanSync] att-req refused (too large):', id, size) } catch { /* noop */ }
        if (!emit({ type: 'att-missing', id, reason: 'too-large' })) return { sent, missing, aborted: true }
        continue
      }
      if (roundBytes + size > maxRoundBytes) {
        missing += 1
        budgetSkipped += 1
        // C9 (daily 2026-09-24): budget exhaustion used to be SILENT — contrast the rate-cap and
        // too-large branches which both warn. An operator watching logs saw a batch quietly come
        // up short with no trace. Warn here; the per-session recent ring (pushRecent) lives in
        // lan-sync/index.js's server wiring, outside this module's surface — the budgetSkipped
        // count on the return value is the hook it can consume.
        try { require('electron-log').warn('[LanSync] att-req round byte budget exhausted, skipping', id, '(' + roundBytes + '/', maxRoundBytes, 'bytes used this round)') } catch { /* noop */ }
        if (!emit({ type: 'att-missing', id, reason: 'round-budget' })) return { sent, missing, aborted: true, budgetSkipped }
        continue
      }
      roundBytes += size
      // C8 (daily 2026-09-24): chunked read + streaming hash. The old path materialized the
      // WHOLE file (up to 50MB) with d.read(0, size-1) just to hash it, then sliced att-chunks
      // out of that resident buffer — a full readFileSync + sha256 blocking the main process per
      // file (<=64MB per batch). Now each pass holds ONE ENTRY_CHUNK_BYTES chunk: pass 1 streams
      // the file through an incremental sha256 for att-meta, pass 2 re-reads each chunk and
      // sends it. At no point is the full file resident.
      const hasher = createHash('sha256')
      for (let off = 0; off < size; off += ENTRY_CHUNK_BYTES) {
        hasher.update(d.read(id, off, Math.min(off + ENTRY_CHUNK_BYTES, size) - 1))
      }
      const hash = hasher.digest('hex')
      if (!emit({ type: 'att-meta', id, size, hash })) {
        try { require('electron-log').warn('[LanSync] att-meta send failed, aborting serve for', peerId) } catch { /* noop */ }
        return { sent, missing, aborted: true, budgetSkipped }
      }
      for (let off = 0, idx = 0; off < size; off += ENTRY_CHUNK_BYTES, idx++) {
        const chunk = d.read(id, off, Math.min(off + ENTRY_CHUNK_BYTES, size) - 1)
        if (!emit({ type: 'att-chunk', id, index: idx, data: chunk.toString('base64'), final: off + ENTRY_CHUNK_BYTES >= size })) {
          try { require('electron-log').warn('[LanSync] att-chunk send failed, aborting serve for', peerId) } catch { /* noop */ }
          return { sent, missing, aborted: true, budgetSkipped }
        }
      }
      } catch (readErr) {
        missing += 1
        try { require('electron-log').warn('[LanSync] att-req read failed, answering att-missing:', id, readErr && readErr.message) } catch { /* noop */ }
        if (!emit({ type: 'att-missing', id, reason: 'read-error' })) return { sent, missing, aborted: true }
        continue
      }
      sent += 1
    }
    emit({ type: 'att-end', sent, missing, budgetSkipped })
    return { sent, missing, budgetSkipped }
  }

  // Fix-round (2026-09-22, lan-sync-8): per-peer bookkeeping must not outlive the peer —
  // the node's forgetPeer calls this so a removed/expelled peer's served-request budget and
  // session entry are reclaimed instead of lingering for the whole node lifetime.
  return {
    serve,
    requestsFor: peerId => requestsByPeer.get(peerId) || 0,
    forget: peerId => { requestsByPeer.delete(String(peerId || '')) },
  }
}

/* ---------- receiver (client role) ---------- */

/**
 * Drives one pull batch inside a sync round. One instance PER ROUND (cheap); the
 * `session` object ({failed:Set, requests:Map}) is shared across rounds of one node.
 */
function createAttachmentPuller (opts = {}) {
  const d = { ...defaultDeps(), ...opts.deps }
  const maxFileBytes = Number(opts.maxFileBytes) || MAX_FILE_BYTES
  const maxFiles = Number(opts.maxFiles) || MAX_FILES_PER_ROUND
  const maxBytes = Number(opts.maxBytes) || MAX_BYTES_PER_ROUND
  // P2-e: the failed-set carries TIMESTAMPS (Map id -> failedAt ms); entries older than
  // FAILED_TTL_MS no longer count as failed. A legacy Set session (older caller) is adapted.
  const rawSession = opts.session || { failed: new Map(), requests: new Map() }
  const failedSet = rawSession.failed instanceof Set ? rawSession.failed : (rawSession.failed instanceof Map ? rawSession.failed : new Map())
  const session = { ...rawSession, failed: failedSet }
  const failedAt = id => (failedSet instanceof Map ? failedSet.get(id) : (failedSet.has(id) ? 0 : undefined))
  const isFailed = id => {
    if (!failedSet.has(id)) return false
    const at = failedAt(id)
    if (failedSet instanceof Map && typeof at === 'number' && Date.now() - at > FAILED_TTL_MS) {
      failedSet.delete(id) // expired: pullable again
      return false
    }
    return true
  }
  const pending = [] // keys queued for THIS round (FIFO)
  // perf fix (2026-10-02, d15): noteMissing used to dedupe via pending.includes — O(n) per key,
  // quadratic when a large snapshot's missing-key set overlaps across rounds. The Set mirrors
  // the array; entries are removed on shift so a key can be re-noted by a later round.
  const pendingSet = new Set()
  let busy = false
  let onDone = null
  let current = null // {id, size, hash, chunks: Map<index,buf>, received}
  let requested = false
  let requestedBatch = new Set() // P2-a: ids actually requested this round (unsolicited frames rejected)
  let settled = false
  let receivedBytes = 0 // round budget accounting (actual att-meta sizes)
  const reservedIds = new Set() // Wave-B P2-2: ids whose budget was reserved this round (dedupe)

  /** Queue keys observed missing on disk (deduped against the session failed-set). */
  function noteMissing (keys) {
    for (const key of keys || []) {
      const k = String(key)
      if (isFailed(k)) continue
      if (pendingSet.has(k)) continue
      pendingSet.add(k)
      pending.push(k)
    }
  }

  /**
   * Send the att-req for the next batch (if any). Returns true when a request went out —
   * the round then stays open until att-end (or fails via onError).
   */
  function maybeStart (doneCb, errorCb) {
    if (busy || requested) return false
    if (typeof opts.getKeys === 'function') noteMissing(opts.getKeys())
    const peerId = opts.peerId || 'peer'
    const used = session.requests.get(peerId) || 0
    if (used >= MAX_REQUESTS_PER_SESSION) return false
    const batch = []
    while (pending.length && batch.length < maxFiles) {
      const key = pending.shift()
      pendingSet.delete(key)
      if (d.exists(key)) continue // arrived via another path/round
      batch.push(key)
    }
    if (!batch.length) return false
    session.requests.set(peerId, used + 1)
    requestedBatch = new Set(batch) // P2-a: only these ids may come back as att-meta
    try {
      opts.send({ type: 'att-req', ids: batch })
    } catch (err) {
      // Hardening (2026-09-19 drill): a send failure here must NEVER fail the sync round —
      // it used to propagate through the round's message dispatch into finish(err), so one
      // missing attachment made ALL sync rounds fail until the file appeared. Log, mark the
      // batch failed (per-session failed-set prevents retry loops), and report "no request
      // sent" so the caller finishes the round cleanly. errorCb kept for API symmetry:
      // batch-level failures are skipped, not fatal.
      try { require('electron-log').warn('[LanSync] att-req send failed, batch skipped:', err && err.message) } catch { /* noop */ }
      for (const id of batch) markFailed(id)
      return false
    }
    onDone = doneCb
    busy = true
    requested = true
    return true
  }

  function finishOk () {
    if (settled) return
    settled = true
    // Fix (2026-10-09): att-end arriving mid-transfer used to discard an open `current`
    // without bookkeeping — its reserved byte budget stayed held for the rest of the round
    // and the id never entered the failed-set (a peer that truncates a batch could leave the
    // half-received file silently re-requestable forever). Settle it like a failure:
    // markFailed refunds the reserved size and adds the failed-set entry (the in-flight file
    // is incomplete, keeping it pullable-in-this-session is wrong).
    if (current) markFailed(current.id)
    busy = false
    if (onDone) { const cb = onDone; onDone = null; cb() }
  }

  function markFailed (id) {
    if (failedSet instanceof Map) failedSet.set(id, Date.now())
    else failedSet.add(id)
    // M-8 (2026-09-20): when the failing file is the one currently being received (hash mismatch
    // or write failure), REFUND its reserved size from the round byte budget — the transfer is
    // dead, the reserved bytes were never landed, and without the refund one bad file shrank the
    // budget for every later file in the round by up to maxFileBytes.
    // Fix-round (2026-09-22): the refund AND the current-transfer cancellation apply ONLY when
    // the failing id IS the in-flight file. markFailed used to clear `current` unconditionally,
    // so an att-missing/att-meta failure carrying a DIFFERENT id silently dropped the file
    // already being received while keeping its reserved byte budget (fix-round lan-sync-2).
    if (current && String(id) === current.id) {
      receivedBytes = Math.max(0, receivedBytes - current.size)
      current = null
    }
  }

  /**
   * Handle one att-* message. Returns true while the transfer is still open; FALSE when
   * the batch terminated (att-end) — the caller then finishes the round.
   */
  function onMessage (msg) {
    const type = msg && msg.type
    if (type === 'att-meta') {
      const idStr = String(msg.id)
      // Wave-B P2-2: DUPLICATE att-meta for the file currently in flight (a buggy or re-serving
      // peer re-announcing meta mid-transfer) must REUSE the open session, not re-open it — the
      // old path re-reserved `size` against the round byte budget and reset `chunks`/`received`,
      // double-counting the 64MB budget and corrupting the assembly.
      if (current && current.id === idStr) {
        try { require('electron-log').warn('[LanSync] duplicate att-meta for in-flight file, reusing open session:', idStr) } catch { /* noop */ }
        return true
      }
      // Same guard for a meta re-sent AFTER the file already completed this round: the budget was
      // already spent and the file landed — ignore instead of re-opening.
      if (reservedIds.has(idStr)) {
        try { require('electron-log').warn('[LanSync] duplicate att-meta for completed file, ignored:', idStr) } catch { /* noop */ }
        return true
      }
      // P2-a (2026-09-19 data-safety round): reject UNSOLICITED att-meta frames — an id we did
      // not request in this round's batch must never open a receive session (a compromised or
      // buggy peer cannot push arbitrary files into the round's byte budget).
      if (!requestedBatch.has(idStr)) {
        try { require('electron-log').warn('[LanSync] unsolicited att-meta rejected:', idStr) } catch { /* noop */ }
        return true
      }
      // P2-b: size must be a finite positive number within the single-file cap — NaN used to
      // poison the byte budget (`receivedBytes + NaN > maxBytes` is false, so NaN sizes sailed
      // through and then `|| 0` recorded 0 received bytes while chunks still arrived).
      const size = Number(msg.size)
      if (!Number.isFinite(size) || size <= 0 || size > maxFileBytes) {
        try { require('electron-log').warn('[LanSync] att-meta invalid size, treated as protocol error:', idStr, msg.size) } catch { /* noop */ }
        markFailed(idStr); return true
      }
      // Wave-B P2-2: the budget is reserved ONCE per id per round (guard above rejects re-metas).
      if (receivedBytes + size > maxBytes) {
        try { require('electron-log').warn('[LanSync] attachment exceeds round byte budget, skipped:', idStr) } catch { /* noop */ }
        markFailed(idStr); return true
      }
      receivedBytes += size
      reservedIds.add(idStr)
      // Fix (2026-10-09): a meta for a DIFFERENT id while a transfer is open used to silently
      // overwrite `current` — the in-flight file was destroyed (chunks dropped) while its
      // reserved byte budget stayed held for the rest of the round, and the id never entered
      // the failed-set (the batch's next round re-requested a file the peer clearly cannot
      // deliver coherently). Settle the in-flight transfer FIRST: markFailed refunds its
      // reserved size (M-8 refund applies because id === current.id) and adds the failed-set
      // entry — same policy as an explicit att-missing for that id.
      if (current && current.id !== idStr) markFailed(current.id)
      current = { id: idStr, size, hash: String(msg.hash || ''), chunks: new Map(), received: 0 }
      return true
    }
    if (type === 'att-chunk') {
      if (!current || String(msg.id) !== current.id) return true
      const buf = Buffer.from(String(msg.data || ''), 'base64')
      // Round-3 P1: the DECLARED size (att-meta) is a hard ceiling — the old buffer accepted
      // unbounded chunks and only failed at the hash check, so a buggy/malicious peer could
      // balloon memory far past maxFileBytes per file. Enforce received+chunk <= size; a
      // violation is a protocol error: drop the file, refund its reserved budget, fail the id
      // (markFailed already refunds the byte budget and clears `current`).
      if (current.received + buf.length > current.size) {
        try { require('electron-log').warn('[LanSync] att-chunk exceeds declared size, protocol error:', current.id) } catch { /* noop */ }
        markFailed(String(current.id))
        return true
      }
      // Chunk-count ceiling (defensive): a peer drip-feeding 1-byte chunks forever must not
      // grow the assembly map without limit (64k chunks is far past any real file at the
      // frame sizes this protocol uses).
      if (current.chunks.size >= 65536) {
        try { require('electron-log').warn('[LanSync] att-chunk count ceiling exceeded, protocol error:', current.id) } catch { /* noop */ }
        markFailed(String(current.id))
        return true
      }
      // D22 (P3) index coercion hardening: `Number(msg.index) || 0` used to accept ANY junk
      // key (negative, fractional, garbage-string folded to a number anyway) — a non-contiguous
      // key silently truncated the final assembly, surfacing only as a downstream hash mismatch
      // instead of a clear protocol error. Coerce explicitly and reject anything that is not a
      // sane chunk ordinal (fail-closed, same terminal as the ceiling above).
      const idx = Number(msg.index)
      if (!Number.isInteger(idx) || idx < 0 || idx >= 65536) {
        try { require('electron-log').warn('[LanSync] att-chunk invalid index, protocol error:', current.id, msg.index) } catch { /* noop */ }
        markFailed(String(current.id))
        return true
      }
      current.chunks.set(idx, buf)
      current.received += buf.length
      if (msg.final) {
        const assembled = []
        for (let i = 0; current.chunks.has(i); i++) assembled.push(current.chunks.get(i))
        const full = Buffer.concat(assembled)
        const id = current.id
        if (sha256Hex(full, opts.deps && opts.deps.hashFn) !== current.hash) {
          try { require('electron-log').warn('[LanSync] attachment hash mismatch, skipped:', id) } catch { /* noop */ }
          markFailed(id)
        } else if (!extAllowed(id)) {
          // F-A2: extension outside the shared whitelist → protocol-level refusal: the file
          // lands in the per-session failed-set (no retry loop), nothing touches the disk.
          try { require('electron-log').warn('[LanSync] attachment extension not allowed, skipped:', id) } catch { /* noop */ }
          markFailed(id)
        } else if (reservedNoiseSlot(id)) {
          // C14-cross: the quota-exempt noise slot name shape is unclaimable over LAN — a peer
          // could otherwise persist quota-exempt files that the white-noise pick never clears.
          try { require('electron-log').warn('[LanSync] attachment reserved noise-slot name, skipped:', id) } catch { /* noop */ }
          markFailed(id)
        } else {
          let finalName = null
          try { finalName = d.writeAtomic(id, full); session.failed.delete(id) } catch (e) {
            try { require('electron-log').warn('[LanSync] attachment write failed:', id, e && e.message) } catch { /* noop */ }
            markFailed(id)
          }
          // P1-8 (2026-09-19 UX review): the file just landed — notify the host so it can tell the
          // renderer to refresh attachment images/lists (previously the arrival was invisible until
          // a full view reload happened to run). writeAtomic returns the FINAL stored basename —
          // `name-1` when a same-name-different-content conflict was renamed — so the host learns
          // where the bytes actually landed (the row's key keeps resolving via the alias map).
          try { if (typeof opts.onArrived === 'function') opts.onArrived(id, finalName || id) } catch { /* notify is best-effort */ }
        }
        current = null
      }
      return true
    }
    if (type === 'att-missing') {
      // P2-a parity (fix-round lan-sync-1, 2026-09-22): only ids THIS round actually requested
      // may be marked failed. An unsolicited att-missing used to write an ARBITRARY id into the
      // 24h session failed-set (blocking that attachment's pull for a full day) — a buggy or
      // compromised peer (threat model: holds the pairing secret) could poison any id at will.
      if (!requestedBatch.has(String(msg.id))) {
        try { require('electron-log').warn('[LanSync] unsolicited att-missing rejected:', String(msg.id)) } catch { /* noop */ }
        return true
      }
      markFailed(String(msg.id))
      return true
    }
    if (type === 'att-end') {
      finishOk()
      return false // batch terminal: the round may finish
    }
    return true
  }

  return {
    noteMissing,
    maybeStart,
    onMessage,
    handles: type => type === 'att-req' || type === 'att-meta' || type === 'att-chunk' || type === 'att-missing' || type === 'att-end',
    get busy () { return busy },
  }
}

module.exports = {
  ENTRY_CHUNK_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_ROUND,
  MAX_BYTES_PER_ROUND,
  MAX_REQUESTS_PER_SESSION,
  FAILED_TTL_MS,
  extractLocalKeys,
  collectMissingKeys,
  createAttachmentServer,
  createAttachmentPuller,
  defaultDeps, // test hook (C14-cross): lets unit tests reach the real disk layer directly
  makeDeps, // test hook (2026-10-06): deps factory with a stubbable attachments module (attachDir/setAlias injection)
}
