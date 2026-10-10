/* Sync v2 write-path integration (design doc docs/sync-v2-core-design.md step 3).
 * Records one immutable revision per successful write op into sync_revisions, behind
 * the settings flag sync.revisions.v2 (default OFF — v1 LAN sync keeps running until
 * the flag is flipped). Payload = the row content AT WRITE TIME, read in the same
 * call — never re-read later (that was the v1 oplog defect, P1-2).
 *
 * Causality: parents = [entity's current revision]. Remote-merge heads live in the
 * sync engine (causality/merge.mjs); the recorder only authors the local line.
 * Child-HLC > parent-HLC is guaranteed by receiving the parent stamp into the
 * persisted clock before every tick (spec §6 rule 2).
 *
 * DVV layer (S2, opt-in twice over): when BOTH sync.revisions.v2 and the sub-flag
 * sync.revisions.v2.dvv are on, every recorded revision also mints + persists a
 * dotted version vector (shared/sync-core/causality/dvv.mjs) into a SEPARATE side
 * table sync_revision_dvv — created lazily here, never in the migration ladder.
 * Flag-off footprint is ZERO: no table, no rows, no counter, byte-identical v8
 * schema behavior. Dots are minted with the same pure semantics as the in-memory
 * engine (mergeContexts/nextDvv); the per-device dot counter is persisted in the
 * SAME transaction as the dvv rows (crash can never orphan a dot) and re-loaded
 * with a belt-and-braces max-scan over the device's own persisted dots, so a
 * restart never reuses a counter (the HLC restore contract, mirrored for DVV).
 * Read side: exportToStore()/list() attach persisted dvv when the table exists;
 * rows without dvv (pre-DVV data) stay dvv-less → the engine's expand() returns
 * null → 'unknown' → the parent-graph ancestry fallback applies unchanged.
 *
 * Failure contract: mirrors appendOplog — a throw here must never fail an
 * already-committed business write; the caller wraps and reports.
 */

const { Hlc, cmpHlc } = require('../../shared/sync-core/clock/hlc.mjs')
const { createEnvelope, hashPayload } = require('../../shared/sync-core/revision/envelope.mjs')
const { mergeContexts, nextDvv } = require('../../shared/sync-core/causality/dvv.mjs')
const { createRevisionStore, applyEnvelope } = require('../../shared/sync-core/causality/merge.mjs')

const FLAG_KEY = 'sync.revisions.v2'
const HLC_KEY = 'sync.hlc'
// S2 DVV sub-flag + persistence surfaces. All DVV state lives behind the base flag:
// the sub-flag alone never turns anything on.
const DVV_FLAG_KEY = 'sync.revisions.v2.dvv'
// S4: delete-vs-edit adjudication sub-flag (user-visible rulings; consumed by sync-adjudicate.js).
const ADJUDICATE_FLAG_KEY = 'sync.revisions.v2.adjudicate'
const DVV_COUNTER_KEY = 'sync.dvvCounter'
const DVV_TABLE = 'sync_revision_dvv'

// Payload retention (leak-sync-revisions-no-gc): every recorded write stores the full row JSON
// into sync_revision_payloads; superseded payloads were never removed, so a long-lived flag-on
// database grew the table without bound (full row content per edit, forever). Retention keeps
// payloads for the CURRENT revision of each entity (live materialization) plus the newest
// REVISION_PAYLOAD_KEEP revisions by HLC (recent concurrency window for merge/conflict
// resolution); older non-current payloads are pruned while their sync_revisions rows stay as
// ancestry-only lines — exportToStore already skips pruned payloads by design.
const REVISION_PAYLOAD_KEEP = 2000
// Hysteresis: prune only once the table exceeds keep * 1.25 so we don't re-scan on every write.
const payloadKeep = () => {
  const v = Number(process.env.TODO_REVISION_PAYLOAD_KEEP)
  return Number.isInteger(v) && v > 10 ? v : REVISION_PAYLOAD_KEEP
}

/** entity (oplog space) -> table + id column for write-time row reads. */
const READERS = {
  todo: { table: 'todos', id: 'id' },
  settings_row: { table: 'settings_rows', id: 'key' },
  category: { table: 'categories', id: 'id' },
  filter: { table: 'filters', id: 'id' },
  plan: { table: 'plan_chips', id: 'id' },
  tomato: { table: 'tomato_records', id: 'id' },
}

module.exports = function createRevisionRecorder ({ getDb, log }) {
  let clock = null
  let clockNodeId = null
  // S2 DVV: per-handle cache for the lazy table probe and the persisted dot counter
  // (re-probed after every db re-open; the handle object identity is the cache key).
  let dvvTableCache = { handle: null, exists: false }
  let dvvCounterCache = { handle: null, nodeId: null, counter: 0 }

  function flagEnabled (d) {
    const row = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(FLAG_KEY)
    return !!(row && String(row.value) === '1')
  }

  function dvvFlagEnabled (d) {
    const row = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(DVV_FLAG_KEY)
    return !!(row && String(row.value) === '1')
  }

  function adjudicateFlagEnabled (d) {
    const row = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(ADJUDICATE_FLAG_KEY)
    return !!(row && String(row.value) === '1')
  }

  /** Probe-guarded existence check (mirror migration v7's re-run tolerance): the side
   *  table is created lazily by THIS module when the dvv flag first needs it, never by
   *  the schema/migration ladder, so a flag-off database has zero DVV footprint. */
  function dvvTableExists (d) {
    if (dvvTableCache.handle === d) return dvvTableCache.exists
    let ok = false
    try {
      ok = !!d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(DVV_TABLE)
    } catch { ok = false }
    dvvTableCache = { handle: d, exists: ok }
    return ok
  }

  function ensureDvvTable (d) {
    if (dvvTableExists(d)) return
    d.exec(`CREATE TABLE IF NOT EXISTS ${DVV_TABLE} (
      revisionId TEXT PRIMARY KEY,
      dvv TEXT NOT NULL
    )`)
    dvvTableCache = { handle: d, exists: true }
  }

  /** Load the persisted local dot counter, floored by a belt-and-braces max-scan of this
   *  device's own persisted dots (the counter row and the dvv rows commit in ONE transaction,
   *  so they cannot legally diverge — the scan only defends against external tampering, the
   *  same posture as clock.restore's corrupt-snapshot tolerance). Cached per nodeId; reloaded
   *  when the device id changes. */
  function loadDvvCounter (d, nodeId) {
    if (dvvCounterCache.handle === d && dvvCounterCache.nodeId === nodeId) return dvvCounterCache.counter
    let saved = 0
    try {
      const r = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(DVV_COUNTER_KEY)
      saved = Number(r && r.value) || 0
    } catch { saved = 0 }
    let observed = 0
    if (dvvTableExists(d)) {
      try {
        const rows = d.prepare(`SELECT dvv FROM ${DVV_TABLE} JOIN sync_revisions USING (revisionId) WHERE authorDeviceId = ?`).all(nodeId)
        for (const row of rows) {
          const c = parseOrSkip(row.dvv, 'dvv during counter scan')
          if (!c || !c.dot || c.dot.deviceId !== nodeId) continue
          if (Number.isSafeInteger(c.dot.counter) && c.dot.counter > observed) observed = c.dot.counter
        }
      } catch { /* scan is best-effort; the persisted counter governs */ }
    }
    const counter = Math.max(Number.isSafeInteger(saved) && saved > 0 ? saved : 0, observed)
    dvvCounterCache = { handle: d, nodeId, counter }
    return counter
  }

  function saveDvvCounter (d, counter) {
    d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(DVV_COUNTER_KEY, String(counter))
  }

  function loadClock (d) {
    const idRow = d.prepare("SELECT value FROM settings_rows WHERE key = 'sync.deviceId'").get()
    const nodeId = (idRow && idRow.value) ? String(idRow.value) : 'local-unsigned'
    if (!clock || clockNodeId !== nodeId) {
      clock = new Hlc(nodeId)
      clockNodeId = nodeId
      const saved = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(HLC_KEY)
      if (saved) { try { clock.restore(JSON.parse(saved.value)) } catch { /* corrupt stamp: fresh clock still monotone within process */ } }
    }
    return clock
  }

  function saveClock (d) {
    d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(HLC_KEY, JSON.stringify(clock.snapshot()))
  }

  function readRow (d, entity, entityId) {
    const r = READERS[entity]
    if (!r) return null
    try {
      return d.prepare(`SELECT * FROM ${r.table} WHERE ${r.id} = ?`).get(entityId) || null
    } catch { return null }
  }

  /** Tombstone payload when the row is gone (hardDelete captured the pointer but
   *  the physical row is already removed). */
  const tombstone = ts => ({ deleted: true, deletedAt: ts })

  function record (pointers) {
    if (!pointers || !pointers.length) return { recorded: 0 }
    const d = getDb()
    if (!d || !d.open) return { recorded: 0 }
    if (!flagEnabled(d)) return { recorded: 0, disabled: true }
    const cl = loadClock(d)
    // S2: DVV minting is opt-in via the sub-flag; OFF → byte-identical legacy behavior.
    const useDvv = dvvFlagEnabled(d)
    if (useDvv) ensureDvvTable(d)
    const nodeId = clockNodeId || 'local-unsigned'
    const dvvCounterAtStart = useDvv ? loadDvvCounter(d, nodeId) : 0
    const insertRev = d.prepare(`INSERT INTO sync_revisions
      (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    const insertPayload = d.prepare('INSERT INTO sync_revision_payloads (revisionId, payload) VALUES (?, ?)')
    const bumpCurrent = d.prepare('INSERT INTO sync_revision_current (entityId, revisionId) VALUES (?, ?) ON CONFLICT(entityId) DO UPDATE SET revisionId = excluded.revisionId')
    const getCurrent = d.prepare('SELECT revisionId FROM sync_revision_current WHERE entityId = ?')
    const getParentDvv = useDvv ? d.prepare(`SELECT dvv FROM ${DVV_TABLE} WHERE revisionId = ?`) : null
    const insertDvv = useDvv ? d.prepare(`INSERT INTO ${DVV_TABLE} (revisionId, dvv) VALUES (?, ?)`) : null

    let recorded = 0
    let dvvCounter = dvvCounterAtStart
    const run = d.transaction(() => {
      for (const ptr of pointers) {
        if (!ptr || ptr.entityId === '*gc*') continue
        const row = readRow(d, ptr.entity, ptr.entityId)
        const payload = row || tombstone(ptr.ts)
        // receive the parent stamp before ticking: child > parent is structural (spec §6 rule 2)
        const cur = getCurrent.get(ptr.entityId)
        const parentIds = []
        const parentDvvContexts = []
        if (cur) {
          const parent = d.prepare('SELECT * FROM sync_revisions WHERE revisionId = ?').get(cur.revisionId)
          if (parent) {
            clock.receive({ physical: parent.hlcPhysical, logical: parent.hlcLogical, nodeId: parent.authorDeviceId })
            parentIds.push(parent.revisionId)
            // S2: the child's DVV context covers every known parent dot — pure semantics
            // identical to the engine's localDvv (mergeContexts/nextDvv from dvv.mjs).
            // expand() in the engine folds the parent's OWN dot into its vector, so the
            // persisted parent context must be folded with its dot here too — without it
            // the child would not dominate its parent (context-only merge classifies them
            // concurrent instead of descendant).
            if (useDvv && getParentDvv) {
              const pd = getParentDvv.get(parent.revisionId)
              if (pd) {
                const parsed = parseOrSkip(pd.dvv, 'dvv of parent ' + parent.revisionId)
                if (parsed && parsed.context) {
                  const ctx = { ...parsed.context }
                  if (parsed.dot && parsed.dot.deviceId) {
                    ctx[parsed.dot.deviceId] = Math.max(ctx[parsed.dot.deviceId] || 0, parsed.dot.counter || 0)
                  }
                  parentDvvContexts.push(ctx)
                }
              }
            }
          }
        }
        let dvv
        if (useDvv) {
          const next = nextDvv(nodeId, dvvCounter, mergeContexts(parentDvvContexts))
          dvvCounter = next.dot.counter
          dvv = next
        }
        const env = createEnvelope({ entity: ptr.entity, entityId: ptr.entityId, hlc: cl.tick(), parents: parentIds, payload, dvv })
        insertRev.run(env.revisionId, ptr.entity, ptr.entityId, env.authorDeviceId, env.hlc.physical, env.hlc.logical, JSON.stringify(env.parents), env.payloadHash, Date.now())
        insertPayload.run(env.revisionId, JSON.stringify(env.payload))
        if (useDvv && dvv) insertDvv.run(env.revisionId, JSON.stringify(dvv))
        bumpCurrent.run(ptr.entityId, env.revisionId)
        recorded++
      }
      saveClock(d)
      // S2: the dot counter commits in the SAME transaction as the dvv rows — a crash can
      // never persist a dot whose counter the next boot would re-mint (restart monotonicity).
      if (useDvv) saveDvvCounter(d, dvvCounter)
    })
    run()
    if (useDvv) dvvCounterCache = { handle: d, nodeId, counter: dvvCounter }
    // perf-sync-revisions-prune-inline-write-stall (P3, symptom of "v2 write path does synchronous
    // maintenance inline"): the prune (per-write COUNT + bulk DELETE) used to run inside record(),
    // stalling every write behind maintenance work. It already runs strictly AFTER the commit, and
    // exportToStore tolerates pruned payloads (ancestry-only rows are skipped), so deferring it to
    // setImmediate keeps the write hot path clean without changing retention semantics.
    setImmediate(() => prunePayloads(d))
    return { recorded }
  }

  /** Retention GC: drop payloads of non-current revisions outside the recent-keep window.
   *  Never throws into the write path — a failed prune only means one more cycle of growth. */
  const PRUNE_CHUNK = 2000
  function prunePayloads (d) {
    const keep = payloadKeep()
    try {
      const n = d.prepare('SELECT COUNT(*) n FROM sync_revision_payloads').get().n
      if (n <= keep + Math.floor(keep / 4)) return 0
      // Chunked so even a deferred prune of a very large backlog stays bounded per statement.
      const del = d.prepare(`DELETE FROM sync_revision_payloads WHERE revisionId IN (
        SELECT p.revisionId FROM sync_revision_payloads p
        JOIN sync_revisions r ON r.revisionId = p.revisionId
        WHERE p.revisionId NOT IN (SELECT revisionId FROM sync_revision_current)
          AND p.revisionId NOT IN (
            SELECT revisionId FROM sync_revisions ORDER BY hlcPhysical DESC, hlcLogical DESC LIMIT ?
          )
        LIMIT ?
      )`)
      let total = 0
      let changes
      do {
        changes = del.run(keep, PRUNE_CHUNK).changes
        total += changes
      } while (changes >= PRUNE_CHUNK)
      return total
    } catch (e) {
      log && log.warn && log.warn('[db-revisions] payload prune failed (non-fatal): ' + (e && e.message))
      return 0
    }
  }

  // D21 (P2 2026-10-02): one torn JSON row (crash mid-write, external tooling) used to throw out
  // of list()/exportToStore and kill the WHOLE export. Failure granularity is per-ROW (mirror the
  // clock.restore policy above): parse defensively, skip the torn row, count and log it.

  function parseOrSkip (raw, what) {
    try { return JSON.parse(raw) } catch (e) {

      log && log.warn && log.warn(`[db-revisions] skipping torn JSON ${what} (row skipped): ` + (e && e.message))
      return null
    }
  }

  /** DVV rows keyed by revisionId, or null when the side table does not exist (pre-DVV
   *  database / flag never enabled): absence is the old-data fallback, never an error. */
  function loadDvvMap (d) {
    if (!dvvTableExists(d)) return null
    try {
      return new Map(d.prepare(`SELECT revisionId, dvv FROM ${DVV_TABLE}`).all().map(r => [r.revisionId, r.dvv]))
    } catch (e) {
      log && log.warn && log.warn('[db-revisions] dvv table unreadable, exporting without dvv (non-fatal): ' + (e && e.message))
      return null
    }
  }

  /** Introspection for tests / Device Center visibility. */
  function list (entityId, limit = 50) {
    const d = getDb()
    if (!d || !d.open) return []
    const rows = entityId
      ? d.prepare('SELECT * FROM sync_revisions WHERE entityId = ? ORDER BY hlcPhysical, hlcLogical LIMIT ?').all(String(entityId), limit)
      : d.prepare('SELECT * FROM sync_revisions ORDER BY hlcPhysical, hlcLogical LIMIT ?').all(limit)
    const dvvs = loadDvvMap(d)
    const out = []
    for (const r of rows) {
      const parents = parseOrSkip(r.parents || '[]', 'parents for ' + r.revisionId)
      if (!parents) continue // torn row: skip, keep the rest of the export alive
      let dvv
      if (dvvs && dvvs.has(r.revisionId)) {
        const parsed = parseOrSkip(dvvs.get(r.revisionId), 'dvv for ' + r.revisionId)
        if (parsed) dvv = parsed // torn dvv JSON: attach nothing, the row still exports
      }
      out.push({
        revisionId: r.revisionId, entity: r.entity, entityId: r.entityId,
        hlc: { physical: r.hlcPhysical, logical: r.hlcLogical, nodeId: r.authorDeviceId },
        parents, payloadHash: r.payloadHash, status: r.status,
        ...(dvv ? { dvv } : {}),
      })
    }
    return out
  }

  /**
   * Load the full local DAG into a sync-core store (test/bootstrap bridge).
   * S2 read adapter: the store is created with { useDvv } only when BOTH flags are on
   * (same double opt-in as the write path — one sub-flag flip back and the read side is
   * byte-identical legacy again); persisted dvv attaches to envelopes whenever present,
   * and is inert while store.useDvv is false. opts.useDvv forces the store option for
   * tests/engine callers that own the decision.
   */
  function exportToStore (createStore, applyEnvelopeFn, opts = {}) {
    const d = getDb()
    if (!d || !d.open) return null
    const useDvv = opts.useDvv !== undefined ? !!opts.useDvv : (flagEnabled(d) && dvvFlagEnabled(d))
    const store = createStore(clockNodeId || 'local', { useDvv })
    const rows = d.prepare('SELECT * FROM sync_revisions ORDER BY hlcPhysical, hlcLogical').all()
    const payloads = new Map(d.prepare('SELECT revisionId, payload FROM sync_revision_payloads').all().map(p => [p.revisionId, p.payload]))
    const dvvs = loadDvvMap(d)
    for (const r of rows) {
      const payloadJson = payloads.get(r.revisionId)
      if (payloadJson == null) continue // pruned payload: ancestry-only row
      const parents = parseOrSkip(r.parents || '[]', 'parents for ' + r.revisionId)
      const payload = parents !== null ? parseOrSkip(payloadJson, 'payload for ' + r.revisionId) : null
      if (!parents || payload == null) continue // torn row: skip, keep the rest of the DAG alive
      let dvv
      if (dvvs && dvvs.has(r.revisionId)) {
        const parsed = parseOrSkip(dvvs.get(r.revisionId), 'dvv for ' + r.revisionId)
        if (parsed) dvv = parsed // torn dvv JSON: attach nothing — expand() falls back to 'unknown'
      }
      applyEnvelopeFn(store, {
        revisionId: r.revisionId, entity: r.entity, entityId: r.entityId,
        authorDeviceId: r.authorDeviceId,
        hlc: { physical: r.hlcPhysical, logical: r.hlcLogical, nodeId: r.authorDeviceId },
        parents, payloadHash: r.payloadHash,
        payload,
        ...(dvv ? { dvv } : {}),
      })
    }
    return store
  }

  /** No-arg store snapshot over the REAL sync-core store engine (main-internal read seam,
   *  exposed as the read-only `revisionsStoreSnapshot` db op). This is the unified causal
   *  read entry: the receiver classifies inbound envelopes against THIS snapshot via
   *  dvvRelation/applyEnvelope — never against ad-hoc row reads. */
  function exportStore () {
    return exportToStore(createRevisionStore, applyEnvelope)
  }

  /** Sort-key check used by tests: payload hash matches the canonical hash. */
  function verifyHash (revisionId) {
    const d = getDb()
    if (!d || !d.open) return false
    const r = d.prepare('SELECT payloadHash FROM sync_revisions WHERE revisionId = ?').get(revisionId)
    const p = d.prepare('SELECT payload FROM sync_revision_payloads WHERE revisionId = ?').get(revisionId)
    if (!r || !p) return false
    const payload = parseOrSkip(p.payload, 'payload for ' + revisionId)
    if (payload == null) return false // torn row: cannot verify, do not throw
    return r.payloadHash === hashPayload(payload)
  }

  /** Introspection: persisted dot counter + max dot observed for this device (tests and
   *  future Device Center visibility). Read-only; never throws into callers. */
  function dvvState () {
    const d = getDb()
    if (!d || !d.open) return { table: false, counter: 0, maxDot: 0 }
    const nodeId = clockNodeId || 'local-unsigned'
    const persisted = loadDvvCounter(d, nodeId)
    let maxDot = 0
    if (dvvTableExists(d)) {
      try {
        for (const row of d.prepare(`SELECT dvv FROM ${DVV_TABLE} JOIN sync_revisions USING (revisionId) WHERE authorDeviceId = ?`).all(nodeId)) {
          const c = parseOrSkip(row.dvv, 'dvv in dvvState')
          if (c && c.dot && c.dot.deviceId === nodeId && Number.isSafeInteger(c.dot.counter) && c.dot.counter > maxDot) maxDot = c.dot.counter
        }
      } catch { /* read-only introspection */ }
    }
    return { table: dvvTableExists(d), counter: persisted, maxDot }
  }

  return {
    record, list, exportToStore, exportStore, verifyHash,
    flagEnabled, dvvFlagEnabled, adjudicateFlagEnabled, ensureDvvTable, dvvTableExists, dvvState,
    FLAG_KEY, DVV_FLAG_KEY, ADJUDICATE_FLAG_KEY, DVV_TABLE,
    cmpHlc, prunePayloads, payloadKeep,
  }
}
