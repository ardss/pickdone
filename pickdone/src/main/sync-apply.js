'use strict'
/**
 * Sync apply pipeline (extracted from lan-sync-bootstrap.js, round-3 review line ratchet).
 *
 * Everything that turns an INBOUND sync row into local writes lives here:
 *   - hydration caches + hydrateRow (oplog pointer -> merge-ready row, egress filters)
 *   - the LWW apply pipeline (clock-skew clamp, merge rules via shared/sync-core, conflict-copy
 *     materialization, userId normalization, ghost-tombstone guard)
 *   - the buffered bulk-write flush (per-op isolation: a poison-pill row must not wedge apply
 *     AND flush forever)
 *
 * The bootstrap owns the module-level `state` singleton (swappable by tests via __test); every
 * function here takes `state` as its first argument so behavior is identical for production and
 * the test harness. Merge rules come from shared/sync-core only (transport-adapter boundary).
 */

const log = require('electron-log')
const mergeCore = require('../../shared/sync-core/merge.mjs')
// Phase-3 (docs/refactor-command-bus.md): buffer drain routes read their op from the manifest
// so the engine's bulk surfaces stay census-tied to the single command table. The engine still
// applies rows DIRECTLY (peer-carried LWW stamps — see the gate's sync-ingress exemption for
// this file); the manifest is used for dispatch naming only, never for stamping.
const manifest = require('./command-manifest')
// Arch review 2026-09-22 rec #3: the ingress clamp window is the SHARED constant — the same
// window/semantics as the command-bus explicit-stamp clamp (see stamp-clamp.js).
const { STAMP_CLAMP_MS } = require('./stamp-clamp')
const { SYNC_OPLOG_KEEP, oplogKeepLimit } = require('./db-oplog') // D3 2026-09-24: oplog page size derives from the ring retention (was bare 10000s)
// Arch review 2026-09-22 rec #1 (twin-door convergence): flush/ingress WRITE sites route
// through an injected bus built on top of THIS state's db surface (createBus is exported for
// exactly this). The bus's dbCall is state.db.call, so mock-driven unit suites keep their
// recording surface; the hookless instance preserves the ingress contract (no ls-mirror kick,
// no local re-stamping — every write passes { preserveStamp: true }, which means the bus never
// MINTS a stamp; an explicit stamp beyond the shared skew window is still clamped, mirroring
// clampSkew's ingress normalization — see command-bus.js stampPayload).
const { createBus } = require('./command-bus')

// Manifest keys of the buffered bulk commands, in exact flush order (order is load-bearing:
// todos first so a same-round todo+plan move lands coherently, tombstone-heavy buffers early).
// opOf() throws on a manifest drift instead of silently skipping a buffer.
const FLUSH_ROUTE_COMMANDS = [
  ['todos', 'todo.putMany'],
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

// Hydration layer (entity classification + per-pass caches + hydrateRow) lives in
// sync-apply-hydrate.js (structure-size ratchet, verbatim move) — re-exported below so the
// bootstrap and the test harness keep their single require surface.
const {
  SYNCABLE_ENTITIES,
  SECURITY_LOCK_KEY,
  TOMB_FALLBACK_LOOKUP,
  isAnnounceMetaKey,
  META_CONFLICT_BACKUP_PREFIX,
  isMachineLocalMetaKey,
  isSyncBlobMetaKey,
  isMachineLocalSettingKey,
  createHydrationCache,
  hydrateRow,
} = require('./sync-apply-hydrate')

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

const META_CONFLICT_BACKUP_CAP = 20
// MS-collision fix (2026-09-26): process-lifetime monotonic counter mixed into backup-key /
// conflict-copy-id suffixes so two mints within the same millisecond can never collide
// (Date.now() alone did). Monotonic per process: preserves sort order for the count-based prune.
let backupSeq = 0
// rowContentDiffers lives in sync-apply-content.js (structure-size ratchet, verbatim move):
const { rowContentDiffers } = require('./sync-apply-content')

/**
 * Local account id (round-3 review, item: userId passthrough). Inbound rows carry the PEER's
 * userId verbatim — cross-account pollution plus an identifier leak. Determined from the local
 * todos' userId (the same value renderer genTaskId stamps); falls back to the offline default
 * profile id (renderer utils/core.js loadLocalUser). Memoized per sync session: the local
 * account never changes while the node runs.
 */
// D11 finding 16: durable memo for the discovered account id. The in-memory `state.localUserId`
// dies with the process — an empty todos table on the NEXT session (user deleted every task, or a
// restore landed before the first sync round) used to fall back to the 840001 offline default even
// though this device's real account id was known before. 'sync.*' is machine-local
// (shared/machine-local-keys.mjs), so the memo never egresses.
const LOCAL_USER_ID_META_KEY = 'sync.localUserId'

function localUserId (state) {
  if (state.localUserId != null) return state.localUserId
  try {
    for (const t of state.db.call('getAll', { deleted: null }) || []) {
      if (t && t.userId != null) {
        state.localUserId = t.userId
        persistLocalUserId(state, t.userId)
        return state.localUserId
      }
    }
  } catch { /* fall through to the durable memo / default */ }
  try {
    const persisted = Number(state.db.call('getMeta', LOCAL_USER_ID_META_KEY))
    if (Number.isFinite(persisted) && persisted > 0) { state.localUserId = persisted; return state.localUserId }
  } catch { /* fall through to the default */ }
  state.localUserId = 840001
  return state.localUserId
}

/** Best-effort durable write of a DISCOVERED id (never the 840001 guess — that is a default,
 *  not evidence). Machine-local meta, so no sync round is kicked for it. Routes through the
 *  bus facade like every sync-apply write (single-write-gate). */
function persistLocalUserId (state, id) {
  try {
    if (Number(state.db.call('getMeta', LOCAL_USER_ID_META_KEY)) !== Number(id)) {
      busWrite(state, 'setMeta', [LOCAL_USER_ID_META_KEY, String(id)])
    }
  } catch { /* the scan result still applies for this session */ }
}

/**
 * LWW clock-skew clamp (single choke point for ALL inbound rows: increments and snapshot chunks
 * both land here). A peer whose clock runs far ahead would otherwise stamp every future conflict
 * in its favor forever. Clamp the comparison keys (updatedAt/deletedAt) to `now` when they are
 * more than SKEW_CLAMP into the future. Round-3 review: when the clamp engages, the PAYLOAD
 * fields written to disk are normalized to the clamped values too — the stored row MUST NOT keep
 * a future updateTime, or the clamped-arrival winner later loses to nothing and silently reverts
 * the local user's real newer edit on the next re-push of the stale row. The "don't touch
 * payload" rule holds only on the non-skew path (row returned verbatim).
 */
const SKEW_CLAMP_MS = STAMP_CLAMP_MS
// P3 (wave-A, 2026-09-21): a non-numeric/garbage stamp (NaN, strings that don't parse) reads as
// epoch 0 for comparison so a poisoned payload can never propagate NaN into the LWW comparisons
// (NaN > limit is false, which used to let a NaN stamp sail through untouched).
const stampNum = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
// P1-1 (wave-A, 2026-09-21): the future detection now includes the PAYLOAD stamps too — a
// skewed/malicious peer could push a category/tomato/plan row whose top-level comparison keys
// look sane while `data.updatedAt` carried a year-2100 stamp; the row would land with that
// future age baked in and win LWW against every honest edit forever.
function clampSkew (row) {
  if (!row || typeof row !== 'object') return row
  const now = Date.now()
  const limit = now + SKEW_CLAMP_MS
  const d = (row.data && typeof row.data === 'object') ? row.data : null
  const future = (stampNum(row.updatedAt) > limit) || (stampNum(row.deletedAt) > limit) ||
    (d && (stampNum(d.updateTime) > limit || stampNum(d.deletedAt) > limit || stampNum(d.updatedAt) > limit))
  if (!future) return row
  const out = {
    ...row,
    updatedAt: stampNum(row.updatedAt) > limit ? now : row.updatedAt,
    deletedAt: stampNum(row.deletedAt) > limit ? now : row.deletedAt,
  }
  if (d) {
    const dd = { ...d }
    if (stampNum(dd.updateTime) > limit) dd.updateTime = now
    if (stampNum(dd.deletedAt) > limit) dd.deletedAt = now
    // Bus-stamps fix (2026-09-22): tomato/plan/filter/category hydrate their data as the RAW
    // ROW, which carries the SAME `updatedAt` column the comparison key was taken from — the
    // flush write path persists that data stamp verbatim (tomatoAppendMany / planAddMany keep
    // an explicit positive updatedAt; the category branch prefers d.updatedAt). Clamping only
    // the top-level keys used to let the winner land with a future data.updatedAt, which the
    // next egress hydrate then pushed to every peer as the row's age.
    if (stampNum(dd.updatedAt) > limit) dd.updatedAt = now
    // P3: normalize present-but-garbage stamp fields on the clamp path (the non-skew path
    // still returns the row verbatim — see the contract comment above).
    for (const f of ['updateTime', 'deletedAt', 'updatedAt']) {
      if (dd[f] !== undefined && dd[f] !== null && !Number.isFinite(Number(dd[f]))) dd[f] = 0
    }
    out.data = dd
  }
  return out
}

/** Content key for conflict-copy dedup: the losing payload modulo bookkeeping (taskId/
 *  updateTime/tombstone markers) and the per-device userId stamp. Two copies of the same
 *  base row with equal keys carry the same user-visible lost content. */
function conflictCopyContentKey (data) {
  const rest = { ...data }
  delete rest.taskId
  delete rest.userId
  delete rest.updateTime
  delete rest.deletedAt
  delete rest.delete
  return mergeCore.contentFingerprint(rest)
}

/** Idempotent copy materialization (loop fix 2026-09-18): true when the recycle bin already
 *  holds a `-conflict-` copy of `baseId` with the same content key — minting another would
 *  grow the bin by one copy per round for as long as the (now normalized) row keeps bouncing. */
function hasEquivalentConflictCopy (state, baseId, loserData) {
  try {
    const prefix = `${baseId}-conflict-`
    const key = conflictCopyContentKey(loserData)
    for (const t of state.db.call('getAll', { deleted: null }) || []) {
      const id = String(t.taskId || '')
      if (id.startsWith(prefix) && conflictCopyContentKey(t) === key) return true
    }
    // Batch-safety (2026-09-28 3-machine drill): a copy minted earlier in THIS apply batch is
    // still sitting in pendingWrites (commitSyncBatch defers the flush), invisible to the
    // getAll scan above — a second conflict on the same base row in the same round then minted
    // a duplicate recycle-bin copy. Scan the pending buffer with the same fingerprint.
    for (const t of state.pendingWrites.todos || []) {
      const id = String(t.taskId || '')
      if (id.startsWith(prefix) && conflictCopyContentKey(t) === key) return true
    }
  } catch (e) { log.warn('[LanSync] conflict-copy dedup scan failed:', e.message) }
  return false
}

/**
 * P1-5: persist one losing meta value under a dated backup key and prune older backups for the
 * same base key beyond META_CONFLICT_BACKUP_CAP. Best-effort: a backup failure must never fail
 * the apply (the LWW winner still lands). Backup keys are machine-local (see the
 * isMachineLocalMetaKey filter) so they never sync back to the peer.
 */
function writeMetaConflictBackup (state, key, value) {
  try {
    // MS-collision fix (2026-09-26): the key used to be `.<ts36>` alone — two conflict backups
    // of the SAME base key minted within one millisecond (bulk apply loop) produced identical
    // keys and the second setMeta silently OVERWROTE the first (the earlier losing value was
    // lost). A module-level monotonic counter appended after the ts keeps the lexicographic
    // prune order (ts36 dominates across milliseconds; the counter orders within one) while
    // making every key unique.
    const ts36 = `${Date.now().toString(36)}-${(backupSeq++).toString(36)}`
    const backupKey = `${META_CONFLICT_BACKUP_PREFIX}${key}.${ts36}`
    busWrite(state, 'setMeta', [backupKey, JSON.stringify({ key, value, lostAt: Date.now() })])
    // Prune: keep only the latest META_CONFLICT_BACKUP_CAP backups per base key.
    const prefix = `${META_CONFLICT_BACKUP_PREFIX}${key}.`
    const keys = (state.db.call('listMetaKeys') || []).filter(k => String(k).startsWith(prefix)).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - META_CONFLICT_BACKUP_CAP))) {
      try { busWrite(state, 'deleteMeta', old) } catch { /* prune is best-effort */ }
    }
    log.warn('[LanSync] meta LWW conflict on', key, '— loser backed up as', backupKey)
  } catch (e) { log.warn('[LanSync] meta conflict backup failed for', key, e.message) }
}

function applyRowInner (state, incoming) {
  if (!incoming || !SYNCABLE_ENTITIES.has(incoming.entity)) return false
  // Defensive: a '*gc*' oplog marker must never surface as an appliable row id (see hydrateRow).
  if (String(incoming.id) === '*gc*') return false
  incoming = clampSkew(incoming)
  const entity = incoming.entity
  // Locate the local counterpart for LWW comparison (cached: one entity-list read per ingest pass)
  const cache = state.applyCache || createHydrationCache(state)
  let localRow = null
  if (entity === 'todo') {
    const t = cache.todo(incoming.id)
    // Provenance (protocol v3): localRow.author = the stored row's author; incoming.author =
    // the wire's top-level author (hydrateRow egress). Unknown (''/undefined) = pre-v7 legacy
    // — the merge layer treats unknown-vs-anything as divergent (conservative).
    if (t) localRow = { updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t, author: t.syncAuthor || '' }
  } else if (entity === 'setting') {
    // Egress gate mirrored on ingress (round-3 review): a peer must never WRITE securityLock*
    // rows here — the password/question ciphertext is strictly local.
    if (isMachineLocalSettingKey(incoming.id)) return false
    const r = cache.setting(incoming.id)
    // settingsRowsAll (deliberately) includes tombstones: a LOCAL tombstone must take part in the
    // merge as a real row, otherwise an older remote live row wins LWW against "missing" and
    // resurrects what the user deleted here (delete-wins never gets a chance to hold).
    if (r) localRow = { updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } }
  } else if (entity === 'meta') {
    // GAP-A fix (2026-09-19): see the isMachineLocalMetaKey/isSyncBlobMetaKey comments above.
    if (isMachineLocalMetaKey(incoming.id) || isSyncBlobMetaKey(incoming.id)) return false
    const localVal = cache.meta(incoming.id)
    if (localVal == null && incoming.deleted) return false
    // ...deletion already landed locally (or we never had the key): re-landing it would re-log an
    // oplog pointer and echo between peers forever — deleteMeta only needs to fire on a device
    // that still held a live value.
    // meta has no updatedAt column, so the local LWW age is the latest local oplog ts for this
    // key (cached per-pass oplog scan). No local pointer (legacy pre-oplog row) = age 0: the
    // incoming row wins once, then the identical-content no-op keeps it from churning.
    // B13 (daily 2026-09-24, low-危 mitigation): age 0 is only honest for an ABSENT local value
    // (first landing). For a LIVE key whose oplog pointers were ring-buffer-trimmed, age 0 lets
    // a stale peer row win LWW against whatever unknown-age value sits here (and, via the
    // mirrored deleteMeta hydration, even resurrect a deleted key). Age-unknown + live key =
    // refuse this round: keep the local value, warn. A local edit re-logs a pointer and the key
    // becomes comparable again; the peer's row re-lands on the next round if still newer.
    const tsMap = cache.metaTs()
    if (localVal != null && !tsMap.has(incoming.id) && !isAnnounceMetaKey(incoming.id)) {
      // tomatoRunAnnounce.* keys are exempt: they are ephemeral per-device status beacons
      // rewritten via setMeta on every tick and intentionally short-lived — their oplog pointers
      // trim almost immediately, so "age unknown" is their steady state, not a red flag. Staleness
      // is meaningless for a beacon, and the announce module dedups identical content itself.
      // D11 finding 4 (meta snapshot reconciliation): the B13 unconditional refusal made a live
      // user-data key whose oplog pointers fell out of the ring unsyncable FOREVER (snapshot rows
      // pass through this same branch). The trimmed pointer still proves a bound: the local write
      // happened at or before the ring's oldest retained ts (metaFloorTs). An inbound row stamped
      // NEWER than that floor is provably younger than the local value — accept it (localRow age
      // = floor, so the LWW comparison and the identical-content no-op stay sound). Only an
      // inbound stamp at/below the floor stays refused (genuinely ambiguous); a local edit re-logs
      // a pointer and makes the key comparable again.
      if (stampNum(incoming.updatedAt) <= cache.metaFloorTs()) {
        log.warn('[LanSync] meta local age unknown (oplog pointer trimmed) for live key', incoming.id, '— inbound row refused this round (stamp not provably newer than the trimmed-pointer floor)')
        return false
      }
      localRow = { updatedAt: cache.metaFloorTs(), deleted: false, deletedAt: 0, data: { key: incoming.id, value: localVal } }
    } else {
      localRow = { updatedAt: tsMap.get(incoming.id) || 0, deleted: false, deletedAt: 0, data: { key: incoming.id, value: localVal } }
    }
  } else if (entity === 'tomato' || entity === 'plan' || entity === 'filter') {
    // Manifest-documented tombstone-fallback shape (TOMB_FALLBACK_LOOKUP): live row first, then
    // the entity's tombstone read. Per-entity history that forced this shape:
    //   X1 (2026-09-20, tomato): a LOCAL tomato tombstone must take part in LWW — it used to read
    //   as "absent" (tomatoAll filters deleted=0) and a peer's stale live row resurrected the
    //   record via tomatoAppendMany (deleted=0 upsert).
    //   F3a/F3b (2026-09-20, plan/filter): planAll/filterList now SELECT updatedAt — known local
    //   age, real LWW (the old ageUnknown refusal silently dropped every peer chip/filter edit).
    //   M3 (2026-09-20, plan/filter): tombstone fallback — a locally deleted chip/filter must hold
    //   delete-wins against older peers.
    const keys = TOMB_FALLBACK_LOOKUP[entity]
    const r = cache[keys.live](incoming.id)
    if (r) localRow = { updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r }
    else {
      const t = cache[keys.tomb](incoming.id)
      if (t) localRow = { updatedAt: t.updatedAt || 0, deleted: true, deletedAt: t.deletedAt || 0, data: null }
    }
  } else if (entity === 'category') {
    // M1/M3 (2026-09-20): categoriesAllRows is the raw ROW table (tombstones included), so a
    // LOCALLY deleted category takes part in LWW — previously it read as absent (getAllCategories
    // hides deleted rows) and ANY inbound live row, even older, resurrected it.
    const r = cache.category(incoming.id)
    if (r && !r.deleted) localRow = { updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r }
    else if (r) localRow = { updatedAt: r.updatedAt || 0, deleted: true, deletedAt: r.deletedAt || 0, data: null }
  }
  // Symmetric tie-breaks (merge.mjs compareRecency): the local side must carry THIS device's
  // id so a full LWW tie resolves to the same winner on both peers instead of flip-flopping
  // on insertion order (loop fix 2026-09-18; inbound rows are stamped with the sender's id
  // at the transport boundary in lan-sync-bootstrap).
  if (localRow && localRow.deviceId == null && state.deviceId) localRow.deviceId = state.deviceId
  // Provenance normalization (protocol v3): increment rows carry author top-level (hydrateRow);
  // SNAPSHOT rows carry it in the payload (allRows data = the full todo payload). Missing = ''.
  if (entity === 'todo' && incoming.author == null) incoming.author = (incoming.data && incoming.data.syncAuthor) || ''
  if (!incoming.deleted && !incoming.data) return false // payload-less pointer, nothing to merge
  // Merge rules come from sync-core only (adapter boundary). Todos/chips/ledger have dedicated
  // rules; the remaining entities use the generic LWW shape.
  let winner
  let conflictCopy = null
  if (entity === 'tomato') winner = mergeCore.mergeTomatoRows(localRow, incoming).row
  else {
    const m = mergeCore.mergeTodoRows(localRow, incoming)
    winner = m.row
    conflictCopy = m.conflictCopy
  }
  if (localRow && winner !== incoming) return false // local version stands
  // Identical-content no-op (prevents apply/push ping-pong):
  //   - LIVE rows: identical content (userId-insensitive) is a no-op.
  //   - BOTH-DEAD rows (2026-09-19 live storm): the local row is already a tombstone, so the
  //     deletion has landed; re-writing the same dead row re-captured it into the oplog EVERY
  //     round, and tombstones dominate the retained window — the whole window churned per round
  //     on both peers (70-220s rounds that never shrank). Only a strictly newer deletion
  //     (deletedAt advanced past ours) is worth landing.
  if (localRow && winner === incoming && !localRow.deleted && !incoming.deleted && !rowContentDiffers(localRow, incoming)) return false
  if (localRow && winner === incoming && localRow.deleted && incoming.deleted &&
      (incoming.deletedAt || 0) <= (localRow.deletedAt || 0)) return false
  // Echo guard (2026-09-26 first-pair incident): the todo localRow above carries NO seq, so
  // compareRecency's seq tiebreak always reads local=0 vs the inbound pointer's seq>0 — an
  // ECHO of this device's own row (the peer applied it, re-captured it into its oplog, pushed
  // it back) wins every same-updatedAt tie by construction. Whether that tie-win is harmless
  // then depends entirely on the echo's content surviving the write roundtrip byte-identically
  // (it could not: todoToRow re-derived scheduledDay in the writer's timezone). A live row that
  // is NOT strictly newer than the local live row must never replace it nor spawn a conflict
  // copy of it — refuse and keep local. Real peer edits (strictly newer stamps) still win on
  // updatedAt before any tiebreak; live-vs-tombstone merges are left to the delete-wins rules.
  if (entity === 'todo' && localRow && !localRow.deleted && !incoming.deleted &&
      winner === incoming && stampNum(incoming.updatedAt) <= stampNum(localRow.updatedAt)) {
    log.warn('[LanSync] same-stamp echo on todo', incoming.id, '— local row stands (an echo is never strictly newer)')
    return false
  }
  if (conflictCopy) {
    // Surface the losing edit (merge.mjs contract: the loser is never silently dropped).
    // Round-3 review: materialize it as a TOMBSTONED todo row so the recycle bin can restore
    // the user's losing content. Skips are built into merge.mjs: no copy when content is
    // identical or when the loser is already a pure tombstone. The copy gets a suffixed id so
    // it cannot clobber the winning row; delete-wins keeps it out of the live list.
    //
    // Loop-fix guards (2026-09-18 live incident — recycle bins ballooned one copy per row per
    // round per machine):
    //   1. Copies are TERMINAL: a row whose id already carries the `-conflict-` marker never
    //      spawns another copy — a copy that loses LWW here is simply dropped. Otherwise the
    //      peer's copy-of-the-copy arrives as an independent row and re-participates forever.
    //   2. Materialization is IDEMPOTENT: if an equivalent copy of the same base row already
    //      sits in the recycle bin (same `-conflict-` prefix, same content fingerprint), do
    //      not mint a second one.
    const baseId = String(incoming.id)
    if (baseId.includes('-conflict-')) {
      log.warn('[LanSync] conflict on copy row', baseId, '— dropped (copies are terminal)')
    } else if (entity === 'todo' && conflictCopy.data) {
      if (hasEquivalentConflictCopy(state, baseId, conflictCopy.data)) {
        log.warn('[LanSync] conflict on', entity, baseId, '— equivalent copy already in recycle bin, not duplicating')
      } else {
        // MS-collision fix (2026-09-26): same-counter suffix as writeMetaConflictBackup — two
        // conflict copies of the same base row in one millisecond used to mint the SAME copyId
        // and silently collapse into one recycle-bin row.
        const copyId = `${baseId}-conflict-${Date.now().toString(36)}-${(backupSeq++).toString(36)}`
        // Provenance: the copy preserves the LOSER's author (it is a materialized copy of that
        // writer's version, so its lineage must not be re-attributed to this device). Prefer the
        // merge row's author; the payload's own stamp is the fallback; never write an empty
        // string over an existing one.
        state.pendingWrites.todos.push({
          ...conflictCopy.data,
          taskId: copyId, delete: 1, deletedAt: Date.now(),
          ...(conflictCopy.author ? { syncAuthor: conflictCopy.author } : {})
        })
        log.warn('[LanSync] conflict on', entity, baseId, '— loser materialized to recycle bin as', copyId)
      }
      // P1-5: the user-facing toast is driven by the round summary (one per round, see markConflict)
      markConflict(state, 'todo', (conflictCopy.data && conflictCopy.data.taskContent) || baseId, false)
    } else if (entity === 'meta' && conflictCopy && conflictCopy.data) {
      // P1-5 (2026-09-19 data-safety round): a content-differing LWW loss on a meta key used to
      // be silently dropped (whole-document KV, no recycle-bin shape). Materialize the loser as
      // a dated backup key `metaConflictBackup.<key>.<ts36>` (self-healing: capped at the latest
      // 20 per implementation cap) so the losing value stays recoverable, and include it in the
      // per-round conflict summary (the existing toast fires via consumeAppliedRound). Announce
      // keys (tomatoRunAnnounce.*) are ephemeral runtime state — no backup for those. A null
      // loser value means the key was ABSENT locally (mergeTodoRows fabricates a data=null
      // localRow) — nothing was lost, no backup.
      // M5 (2026-09-20): gamification.* keys are per-device COUNTERS/bookkeeping (delta indexes,
      // streak caches), not user documents — a losing overwrite is routine bookkeeping churn, so
      // minting metaConflictBackup.* copies (and toasting about it) for them was pure noise. The
      // whole namespace is exempt from BOTH backup and conflict toast; it is already invisible to
      // the backup-recovery list because the backups are simply never written.
      // R7 P1-3: a null loser value means the key was ABSENT locally (mergeTodoRows fabricates a
      // data=null localRow on first application) — nothing was lost, so no backup AND no toast:
      // the fabricated null always content-differs, and the old unconditional markConflict burned
      // the per-round conflict toast on every brand-new meta key, training users to ignore it.
      const bk = String(incoming.id)
      const firstLanding = conflictCopy.data.value == null
      const isBookkeeping = bk.startsWith('gamification')
      if (!isBookkeeping && !firstLanding && !require('./tomato-announce').isAnnounceKey(bk)) {
        writeMetaConflictBackup(state, bk, conflictCopy.data.value)
      }
      if (!isBookkeeping && !firstLanding) markConflict(state, 'meta', incoming.id, true)
    } else {
      // B16 (daily 2026-09-24): merge.mjs contract says the loser is NEVER silently dropped, but
      // for plan/filter/category/setting the loser used to vanish behind a warn-only log (only
      // todos got a recycle-bin copy and meta got a backup). Reuse the metaConflictBackup
      // mechanism: serialize the loser's data under a machine-local backup key
      // `metaConflictBackup.<entity>:<id>.<ts36>` (the META_CONFLICT_BACKUP_PREFIX filter in
      // isMachineLocalMetaKey keeps it local for ANY key, and it shows up in the existing
      // syncConflictBackupsList recovery surface). Restoration of non-meta entities to their
      // native tables is a separate concern — the goal here is that the losing bytes survive.
      if (conflictCopy && conflictCopy.data !== undefined && conflictCopy.data !== null) {
        writeMetaConflictBackup(state, `${entity}:${incoming.id}`, conflictCopy.data)
      }
      log.warn('[LanSync] conflict on', entity, incoming.id, '— local copy superseded (conflict-copy UI deferred)')
      // P1-5: non-todo losers are applied wholesale (LWW) — tell the user the peer's version won
      markConflict(state, entity, incoming.id, true)
    }
  }
  // Write the winner through the regular write ops (re-captured into the local oplog, which is what
  // propagates the acknowledged state back to the peer — idempotent under the same merge rules).
  // Todos/settings/tomato go through the per-segment write buffer: a first sync applies thousands of
  // rows and one transaction commit per row (~14ms each measured 2026-09-17) starves the round past
  // any sane budget, while the bulk ops commit in one transaction (upsertMany 3000 rows = ~110ms).
  if (entity === 'todo') {
    if (winner.deleted && !winner.data) {
      // Ghost tombstone guard (round-3 review): the inbound pointer's row was already purged on
      // the origin (hydrates as {deleted, data:null}) and we never had the todo either — upserting
      // here would materialize a content-empty junk row on peers that never saw the task. Record
      // it as applied (the pull watermark advances; merge is idempotent) WITHOUT inserting.
      if (!localRow) return true
      // Real tombstone winner over an existing local row: without this branch no write fired and
      // the peer's deletion NEVER landed here (every branch required winner.data). Land it through
      // the buffered bulk path — todoToRow normalizes `delete:1` into a deleted=1 tombstone row on
      // upsertMany. Provenance: the tombstone's author is the deleting device's (incoming.author).
      // Sync-1: the tombstone must carry its LWW age — without updateTime the row used to land
      // with updatedAt 0 (epoch-oldest) and the deletion resurrected on the next LWW round.
      // todoToRow now also falls back to deletedAt for deleted rows (belt and braces for callers
      // that only carry deletedAt).
      state.pendingWrites.todos.push({ taskId: incoming.id, delete: 1, deletedAt: winner.deletedAt || incoming.deletedAt || 0, updateTime: winner.deletedAt || incoming.deletedAt || 0, syncAuthor: incoming.author || '' })
      return true
    }
    if (!winner.data) return false
    // userId normalization at the sync boundary (round-3 review): the row lands with THIS
    // device's account id, never the peer's. Provenance: keep the ORIGINAL author — winner is
    // always `incoming` here (a local winner returned above), and re-stamping self would break
    // the same-writer lineage the merge layer now depends on.
    state.pendingWrites.todos.push({ ...winner.data, taskId: winner.data.taskId != null ? winner.data.taskId : incoming.id, userId: localUserId(state), syncAuthor: incoming.author || '' })
  } else if (entity === 'setting') {
    if (winner.deleted) {
      // Tombstone winner (delete-wins). settingsRowPut/putRow clears `deleted` on write, so pushing
      // the (data-carrying) tombstone through the buffer would RESURRECT the row; land the
      // deletion through the dedicated tombstone op instead. Direct sync call: deletes are rare
      // and tiny, no bulk buffering needed.
      // D11 finding 3: carry the winner's stamps — settingsRowDelete re-stamped local now, making
      // the applied deletion strictly newer than the sender's (delete-ordering falsified on 3+
      // devices, one extra echo round). Same contract as planRemoveIds/filterDelete (R7 P1-2).
      busWrite(state, 'settingsRowDelete', { key: incoming.id, deletedAt: winner.deletedAt || incoming.deletedAt, updatedAt: winner.updatedAt })
      markAppliedSetting(state, incoming.id, undefined) // P1-2a: blob field dropped + hot-apply bookkeeping
      return true
    }
    if (!winner.data) return false
    // R7 P1-1: carry the winner's LWW age into the row write — putRow used to re-stamp local now,
    // making the applied edit read newest-here while a peer edit pushed in-flight-but-older then
    // silently lost on both sides (convergence on the OLDER value). Same contract as plans/filters.
    state.pendingWrites.settings.push({ key: incoming.id, value: winner.data.value, updatedAt: winner.updatedAt })
    // P1-2a (2026-09-19 UX review): remember the applied key/value so the bootstrap can (1) fold it
    // into the db.settingsState blob and (2) hot-apply it to the running renderer. Without (1) the
    // renderer's next whole-blob mirror re-stamped its stale field over this newer row (fresh
    // updatedAt) — both peers perpetually "won" with stale values and every round logged a
    // settings conflict that nobody ever saw in the UI.
    markAppliedSetting(state, incoming.id, winner.data.value)
  } else if (entity === 'tomato') {
    if (winner.deleted && !winner.data) {
      // Tomato tombstone winner (hydrated from a pointer whose row is gone locally): land it via
      // the tombstone op. Direct sync call, same reasoning as settingsRowDelete above.
      // D11 finding 2: carry the winner's stamps — tomatoRemoveByIds re-stamped local now with the
      // same delete-ordering/echo consequences as planRemoveIds before R7 P1-2.
      busWrite(state, 'tomatoRemoveByIds', [{ tomatoId: incoming.id, deletedAt: winner.deletedAt || incoming.deletedAt, updatedAt: winner.updatedAt || incoming.updatedAt || winner.deletedAt || incoming.deletedAt }])
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.tomatoes.push(winner.data)
  } else if (entity === 'category' && winner.deleted) {
    // F2 (2026-09-20): category tombstone landing. Hydrated deleted categories are
    // {deleted:true, data:null} and the old branch required winner.data, so a peer's deletion
    // NEVER landed here. Land it through the bulk buffer as a row-shape tombstone: upsertCategory
    // preserves an explicit deletedAt/updatedAt, so merge ordering metadata survives the hop, and
    // its identical-content no-op makes a re-landed tombstone idempotent (no re-stamp, no echo).
    if (!localRow) return true // ghost tombstone: we never had the category — applied, no write
    state.pendingWrites.categories.push({
      id: incoming.id,
      deleted: 1,
      deletedAt: winner.deletedAt || incoming.deletedAt || 0,
      updatedAt: winner.updatedAt || incoming.updatedAt || 0,
    })
    return true
  } else if (entity === 'category' && winner.data) {
    // Bulk-buffered (2026-09-18): a first-sync snapshot can carry hundreds of categories —
    // one commit per row starved rounds the same way todos did before the write buffer.
    // M1 (2026-09-20): the payload is the RAW ROW shape (see hydrateRow) and must stay that way —
    // upsertCategory binds @name/@color/@createdAt/... and the old hydrated app shape
    // (categoryName/...) made better-sqlite3 throw "Invalid value", so flushOne dropped the WHOLE
    // categories buffer and category sync never landed. Normalize defensively anyway (an older
    // peer may still push the app shape) and preserve the winner's updatedAt like upsertCategory
    // does for explicit stamps — re-stamping now() would mint a fresh oplog delta per applied
    // row (ping-pong fuel, same shape as planAddMany's M2).
    const d = winner.data
    state.pendingWrites.categories.push({
      id: d.id != null ? d.id : d.categoryId,
      userId: d.userId,
      name: d.name != null ? d.name : d.categoryName,
      color: d.color != null ? d.color : d.categoryColor,
      createdAt: d.createdAt != null ? d.createdAt : d.createTime,
      sort: d.sort != null ? d.sort : d.listSort,
      isFolder: (d.isFolder != null ? d.isFolder : d.folderIs) ? 1 : 0,
      parentId: d.parentId != null ? d.parentId : (d.folderId || 0),
      deleted: 0,
      deletedAt: 0,
      updatedAt: d.updatedAt || winner.updatedAt || 0,
    })
  } else if (entity === 'plan') {
    if (incoming.deleted) {
      // Ghost-tombstone guard (2026-09-19 live storm): a plan pointer whose chip planAll cannot
      // see hydrates as a tombstone (see hydrateRow), and planRemoveIds logged the delete into
      // the oplog EVEN when we never had the chip — so both peers echoed the same delete back
      // and forth at ~1000 oplog rows/s and every round carried the whole echo (120s+ rounds).
      // Only delete a chip we actually have; a ghost tombstone is a no-op.
      // R7 P1-2: land the tombstone with the winner's stamps — planRemoveIds used to re-stamp
      // local now, replacing the true deletion time (wrong delete-ordering on 3+ devices) and
      // producing a tombstone strictly newer than the sender's, which echoed one extra round.
      if (localRow) busWrite(state, 'planRemoveIds', [{ id: incoming.id, deletedAt: winner.deletedAt || incoming.deletedAt, updatedAt: winner.updatedAt }])
      else return false
    } else state.pendingWrites.plans.push(winner.data) // bulk-buffered via planAddMany at flush
  } else if (entity === 'filter') {
    if (incoming.deleted) {
      // Same ghost-tombstone guard as plan: never re-capture a delete for a filter we don't have.
      // R7 P1-2: carry the winner's stamps (see the plan branch — no local re-stamp, no echo bounce).
      if (localRow) busWrite(state, 'filterDelete', [Number(incoming.id), { deletedAt: winner.deletedAt || incoming.deletedAt, updatedAt: winner.updatedAt }])
      else return false
    } else state.pendingWrites.filters.push({ ...winner.data, id: Number(incoming.id) }) // bulk-buffered
  } else if (entity === 'meta') {
    // GAP-A fix (2026-09-19): meta lands through the regular setMeta/deleteMeta ops (re-captured
    // into the local oplog, which is what acknowledges the state back to the peer). LWW-newer-wins
    // with NO conflict copy for meta: it is a KV table whose values are whole documents — a losing
    // whole-document copy has no recycle-bin semantics, and convergence is already guaranteed by
    // the identical-content no-op above (both peers deterministically settle on the newer ts).
    if (winner.deleted) {
      busWrite(state, 'deleteMeta', incoming.id)
      return true
    }
    if (!winner.data) return false
    busWrite(state, 'setMeta', [incoming.id, winner.data.value])
    // Running-tomato announcements (feature: live cross-device focus countdown): after the
    // peer's announce key landed, fan it out to the renderer. Announce keys pass the
    // machine-local filter on purpose (display-only remote runtime; see tomato-announce.js).
    // P2 2026-09-20: the per-row emitRemoteAnnounce broadcast fired once per announce ROW
    // inside the ingest loop; a first-sync segment can carry many announce updates per device.
    // Coalesce: collect the latest value per key for this ingest pass; flushPendingWrites fans
    // out ONCE after the rows are committed.
    if (require('./tomato-announce').isAnnounceKey(incoming.id)) {
      if (!state.pendingAnnounces) state.pendingAnnounces = new Map()
      state.pendingAnnounces.set(incoming.id, winner.data.value)
    }
  } else {
    return false
  }
  return true
}

/** P0-1 (2026-09-19 UX review): applied-entity bookkeeping for the post-round renderer
 *  broadcast. applyRowInner is the single choke point every inbound row passes through, so
 *  `applied` is recorded right here: kinds that changed this round + the settings key/values
 *  (P1-2: the consumer updates the db.settingsState blob with them so the renderer's next
 *  whole-blob mirror cannot re-stamp stale fields over newer rows). */
function markApplied (state, entity) {
  if (!state.applied) state.applied = { kinds: new Set(), settingsPatch: {}, conflicts: [] }
  state.applied.kinds.add(entity)
}

/** Capture an applied inbound SETTING row (P1-2a): key -> new value. Row values travel
 *  JSON-serialized (uniform roundtrip), but the settings blob and the renderer's hot-apply
 *  patch both work on PARSED values — decode here, falling back to the raw string for
 *  non-JSON payloads. Deleted rows carry undefined (the blob field is dropped; the hot-apply
 *  patch omits it — settings deletes are not a user-reachable flow today). securityLock*
 *  never lands here (ingress gate). */
function markAppliedSetting (state, key, value) {
  markApplied(state, 'setting')
  if (!state.applied) return
  let decoded = value
  if (typeof value === 'string') {
    try { decoded = JSON.parse(value) } catch { /* keep the raw string */ }
  }
  state.applied.settingsPatch[key] = decoded
}

/**
 * P1-5 (2026-09-19 UX review): per-round conflict summary. Non-todo LWW losses were warn-only
 * log lines — the losing machine's user never learned their edit was superseded. Each conflict
 * appends one {entity, name, applied} entry; the bootstrap emits AT MOST ONE 'sync-conflict'
 * syncEvent per round (consumeAppliedRound) so the UI can show a single non-intrusive toast.
 */
function markConflict (state, entity, name, applied) {
  if (!state.applied) state.applied = { kinds: new Set(), settingsPatch: {}, conflicts: [] }
  if (!state.applied) return
  state.applied.conflicts.push({ entity, name: String(name || ''), applied: !!applied })
}

function applyRowSafe (state, incoming) {
  try {
    const ok = applyRowInner(state, incoming)
    if (ok) markApplied(state, incoming && incoming.entity)
    return ok
  } catch (e) { log.warn('[LanSync] apply failed for', incoming && incoming.entity, incoming && incoming.id, e.message); return false }
}

/**
 * Consume one round's applied bookkeeping (called by the bootstrap after flushPendingWrites):
 * returns { kinds, settingsPatch, conflicts } or null when nothing applied. Resets the
 * bookkeeping so the next round starts clean.
 */
function consumeAppliedRound (state) {
  const a = state.applied
  state.applied = null
  if (!a || (!a.kinds.size && !a.conflicts.length && !Object.keys(a.settingsPatch).length)) return null
  return { kinds: [...a.kinds], settingsPatch: a.settingsPatch, conflicts: a.conflicts }
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
    parked.push({ at: Date.now(), count: list.length, error: (err && err.message) || String(err), rows: list.map(quarantineEncodeRow) })
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

function flushPendingWrites (state) {
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
    try { busWrite(state, op, list) } catch (e) {
      log.error(`[LanSync] flush ${op} failed — dropping ${list.length} buffered rows (quarantined under ${META_FLUSH_QUARANTINE_PREFIX}${op}, recoverable via snapshot):`, e && e.message)
      // 2026-09-26 poison-row quarantine: a dropped buffer used to be log-only ("recoverable via
      // snapshot" = the ONLY recovery, and only if a snapshot actually re-fires). Park the rows in
      // a machine-local meta key (sync.* never syncs — isMachineLocalMetaKey) so they stay
      // inspectable/recoverable, and surface the quarantine on the flush result so the bootstrap
      // can raise a Device Center syncEvent instead of failing silently.
      const entry = quarantineFlushRows(state, op, list, e)
      if (entry) quarantined.push(entry)
      else ok = false // parking failed: log-only drop, fail closed so the segment is not acked
    }
  }
  for (const r of flushRoutes) {
    flushOne(buf[r.buf], r.op)
    buf[r.buf] = []
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

/**
 * Local max oplog seq — reported to peers as `ack.appliedToSeq` so their per-peer push watermarks
 * can advance and rounds ship deltas instead of re-pushing the full backlog every time.
 * syncOplogSince is ascending-only with a clamped limit, so page forward; the ring buffer keeps
 * ~10k rows, so this is one query in practice (two at most right after a trim boundary).
 */
function readMaxOplogSeq (state) {
  let since = 0
  for (let i = 0; i < SYNC_OPLOG_KEEP; i++) {
    const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: oplogKeepLimit(SYNC_OPLOG_KEEP) }) || []
    if (rows.length < SYNC_OPLOG_KEEP) return rows.length ? rows[rows.length - 1].seq : since
    since = rows[rows.length - 1].seq
  }
  return since
}

/**
 * D11 finding 4 (egress half of the meta reconciliation): snapshot rows for the meta entity used
 * to be enumerated ONLY from retained oplog pointers (allRows' metaTs scan) — a live user-data key
 * whose pointers fell out of the ring never appeared in a snapshot and never re-pushed as an
 * increment: unsyncable in BOTH directions until a local rewrite. Enumerate from the meta TABLE
 * instead (listMetaKeys), with the retained-pointer ts as the age and the ring's floor ts as the
 * honest age BOUND for a trimmed key (the local write happened at or before the floor). Pair with
 * the ingress bound rule in applyRowInner, this closes the permanent-starvation class. Excluded:
 * machine-local meta, the settings/habits blobs (field-granular via the setting entity), and
 * keys whose value is absent (their deletions ride the increment tombstones, as before).
 */
function metaSnapshotRows (state) {
  const cache = createHydrationCache(state)
  const tsMap = cache.metaTs()
  const floor = cache.metaFloorTs()
  const out = []
  for (const key of state.db.call('listMetaKeys') || []) {
    if (isMachineLocalMetaKey(key) || isSyncBlobMetaKey(key)) continue
    const v = cache.meta(key)
    if (v == null) continue // deleted: tombstones are carried by the increment pointers
    out.push({ entity: 'meta', id: key, updatedAt: tsMap.get(key) || floor, deleted: false, deletedAt: 0, data: { key, value: v } })
  }
  return out
}

module.exports = {
  SYNCABLE_ENTITIES,
  SECURITY_LOCK_KEY,
  META_CONFLICT_BACKUP_PREFIX,
  META_CONFLICT_BACKUP_CAP,
  // 2026-09-26 poison-row quarantine: where a failed flush parks its dropped rows.
  META_FLUSH_QUARANTINE_PREFIX,
  // Exported (2026-09-19): lan-sync-bootstrap destructures this for allRows()/hydration skips —
  // the missing export made every allRows() call (legacy seed, snapshot serving) throw TypeError.
  isMachineLocalSettingKey,
  // Exported (2026-09-19, GAP-A): lan-sync-bootstrap's allRows() uses both to keep machine-local
  // meta and the settings/habits blobs out of snapshot/seed pushes.
  isMachineLocalMetaKey,
  isSyncBlobMetaKey,
  createHydrationCache,
  hydrateRow,
  metaSnapshotRows,
  rowContentDiffers,
  localUserId,
  clampSkew,
  applyRowSafe,
  consumeAppliedRound,
  flushPendingWrites,
  readMaxOplogSeq,
  writeMetaConflictBackup,
  // Arch review 2026-09-22 rec #1: the injected-ingress write door (lan-sync-bootstrap routes
  // its manifest-op writes through the same helper so the engine stays one bus-routed surface).
  busFor,
  busWrite,
}
