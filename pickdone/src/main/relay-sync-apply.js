'use strict'
/**
 * Relay pull-side materialization (Sync v2, 2026-10-10) — turns VERIFIED inbound relay
 * envelopes into durable local state. Closes the business gap where device B's pull
 * merged into the EPHEMERAL sync-core store only: the cursor advanced and acked, the
 * frames never re-arrived, and neither the local revision DAG nor the business tables
 * ever saw the content — silent loss behind a green cursor on every restart.
 *
 * Pipeline per pull round (called from the relay adapter via the bootstrap wiring,
 * strictly BEFORE the durable cursor commit — spec §18 download → verify → merge →
 * persist → advance):
 *   1. DAG ingest (db-revisions ingestRemote, ONE transaction, idempotent INSERT OR
 *      IGNORE by revisionId): the received history becomes part of B's causal graph so
 *      a later local edit parents onto the remote head (spec §6 rule 2) and a restart
 *      rebuilds a complete store. Current-pointer bumps mirror the engine's own merge
 *      decision and never regress past a concurrent local write.
 *   2. Business materialization through the SANCTIONED v1 apply pipeline
 *      (sync-apply applyRowSafe → buffered bulk flush): every battle-tested guard
 *      applies — skew clamp, LWW against the local row, tombstone/ghost guards,
 *      conflict-copy minting, identical-content no-op. Remote content NEVER reaches
 *      SQL raw. Scope this slice: entity 'todo' (live rows AND tombstones) — the task's
 *      declared business gap; other entities stay DAG-only until their per-entity
 *      hot-apply folds are wired (same boundary the v1 bootstrap draws with
 *      consumeAppliedRound).
 *
 * Failure contract: any throw propagates into the adapter round → lastError → the
 * durable cursor/pushed-set state is NOT committed → the next round replays the same
 * frames (duplicate-safe by revisionId PK and by LWW no-ops). Business flush reports
 * { ok: false } only when quarantine parking failed too — that also throws (dropped
 * rows must never be acked as applied).
 */

const syncApply = require('./sync-apply')
const { rowToTodo } = require('./db-rows')

let log = null
function logger () {
  if (!log) { try { log = require('electron-log') } catch { log = { warn () {}, info () {} } } }
  return log
}

/**
 * Map one verified envelope (revision space, payload = the raw row JSON captured at
 * write time) onto a v1 merge-ready wire row. Returns null for entities this slice
 * does not materialize (they still DAG-ingest in applyPulledEnvelopes).
 * Tombstone payloads ({deleted, deletedAt} with no row content) and raw rows with
 * deleted=1 hydrate EXACTLY like the v1 egress does (hydrateRow): deleted wire rows
 * carry data:null so the merge's delete-wins rules see the same shapes.
 */
function envelopeToWireRow (env) {
  if (!env || env.entity !== 'todo' || env.entityId == null) return null
  const p = (env.payload && typeof env.payload === 'object') ? env.payload : null
  const hlcTs = (env.hlc && Number.isFinite(env.hlc.physical)) ? env.hlc.physical : 0
  const deleted = !!(p && (p.deleted === 1 || p.deleted === true))
  const deletedAt = (p && (p.deletedAt || 0)) || hlcTs
  if (deleted || !p || p.id == null) {
    // Pure tombstone (payload purged at the origin, or a physically deleted row): merge
    // pointer only — the apply pipeline's ghost-tombstone guard skips ids we never had.
    return { entity: 'todo', id: String(env.entityId), author: (p && p.syncAuthor) || '', updatedAt: deletedAt, deleted: true, deletedAt, data: null }
  }
  const app = rowToTodo(p) // raw todos row -> app shape (taskId/taskContent/updateTime/...)
  if (!app) return null
  return {
    entity: 'todo',
    id: String(env.entityId),
    author: p.syncAuthor || '',
    updatedAt: app.updateTime || hlcTs,
    deleted: false,
    deletedAt: 0,
    data: app,
  }
}

/** Fresh v1-pipeline state for one ingest pass (shape mirrors lan-sync-bootstrap's state). */
function createState (deviceId) {
  return {
    db: require('./db'),
    deviceId: deviceId || '',
    localUserId: null,
    applyCache: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applied: null,
  }
}

/**
 * Apply one round's received envelopes. @param {Array<{envelope: object, status: string}>} received
 * @param {object} [store] the engine store AFTER the client round (source of truth for
 *   which envelope is the materialized current — mirrors the persisted pointer decision)
 * @param {string} [deviceId] this device's sync id (LWW tie-break stamp)
 * @returns {{dagIngested: number, businessApplied: number, businessSkipped: number,
 *   verdicts: Map<string, 'ok'|'blocked'>}} verdicts: per-envelope materialization verdict
 *   keyed by revisionId — 'blocked' = a PEER-originated envelope this slice cannot
 *   materialize (non-todo entity) or could not even map the payload: the relay cursor
 *   must NOT be advanced past it (acking + relay GC would make the remote change
 *   unrecoverable, 2026-10-14). Own-device envelopes are always 'ok' when not applied —
 *   their content already lives in the local business tables/DAG (the app's recorder
 *   mints many bookkeeping revisions per write; holding on those would pin the cursor
 *   forever). 'ok' = materialized, own frame, or a no-op (LWW loser / identical content /
 *   ghost tombstone — the local state already holds at-least-as-new content).
 * @throws when the DAG ingest or the business flush fails durably (round must not commit its cursor)
 */
function applyPulledEnvelopes (received, store, deviceId) {
  const log = logger()
  const items = (Array.isArray(received) ? received : [])
    .map(r => r && r.envelope ? r : null).filter(Boolean)
  if (!items.length) return { dagIngested: 0, businessApplied: 0, businessSkipped: 0 }

  // 1) Causal receive FIRST: the business write's recorder reads sync_revision_current
  // to pick its parent — with the remote head already persisted, a re-stamp revision
  // parents onto it (child > parent structural, spec §6 rule 2) instead of forking a
  // concurrent line from a stale local head.
  const revisions = require('./db').__revisionsForTests
  const isCurrent = env => !!(store && store.currentByEntity &&
    store.currentByEntity.get(String(env.entityId)) === env.revisionId)
  const dag = revisions.ingestRemote(items.map(r => ({ envelope: r.envelope, isCurrent: isCurrent(r.envelope) })))

  // 2) Business materialization (todos this slice) through the v1 pipeline.
  //    S1 (Sync v2): envelopes the revision DAG has ALREADY ruled causally current (a
  //    descendant of the local head) carry `causalCurrent` into the apply pipeline — the
  //    business LWW must not overrule the DAG's causal verdict with a wall-clock stamp
  //    (a slow-clock successor beats a fast-clock ancestor). Opt-in by construction:
  //    ONLY this relay pull path stamps it; LAN sync and the v1 default path never do.
  //    Re-evaluated HERE per row — the mapped array above is a throwaway argument to
  //    ingestRemote and never mutates `items`.
  const state = createState(deviceId)
  state.applyCache = syncApply.createHydrationCache(state)
  let businessApplied = 0
  let businessSkipped = 0
  const verdicts = new Map()
  // Origin check (2026-10-14): only PEER-originated envelopes can carry changes this
  // device has never seen. An own-device frame (any entity — the v2 recorder mints
  // settings/meta bookkeeping revisions on every write) is by construction already in
  // the local business tables + DAG; blocking on those would pin the relay cursor at
  // its head forever (every pull contains own bookkeeping frames).
  const ownFrame = env => !!(env && (env.authorDeviceId === deviceId || (env.hlc && env.hlc.nodeId === deviceId)))
  for (const r of items) {
    const vid = r.envelope && r.envelope.revisionId
    const row = envelopeToWireRow(r.envelope)
    if (!row) {
      // Non-todo entities (settings/tomato/category/plan/filter/meta) stay DAG-only in
      // this slice: report 'blocked' for peer frames so the durable host holds the relay
      // cursor BELOW this envelope instead of acking it into relay GC (silent-loss fix,
      // 2026-10-14). Own frames advance (see ownFrame above). NOTE: this check must stay
      // BEFORE the replay skip — the blocked envelope is ingested into the DAG on its
      // first round, so a naive "known ⇒ skip" would flip it to 'ok' on round 2 and
      // reopen the ack+GC loss hole.
      businessSkipped++
      if (vid) verdicts.set(vid, ownFrame(r.envelope) ? 'ok' : 'blocked')
      continue
    }
    // Replay skip (2026-10-14 regression fix): with the cursor held below a blocked
    // envelope, every round re-pulls ALREADY-APPLIED todo envelopes. Their DAG row
    // already exists (INSERT OR IGNORE lost ⇒ knownIds), and re-running the business
    // fold over them re-arms the LWW/conflict machinery against the since-advanced
    // local head — S1 v2 regression: a second spurious conflict copy per replay. The
    // previous round's fold committed durably; the replay is a no-op by construction.
    if (vid && dag.knownIds && dag.knownIds.includes(vid)) {
      businessSkipped++
      verdicts.set(vid, 'ok')
      continue
    }
    if (isCurrent(r.envelope)) row.causalCurrent = true
    if (syncApply.applyRowSafe(state, row)) {
      businessApplied++
      if (vid) verdicts.set(vid, 'ok')
    } else {
      // no local write needed (LWW loser / identical content no-op / ghost tombstone):
      // the business table already holds at-least-as-new content — advancing the cursor
      // loses nothing.
      businessSkipped++
      if (vid) verdicts.set(vid, 'ok')
    }
  }
  const flush = syncApply.flushPendingWrites(state)
  if (!flush || !flush.ok) {
    throw new Error('relay-apply: business flush failed without quarantine (cursor must not advance over dropped rows)')
  }
  if (businessApplied) {
    log.info(`[RelaySync] materialized ${businessApplied} pulled todo row(s) into the business table (dag +${dag.ingested})`)
  }
  return { dagIngested: dag.ingested, businessApplied, businessSkipped, verdicts }
}

module.exports = { envelopeToWireRow, applyPulledEnvelopes }
