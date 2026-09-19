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
      const dst = path.join(attachDir(), path.basename(String(key)))
      const tmp = `${dst}.att-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, dst)
      return true
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
   */
  function serve (peer, msg, send) {
    const ids = Array.isArray(msg && msg.ids) ? msg.ids.slice(0, MAX_FILES_PER_ROUND) : []
    const peerId = (peer && peer.deviceId) || 'unknown'
    const count = requestsByPeer.get(peerId) || 0
    if (count >= perPeerCap) {
      try { require('electron-log').warn('[LanSync] att-req rate-capped for', peerId) } catch { /* noop */ }
      send({ type: 'att-end', sent: 0, missing: ids.length })
      return { sent: 0, missing: ids.length, capped: true }
    }
    requestsByPeer.set(peerId, count + 1)
    let sent = 0
    let missing = 0
    let roundBytes = 0
    for (const rawId of ids) {
      const id = String(rawId || '')
      if (!id || /[\\/]|\.\./.test(id)) { missing += 1; send({ type: 'att-missing', id, reason: 'bad-id' }); continue }
      if (!d.exists(id)) { missing += 1; send({ type: 'att-missing', id, reason: 'not-found' }); continue }
      const size = d.size(id)
      if (size > maxFileBytes) {
        missing += 1
        try { require('electron-log').warn('[LanSync] att-req refused (too large):', id, size) } catch { /* noop */ }
        send({ type: 'att-missing', id, reason: 'too-large' })
        continue
      }
      if (roundBytes + size > maxRoundBytes) {
        missing += 1
        send({ type: 'att-missing', id, reason: 'round-budget' })
        continue
      }
      roundBytes += size
      const full = d.read(id, 0, size - 1)
      const hash = sha256Hex(full, deps.hashFn)
      send({ type: 'att-meta', id, size: full.length, hash })
      for (let off = 0, idx = 0; off < full.length; off += ENTRY_CHUNK_BYTES, idx++) {
        const chunk = full.slice(off, Math.min(off + ENTRY_CHUNK_BYTES, full.length))
        send({ type: 'att-chunk', id, index: idx, data: chunk.toString('base64'), final: off + ENTRY_CHUNK_BYTES >= full.length })
      }
      sent += 1
    }
    send({ type: 'att-end', sent, missing })
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
  const session = opts.session || { failed: new Set(), requests: new Map() }
  const pending = [] // keys queued for THIS round
  let busy = false
  let onDone = null
  let current = null // {id, size, hash, chunks: Map<index,buf>, received}
  let requested = false
  let settled = false
  let receivedBytes = 0 // round budget accounting (actual att-meta sizes)

  /** Queue keys observed missing on disk (deduped against the session failed-set). */
  function noteMissing (keys) {
    for (const key of keys || []) {
      if (session.failed.has(key)) continue
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
    session.failed.add(id)
    current = null
  }

  /**
   * Handle one att-* message. Returns true while the transfer is still open; FALSE when
   * the batch terminated (att-end) — the caller then finishes the round.
   */
  function onMessage (msg) {
    const type = msg && msg.type
    if (type === 'att-meta') {
      if (Number(msg.size) > maxFileBytes) { markFailed(String(msg.id)); return true }
      if (receivedBytes + Number(msg.size) > maxBytes) {
        try { require('electron-log').warn('[LanSync] attachment exceeds round byte budget, skipped:', String(msg.id)) } catch { /* noop */ }
        markFailed(String(msg.id)); return true
      }
      receivedBytes += Number(msg.size) || 0
      current = { id: String(msg.id), size: Number(msg.size) || 0, hash: String(msg.hash || ''), chunks: new Map(), received: 0 }
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
  extractLocalKeys,
  collectMissingKeys,
  createAttachmentServer,
  createAttachmentPuller,
}
