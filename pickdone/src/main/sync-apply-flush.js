'use strict'
/**
 * Sync apply flush layer (structure-size ratchet, 2026-10-10): the buffered bulk-write
 * drain + poison-row quarantine + the twin-door bus write helper, moved VERBATIM from
 * sync-apply.js (same doctrine as the sync-apply-hydrate/sync-apply-content/sync-adjudicate
 * splits — only-split-never-grow). sync-apply.js re-exports everything below, so the
 * bootstrap/test import surface is unchanged.
 *
 * Contents:
 *   - busFor/busWrite: the per-state injected-ingress write door (hookless bus on
 *     state.db.call, preserveStamp — never mints a stamp, never kicks local sync rounds).
 *   - flushRoutes: buffer → manifest bulk-op mapping (manifest census-tied).
 *   - flushPendingWrites: per-op-isolated buffer drain with 2026-09-26 poison-row quarantine
 *     and the D18 retain-on-parking-failure contract.
 */

const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
// Phase-3 (docs/refactor-command-bus.md): buffer drain routes read their op from the manifest
// so the engine's bulk surfaces stay census-tied to the single command table. The engine still // applies rows DIRECTLY (peer-carried LWW stamps — see the gate's sync-ingress exemption for // this file); the manifest is used for dispatch naming only, never for stamping.
const manifest = require('./command-manifest')
// Arch review 2026-09-22 rec #1 (twin-door convergence): flush/ingress WRITE sites route // through an injected bus built on top of THIS state's db surface (createBus is exported for // exactly this). The bus's dbCall is state.db.call, so mock-driven unit suites keep their
// recording surface; the hookless instance preserves the ingress contract (no ls-mirror kick, // no local re-stamping — every write passes { preserveStamp: true }, which means the bus never // MINTS a stamp; an explicit stamp beyond the shared skew window is still clamped, mirroring // clampSkew's ingress normalization — see command-bus.js stampPayload).
const { createBus } = require('./command-bus')

// Manifest keys of the buffered bulk commands, in exact flush order (order is load-bearing: // todos first so a same-round todo+plan move lands coherently, tombstone-heavy buffers early). // opOf() throws on a manifest drift instead of silently skipping a buffer.
const FLUSH_ROUTE_COMMANDS = [ ['todos', 'todo.putMany'],
  ['settings', 'setting.putMany'],
  ['tomatoes', 'tomato.appendMany'],
  ['categories', 'category.putMany'],
  ['plans', 'plan.putMany'],
  ['filters', 'filter.putMany']
]
const flushRoutes = FLUSH_ROUTE_COMMANDS.map(([buf, cmd]) => {
  const row = manifest.COMMANDS[cmd]
  if (!row) throw new Error('[sync-apply] flush route missing from manifest: ' + cmd)
  return { buf, op: row.op, cmd }
})

/**
 * Arch review 2026-09-22 rec #1 (twin-door convergence): the per-state write door for this
 * file's flush/ingress writes. Builds a hookless bus on top of state.db.call (lazily, cached
 * on the state object — tests swap whole state objects) and routes every WRITE through
 * bus.commitOp(op, payload, { preserveStamp: true }): the manifest validates the op name,
 * the payload passes through with its wire-carried ages intact (preserveStamp never mints a
 * stamp; the bus's future-stamp clamp still guards the door — see stampPayload), and
 * no fanout hooks fire (ingress must not kick local sync rounds — this is peer data landing,
 * not a local user edit). Reads stay on state.db.call.
 */
function busFor (state) {
  if (!state.__bus) state.__bus = createBus((op, p) => state.db.call(op, p))
  return state.__bus
}

/** The one write helper for sync ingress: manifest-validated dispatch, payload untouched. */
function busWrite (state, op, payload) {
  return busFor(state).commitOp(op, payload, { preserveStamp: true })
}

/**
 * Flush the buffered bulk writes. Called after every ingested segment, after buildSnapshot-driven
 * replaceAll, and before the transport sends its round ack — a peer's push cursor may only advance
 * over rows that are already committed here (crash mid-buffer = rows unapplied, cursor stays, the
 * next round re-pushes; same crash semantics as commitSyncBatch §4.1).
 *
 * P0-1 (2026-09-19 data-safety round): the flush now REPORTS failure ({ ok: false }) instead of
 * only logging — the bootstrap propagates it as `flushFailed` on the ingestSegment result so the
 * receiver's ack stays BELOW the failed segment (the sender keeps its push watermark, re-pushes)
 * and the snapshot trigger force-arms. A dropped buffer must never be acked as applied.
 */
// 2026-09-26 poison-row quarantine: meta key prefix for rows a failed bulk flush had to drop.
// 'sync.*' is machine-local (isMachineLocalMetaKey), so quarantined copies never sync back to
// the peer — they are a LOCAL recovery surface, not a replay channel.
const META_FLUSH_QUARANTINE_PREFIX = 'sync.flushQuarantine.'
// Cap parked entries per op: quarantine is a crash-inspection surface, not a data store; the
// oplog/snapshot remains the authoritative recovery for large segments.
const META_FLUSH_QUARANTINE_CAP = 50
// W8 fix (2026-10-25): 20 lost every row past #20 of a poison batch — a segment-sized poison
// batch (PENDING_WRITES_CAP allows up to 5000 buffered rows) parked 4980 rows log-only with no
// recoverable copy. Match the buffer cap's order of magnitude (500 rows sampled, ~0.5MB worst
// case per entry), and the existing `truncated`/`omitted` marker keeps oversize batches honest.
const QUARANTINE_ROW_SAMPLE = 500

/** Safely encode one buffered row for the quarantine blob (a poison row may itself be
 *  un-JSON-able — BigInt, circular — so fall back to a string rendering). */
function quarantineEncodeRow (row) {
  try { return JSON.parse(JSON.stringify(row)) } catch {
    try { return String(row) } catch { return '[unrenderable row]' }
  }
}

/**
 * Park rows dropped by a failed bulk flush into a machine-local meta key
 * (`sync.flushQuarantine.<op>`): append to the existing list (cap-trimmed, newest kept) and
 * stamp each entry with the error and time. Best-effort: any failure here degrades to the old
 * log-only behavior (the original flush error is already reported by the caller).
 */
function quarantineFlushRows (state, op, list, err) {
  try {
    const key = META_FLUSH_QUARANTINE_PREFIX + op
    let parked = []
    try {
      const cur = state.db.call('getMeta', key)
      if (cur != null) { const p = JSON.parse(cur); if (Array.isArray(p)) parked = p }
    } catch { /* unreadable prior blob: start a fresh list rather than failing the quarantine */ }
    parked.push({ at: Date.now(), count: list.length, error: (err && err.message) || String(err), rows: [...list.slice(0, QUARANTINE_ROW_SAMPLE).map(quarantineEncodeRow), ...(list.length > QUARANTINE_ROW_SAMPLE ? [{ truncated: true, omitted: list.length - QUARANTINE_ROW_SAMPLE }] : [])] })
    while (parked.length > META_FLUSH_QUARANTINE_CAP) parked.shift()
    // Route through the bus facade like every other sync write (single-write-gate): the
    // quarantine meta blob is machine-local, but the write must still be manifest-validated.
    busWrite(state, 'setMeta', [key, JSON.stringify(parked)])
    return { op, key, count: list.length }
  } catch (e) {
    log.warn('[LanSync] flush quarantine parking failed (log-only drop):', e && e.message)
    return null
  }
}

// F4 fix (2026-10-15): the buffered segments are RETAINED while both the flush and the quarantine
// parking keep failing (D18), and every later ingest keeps pushing rows on top — an unbounded
// growth window (long failure stretch = OOM). Cap each buffer at 5000 rows: far above any single
// legitimate ingest segment (segments are ack-sized, tens of rows), yet bounds worst-case memory
// to a few MB per op. Dropping is safe under the SAME contract as the poison-row quarantine: the
// sender's watermark stays BELOW the dropped rows (they were never acked), so the next round
// re-pushes them, and the oplog/snapshot remains the authoritative recovery surface. Oldest rows
// are dropped first (shift-side) so the freshest data stays buffered.
const PENDING_WRITES_CAP = 5000

/** Trim each pendingWrites buffer to PENDING_WRITES_CAP, dropping the OLDEST rows when over.
 *  Called at flush entry (flush runs after every ingested segment, so growth between calls is
 *  bounded); every drop is log.error'd — silent data loss is forbidden. */
function capPendingWrites (state) {
  if (!state.pendingWrites) return
  for (const r of flushRoutes) {
    const list = state.pendingWrites[r.buf]
    if (Array.isArray(list) && list.length > PENDING_WRITES_CAP) {
      const dropped = list.length - PENDING_WRITES_CAP
      state.pendingWrites[r.buf] = list.slice(dropped)
      log.error(`[LanSync] pendingWrites.${r.buf} exceeded cap ${PENDING_WRITES_CAP} — DROPPED ${dropped} oldest buffered rows (flush/quarantine stalled; rows were never acked, the peer re-pushes them next round; snapshot remains the recovery surface)`)
    }
  }
}

function flushPendingWrites (state) {
  capPendingWrites(state) // F4: bound the retained-buffer growth before draining
  const buf = state.pendingWrites
  let ok = true
  const quarantined = []
  // Per-buffer-op isolation (round-3 review): ONE malformed row used to throw out of a single
  // bulk op and leave every buffer dirty — the throw re-fired on every later flush, wedging
  // apply AND flush forever (poison-pill row). Now each op gets its own try/catch: a failing op
  // drops only ITS buffer segment with log.error (the data stays in the oplog, so it remains
  // recoverable via a later snapshot), the buffers clear either way, and the other ops proceed.
  // Manifest-driven drain (Phase-3): buffer → bulk op mapping lives in flushRoutes (derived from
  // command-manifest.js at module load), so a buffer cannot silently lose its manifest census row.
  // 2026-09-26 stalled-watermark fix (Layer 1): a failing op whose rows were SUCCESSFULLY
  // quarantined no longer sets ok=false. Previously ok=false made ingestSegment stamp
  // flushFailed, the ack stayed below the segment, the sender kept its push watermark and
  // re-pushed the SAME segment — including the same poison row — every round: a permanent
  // stall (watermark pinned forever, appliedToSeq never advanced in the sender's seq space).
  // That is safe only while the drop is unrecoverable. With poison-row quarantine the dropped
  // rows are parked under sync.flushQuarantine.<op> (machine-local meta, user-surfaced via
  // Device Center), so the recovery invariant holds WITHOUT blocking the ack: remaining ops
  // commit, the round acks with appliedToSeq, and the peer's watermark advances past the
  // poison row. ok=false is reserved for the case where QUARANTINE PARKING ITSELF failed
  // (rows truly dropped log-only) — that degrades to the old fail-closed behavior.
  const flushOne = (list, op) => {
    if (!list || !list.length) return
    let result = null
    try { result = busWrite(state, op, list) } catch (e) {
      log.error(`[LanSync] flush ${op} failed — dropping ${list.length} buffered rows (quarantined under ${META_FLUSH_QUARANTINE_PREFIX}${op}, recoverable via snapshot):`, e && e.message)
      // 2026-09-26 poison-row quarantine: a dropped buffer used to be log-only ("recoverable via
      // snapshot" = the ONLY recovery, and only if a snapshot actually re-fires). Park the rows in
      // a machine-local meta key (sync.* never syncs — isMachineLocalMetaKey) so they stay
      // inspectable/recoverable, and surface the quarantine on the flush result so the bootstrap
      // can raise a Device Center syncEvent instead of failing silently.
      const entry = quarantineFlushRows(state, op, list, e)
      if (entry) quarantined.push(entry)
      else { ok = false; return false } // D18: parking failed — caller RETAINS the buffer segment
    }
    // D13 finding 3 (per-row rejection quarantine): the bulk ops no longer drop rows silently —
    // settingsRowPutMany / planAddMany / tomatoAppendMany surface their skipped rows as a
    // `rejected` list (settingsRowPutMany/planAddMany attach it to the returned accepted array
    // non-enumerably; tomatoAppendMany returns {accepted, rejected}). The old code discarded the
    // result: rejected rows vanished, the buffer segment still cleared and the segment acked
    // ok=true — the sender's watermark advanced past rows that never landed, permanently lost
    // with zero user-visible trace. Park the rejected rows in the same machine-local quarantine
    // the throw path uses and surface them on the flush result (flush-quarantined syncEvent).
    const rejected = result && Array.isArray(result.rejected) ? result.rejected : []
    if (rejected.length) {
      log.error(`[LanSync] flush ${op}: ${rejected.length} of ${list.length} rows rejected by the bulk op — quarantined under ${META_FLUSH_QUARANTINE_PREFIX}${op}`)
      const err = new Error('per-row rejection: ' + rejected.map(r => (r && r.reason) || 'unknown').join('; ').slice(0, 300))
      const entry = quarantineFlushRows(state, op, rejected.map((r, i) => ({ ...list[r && r.index != null ? r.index : i], __rejectReason: (r && r.reason) || 'unknown' })), err)
      if (entry) quarantined.push(entry)
      else { ok = false; return false } // D18: parking failed — caller RETAINS the buffer segment
    }
    return true
  }
  for (const r of flushRoutes) {
    // D18 (2026-10-02): the buffer segment used to clear UNCONDITIONALLY — when BOTH the bulk
    // write AND quarantine parking failed, the rows were silently destroyed (silent row loss
    // behind a flushFailed ack). Retain the segment for the next flush attempt instead; the
    // throw path already logged loudly, so keep one explicit retain trace here.
    if (flushOne(buf[r.buf], r.op) !== false) buf[r.buf] = []
    else log.error(`[LanSync] flush ${r.op}: quarantine parking failed — ${buf[r.buf].length} buffered rows RETAINED for retry (silent drop avoided)`)
  }
  // Coalesced remote-announce fan-out (P2 2026-09-20): one emit per committed ingest pass
  // instead of one per announce row. Runs even when a bulk flush failed above — the meta rows
  // were already committed via setMeta before buffering.
  if (state.pendingAnnounces && state.pendingAnnounces.size) {
    const ta = require('./tomato-announce')
    for (const [key, value] of state.pendingAnnounces) {
      try { ta.emitRemoteAnnounce(key, value) } catch (e) { log.warn('[LanSync] announce emit failed:', e.message) }
    }
    state.pendingAnnounces = null
  }
  return { ok, quarantined } // P0-1: false = at least one bulk op threw; the segment must not be acked
}

module.exports = {
  busFor,
  busWrite,
  flushRoutes,
  // 2026-09-26 poison-row quarantine: where a failed flush parks its dropped rows.
  META_FLUSH_QUARANTINE_PREFIX,
  QUARANTINE_ROW_SAMPLE,
  PENDING_WRITES_CAP,
  capPendingWrites,
  flushPendingWrites,
}
