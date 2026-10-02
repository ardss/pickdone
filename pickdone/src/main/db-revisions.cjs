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
 * Failure contract: mirrors appendOplog — a throw here must never fail an
 * already-committed business write; the caller wraps and reports.
 */

const { Hlc, cmpHlc } = require('../../shared/sync-core/clock/hlc.mjs')
const { createEnvelope, hashPayload } = require('../../shared/sync-core/revision/envelope.mjs')

const FLAG_KEY = 'sync.revisions.v2'
const HLC_KEY = 'sync.hlc'

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

  function flagEnabled (d) {
    const row = d.prepare('SELECT value FROM settings_rows WHERE key = ?').get(FLAG_KEY)
    return !!(row && String(row.value) === '1')
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
    const insertRev = d.prepare(`INSERT INTO sync_revisions
      (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    const insertPayload = d.prepare('INSERT INTO sync_revision_payloads (revisionId, payload) VALUES (?, ?)')
    const bumpCurrent = d.prepare('INSERT INTO sync_revision_current (entityId, revisionId) VALUES (?, ?) ON CONFLICT(entityId) DO UPDATE SET revisionId = excluded.revisionId')
    const getCurrent = d.prepare('SELECT revisionId FROM sync_revision_current WHERE entityId = ?')

    let recorded = 0
    const run = d.transaction(() => {
      for (const ptr of pointers) {
        if (!ptr || ptr.entityId === '*gc*') continue
        const row = readRow(d, ptr.entity, ptr.entityId)
        const payload = row || tombstone(ptr.ts)
        // receive the parent stamp before ticking: child > parent is structural (spec §6 rule 2)
        const cur = getCurrent.get(ptr.entityId)
        const parentIds = []
        if (cur) {
          const parent = d.prepare('SELECT * FROM sync_revisions WHERE revisionId = ?').get(cur.revisionId)
          if (parent) {
            clock.receive({ physical: parent.hlcPhysical, logical: parent.hlcLogical, nodeId: parent.authorDeviceId })
            parentIds.push(parent.revisionId)
          }
        }
        const env = createEnvelope({ entity: ptr.entity, entityId: ptr.entityId, hlc: cl.tick(), parents: parentIds, payload })
        insertRev.run(env.revisionId, ptr.entity, ptr.entityId, env.authorDeviceId, env.hlc.physical, env.hlc.logical, JSON.stringify(env.parents), env.payloadHash, Date.now())
        insertPayload.run(env.revisionId, JSON.stringify(env.payload))
        bumpCurrent.run(ptr.entityId, env.revisionId)
        recorded++
      }
      saveClock(d)
    })
    run()
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

  /** Introspection for tests / Device Center visibility. */
  function list (entityId, limit = 50) {
    const d = getDb()
    if (!d || !d.open) return []
    const rows = entityId
      ? d.prepare('SELECT * FROM sync_revisions WHERE entityId = ? ORDER BY hlcPhysical, hlcLogical LIMIT ?').all(String(entityId), limit)
      : d.prepare('SELECT * FROM sync_revisions ORDER BY hlcPhysical, hlcLogical LIMIT ?').all(limit)
    return rows.map(r => ({
      revisionId: r.revisionId, entity: r.entity, entityId: r.entityId,
      hlc: { physical: r.hlcPhysical, logical: r.hlcLogical, nodeId: r.authorDeviceId },
      parents: JSON.parse(r.parents || '[]'), payloadHash: r.payloadHash, status: r.status,
    }))
  }

  /** Load the full local DAG into a sync-core store (test/bootstrap bridge). */
  function exportToStore (createStore, applyEnvelopeFn) {
    const d = getDb()
    if (!d || !d.open) return null
    const store = createStore(clockNodeId || 'local')
    const rows = d.prepare('SELECT * FROM sync_revisions ORDER BY hlcPhysical, hlcLogical').all()
    const payloads = new Map(d.prepare('SELECT revisionId, payload FROM sync_revision_payloads').all().map(p => [p.revisionId, p.payload]))
    for (const r of rows) {
      const payloadJson = payloads.get(r.revisionId)
      if (payloadJson == null) continue // pruned payload: ancestry-only row
      applyEnvelopeFn(store, {
        revisionId: r.revisionId, entity: r.entity, entityId: r.entityId,
        authorDeviceId: r.authorDeviceId,
        hlc: { physical: r.hlcPhysical, logical: r.hlcLogical, nodeId: r.authorDeviceId },
        parents: JSON.parse(r.parents || '[]'), payloadHash: r.payloadHash,
        payload: JSON.parse(payloadJson),
      })
    }
    return store
  }

  /** Sort-key check used by tests: payload hash matches the canonical hash. */
  function verifyHash (revisionId) {
    const d = getDb()
    if (!d || !d.open) return false
    const r = d.prepare('SELECT payloadHash FROM sync_revisions WHERE revisionId = ?').get(revisionId)
    const p = d.prepare('SELECT payload FROM sync_revision_payloads WHERE revisionId = ?').get(revisionId)
    if (!r || !p) return false
    return r.payloadHash === hashPayload(JSON.parse(p.payload))
  }

  return { record, list, exportToStore, verifyHash, flagEnabled, FLAG_KEY, cmpHlc, prunePayloads, payloadKeep }
}
