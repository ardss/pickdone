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

/** Default disk layer over the user-data attachments dir. Injectable for tests. */
function defaultDeps () {
  const fs = require('node:fs')
  const path = require('node:path')
  let dir = null
  const attachDir = () => {
    if (dir) return dir
    try { dir = require('../attachments').attachDir() } catch { dir = process.cwd() }
    return dir
  }
  return {
    exists: key => fs.existsSync(path.join(attachDir(), path.basename(String(key)))),
    size: key => { try { return fs.statSync(path.join(attachDir(), path.basename(String(key)))).size } catch { return 0 } },
    read: (key, start, end) => fs.readFileSync(path.join(attachDir(), path.basename(String(key)))).slice(start, end + 1),
    writeAtomic: (key, buf) => {
      // P2-c (2026-09-19 data-safety round): never silently overwrite an existing local file with
      // DIFFERENT content under the same basename (two devices can mint the same filename for
      // different files — an overwrite would corrupt the first todo's attachment). Identical
      // content is a dedup no-op; differing content renames the incoming file with a numeric
      // suffix (mirrors attachments.js nextFreePath semantics).
      // P2-b: the tmp file is unlinked in finally — a rename failure used to leave .att-tmp-*
      // residue that accumulated across retries.
      const dst = path.join(attachDir(), path.basename(String(key)))
      const tmp = `${dst}.att-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      let finalDst = dst
      try {
        fs.writeFileSync(tmp, buf)
        if (fs.existsSync(dst)) {
          let same = false
          try { same = sha256Hex(fs.readFileSync(dst)) === sha256Hex(buf) } catch { same = false }
          if (same) return true // already have this exact content
          const ext = path.extname(dst)
          const stem = dst.slice(0, dst.length - ext.length)
          let n = 1
          while (fs.existsSync(`${stem}-${n}${ext}`)) n += 1
          finalDst = `${stem}-${n}${ext}`
        }
        fs.renameSync(tmp, finalDst)
        return true
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      }
    },
  }
}

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
      emit({ type: 'att-end', sent: 0, missing: ids.length })
      return { sent: 0, missing: ids.length, capped: true }
    }
    requestsByPeer.set(peerId, count + 1)
    let sent = 0
    let missing = 0
    let roundBytes = 0
    for (const rawId of ids) {
      const id = String(rawId || '')
      if (!id || /[\\/]|\.\./.test(id)) { missing += 1; if (!emit({ type: 'att-missing', id, reason: 'bad-id' })) return { sent, missing, aborted: true }; continue }
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
        if (!emit({ type: 'att-missing', id, reason: 'round-budget' })) return { sent, missing, aborted: true }
        continue
      }
      roundBytes += size
      const full = d.read(id, 0, size - 1)
      const hash = sha256Hex(full, deps.hashFn)
      if (!emit({ type: 'att-meta', id, size: full.length, hash })) {
        try { require('electron-log').warn('[LanSync] att-meta send failed, aborting serve for', peerId) } catch { /* noop */ }
        return { sent, missing, aborted: true }
      }
      for (let off = 0, idx = 0; off < full.length; off += ENTRY_CHUNK_BYTES, idx++) {
        const chunk = full.slice(off, Math.min(off + ENTRY_CHUNK_BYTES, full.length))
        if (!emit({ type: 'att-chunk', id, index: idx, data: chunk.toString('base64'), final: off + ENTRY_CHUNK_BYTES >= full.length })) {
          try { require('electron-log').warn('[LanSync] att-chunk send failed, aborting serve for', peerId) } catch { /* noop */ }
          return { sent, missing, aborted: true }
        }
      }
      sent += 1
    }
    emit({ type: 'att-end', sent, missing })
    return { sent, missing }
  }

  return { serve, requestsFor: peerId => requestsByPeer.get(peerId) || 0 }
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
  const pending = [] // keys queued for THIS round
  let busy = false
  let onDone = null
  let current = null // {id, size, hash, chunks: Map<index,buf>, received}
  let requested = false
  let requestedBatch = new Set() // P2-a: ids actually requested this round (unsolicited frames rejected)
  let settled = false
  let receivedBytes = 0 // round budget accounting (actual att-meta sizes)

  /** Queue keys observed missing on disk (deduped against the session failed-set). */
  function noteMissing (keys) {
    for (const key of keys || []) {
      if (isFailed(String(key))) continue
      if (!pending.includes(key)) pending.push(key)
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
    busy = false
    if (onDone) { const cb = onDone; onDone = null; cb() }
  }

  function markFailed (id) {
    if (failedSet instanceof Map) failedSet.set(id, Date.now())
    else failedSet.add(id)
    current = null
  }

  /**
   * Handle one att-* message. Returns true while the transfer is still open; FALSE when
   * the batch terminated (att-end) — the caller then finishes the round.
   */
  function onMessage (msg) {
    const type = msg && msg.type
    if (type === 'att-meta') {
      // P2-a (2026-09-19 data-safety round): reject UNSOLICITED att-meta frames — an id we did
      // not request in this round's batch must never open a receive session (a compromised or
      // buggy peer cannot push arbitrary files into the round's byte budget).
      if (!requestedBatch.has(String(msg.id))) {
        try { require('electron-log').warn('[LanSync] unsolicited att-meta rejected:', String(msg.id)) } catch { /* noop */ }
        return true
      }
      // P2-b: size must be a finite positive number within the single-file cap — NaN used to
      // poison the byte budget (`receivedBytes + NaN > maxBytes` is false, so NaN sizes sailed
      // through and then `|| 0` recorded 0 received bytes while chunks still arrived).
      const size = Number(msg.size)
      if (!Number.isFinite(size) || size <= 0 || size > maxFileBytes) {
        try { require('electron-log').warn('[LanSync] att-meta invalid size, treated as protocol error:', String(msg.id), msg.size) } catch { /* noop */ }
        markFailed(String(msg.id)); return true
      }
      if (receivedBytes + size > maxBytes) {
        try { require('electron-log').warn('[LanSync] attachment exceeds round byte budget, skipped:', String(msg.id)) } catch { /* noop */ }
        markFailed(String(msg.id)); return true
      }
      receivedBytes += size
      current = { id: String(msg.id), size, hash: String(msg.hash || ''), chunks: new Map(), received: 0 }
      return true
    }
    if (type === 'att-chunk') {
      if (!current || String(msg.id) !== current.id) return true
      const buf = Buffer.from(String(msg.data || ''), 'base64')
      current.chunks.set(Number(msg.index) || 0, buf)
      current.received += buf.length
      if (msg.final) {
        const assembled = []
        for (let i = 0; current.chunks.has(i); i++) assembled.push(current.chunks.get(i))
        const full = Buffer.concat(assembled)
        const id = current.id
        if (sha256Hex(full, opts.deps && opts.deps.hashFn) !== current.hash) {
          try { require('electron-log').warn('[LanSync] attachment hash mismatch, skipped:', id) } catch { /* noop */ }
          markFailed(id)
        } else {
          try { d.writeAtomic(id, full); session.failed.delete(id) } catch (e) {
            try { require('electron-log').warn('[LanSync] attachment write failed:', id, e && e.message) } catch { /* noop */ }
            markFailed(id)
          }
          // P1-8 (2026-09-19 UX review): the file just landed — notify the host so it can tell the
          // renderer to refresh attachment images/lists (previously the arrival was invisible until
          // a full view reload happened to run).
          try { if (typeof opts.onArrived === 'function') opts.onArrived(id) } catch { /* notify is best-effort */ }
        }
        current = null
      }
      return true
    }
    if (type === 'att-missing') {
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
}
