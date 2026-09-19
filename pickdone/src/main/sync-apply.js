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

const SYNCABLE_ENTITIES = new Set(['todo', 'setting', 'tomato', 'category', 'plan', 'filter', 'meta'])
// settings_rows keys holding password/question CIPHERTEXT — never egress, never ingress (round-3).
const SECURITY_LOCK_KEY = /^securityLock/

// Machine-local bookkeeping keys: CLI last-seen/save stamps are per-device state, not user
// data — syncing them made the two hosts fight over them every round (log noise, LWW churn).
const isMachineLocalSettingKey = id => {
  const k = String(id)
  // 'sync.' namespace = identity/pairing state (strictly local); 'securityLock*' = password
  // ciphertext (round-3 review: never egresses); leading underscore = CLI bookkeeping stamps.
  return k.startsWith('sync.') || /^securityLock/.test(k) || k.startsWith('_')
}

// GAP-A fix (2026-09-19): meta rows (projectMilestones:*, projectCategoryIds, tomatoEstimateState,
// projectDeadline:/projectStatus:, repeatRule:*, ...) were captured into the oplog but never
// hydrated/applied, so they never reached peers. These meta keys are machine-local and must
// neither egress nor be overwritten by a peer's row:
//   'sync.*' = sync engine bookkeeping (push cursor etc.); '_' = CLI stamps; 'securityLock*'
//   defensive parity with settings rows; 'cliTomato*' = CLI tomato runtime TRANSIENT state
//   (per-device command/status slots); 'todosVersion' = per-device dirty-row cursor;
//   'firedReminders:'/'reminderLastSeenAt' = per-device scheduler dedup watermarks;
//   'settingsRows.src.*' = v6 migration snapshot markers; 'db.tomatoState'/'habitsState' =
//   retired/legacy ledger+habits blobs (migration bookkeeping only).
const isMachineLocalMetaKey = id => {
  const k = String(id)
  return k.startsWith('sync.') || k.startsWith('_') || /^securityLock/.test(k) ||
    k.startsWith('cliTomato') || k === 'todosVersion' || k.startsWith('firedReminders:') ||
    k === 'reminderLastSeenAt' || k.startsWith('settingsRows.src.') ||
    k === 'db.tomatoState' || k === 'habitsState'
}
// The settings/habits blobs are deliberately EXCLUDED from meta sync: they already sync
// FIELD-GRANULAR via the `setting` entity (the db-sync-schema setMeta bridge mirrors every blob
// field into settings_rows). Syncing the blob itself would apply whole-blob LWW and let the
// receiving bridge's mergeDoc re-stamp stale field values OVER newer row edits — the §4.2
// whole-blob clobber the split was built to prevent.
const isSyncBlobMetaKey = id => {
  const k = String(id)
  return k === 'db.settingsState' || k === 'db.habitsState'
}

/**
 * Per-hydration-pass entity caches. The first buildSegments after a fresh cursor re-hydrates the
 * whole oplog (thousands of pointers); without these caches every pointer re-scanned a full entity
 * list (O(n²)) and the peer's round response starved past the transport's round timer, so the
 * cursor never advanced and every later round rebuilt the same backlog (2026-09-17 live drill).
 * A cache instance is valid for ONE getRowsSince call: rows applied between calls must re-read.
 */
function createHydrationCache (state) {
  const caches = {}
  const load = (key, op, idOf) => {
    if (!caches[key]) caches[key] = new Map((state.db.call(op, {}) || []).map(r => [idOf(r), r]))
    return caches[key]
  }
  return {
    todo: id => load('todo', 'getAll', r => String(r.taskId)).get(String(id)),
    setting: key => load('setting', 'settingsRowsAll', r => r.key).get(key),
    tomato: id => load('tomato', 'tomatoAll', r => String(r.tomatoId)).get(String(id)),
    category: id => load('category', 'getAllCategories', r => String(r.categoryId)).get(String(id)),
    plan: id => load('plan', 'planAll', r => String(r.id)).get(String(id)),
    filter: id => load('filter', 'filterList', r => String(r.id)).get(String(id)),
    // meta is a KV table (no updatedAt column): the row value reads per key, and the local LWW
    // age for a key is the latest LOCAL oplog ts for it (one paged oplog scan per pass, cached).
    meta: key => state.db.call('getMeta', key),
    metaTs: () => {
      if (!caches.metaTs) {
        const m = new Map()
        let since = 0
        for (let i = 0; i < 10000; i++) {
          const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: 10000 }) || []
          for (const r of rows) if (r.entity === 'meta' && r.ts > (m.get(r.entityId) || 0)) m.set(r.entityId, r.ts)
          if (rows.length < 10000) break
          since = rows[rows.length - 1].seq
        }
        caches.metaTs = m
      }
      return caches.metaTs
    },
  }
}

/** Hydrate one oplog pointer row into a merge-ready payload row (null = not syncable). */
function hydrateRow (state, ptr, cache) {
  if (!SYNCABLE_ENTITIES.has(ptr.entity)) return null
  // Defensive GC-marker guard: legacy ('*gc*') oplog pointers (planPrune / tomatoMigrateFromMeta,
  // and pre-2026-09-18 purge rows) are ring-buffer bookkeeping, not records — hydrating one used
  // to materialize a ghost tombstone with taskId '*gc*' on peers.
  if (String(ptr.entityId) === '*gc*') return null
  const c = cache || createHydrationCache(state)
  const base = { seq: ptr.seq, entity: ptr.entity, id: ptr.entityId, ts: ptr.ts }
  try {
    if (ptr.entity === 'todo') {
      const t = c.todo(ptr.entityId)
      if (!t) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: t.updateTime || ptr.ts, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t }
    }
    if (ptr.entity === 'setting') {
      // 'sync.' namespace stays local (identity); 'securityLock*' rows hold password/question
      // CIPHERTEXT that must never egress to peers (round-3 review).
      if (isMachineLocalSettingKey(ptr.entityId)) return null
      const r = c.setting(ptr.entityId)
      if (!r) return null
      return { ...base, updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } }
    }
    if (ptr.entity === 'meta') {
      // Machine-local keys and the settings/habits blobs never egress (see the filter comments above).
      if (isMachineLocalMetaKey(ptr.entityId) || isSyncBlobMetaKey(ptr.entityId)) return null
      const v = c.meta(ptr.entityId)
      // Value absent = the pointer was a deleteMeta (meta has no tombstone column): hydrate as a
      // tombstone so the deletion propagates like every other entity's.
      if (v == null) return { ...base, updatedAt: ptr.ts, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: ptr.ts, deleted: false, deletedAt: 0, data: { key: ptr.entityId, value: v } }
    }
    if (ptr.entity === 'tomato') {
      const r = c.tomato(ptr.entityId)
      if (!r) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: r.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: r }
    }
    if (ptr.entity === 'category') {
      const cat = c.category(ptr.entityId)
      if (!cat) return { ...base, deleted: true, deletedAt: ptr.ts, data: null } // tombstone hydration gap (see bootstrap header)
      return { ...base, updatedAt: cat.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: cat }
    }
    if (ptr.entity === 'plan') {
      const p = c.plan(ptr.entityId)
      if (!p) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: ptr.ts, deleted: false, deletedAt: 0, data: p }
    }
    if (ptr.entity === 'filter') {
      const f = c.filter(ptr.entityId)
      if (!f) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: ptr.ts, deleted: false, deletedAt: 0, data: f }
    }
  } catch (e) { log.warn('[LanSync] hydrate failed for', ptr.entity, ptr.entityId, e.message) }
  return null
}

/** Content equality mirroring merge.mjs's contentDiffers (not exported there): bookkeeping fields
 *  (id/updatedAt/seq/deviceId/deletedAt markers + `deleted`) are excluded; `userId` too — peers
 *  stamp rows with their own local account id, so a userId-only difference must never churn. */
function rowContentDiffers (a, b) {
  const SKIP = new Set(['id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'deleted', 'entity', 'ts', 'userId'])
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (SKIP.has(k)) continue
    const va = a[k]
    const vb = b[k]
    if (va === vb) continue
    // Payload objects (row.data) must be compared by CONTENT, not reference — otherwise the
    // "identical content: no-op" merge rule never fires and every round churns (round-3 fix).
    // contentFingerprint additionally omits userId at every depth: each device re-stamps its
    // own account id on write, so a data.userId-only difference is not content (loop fix
    // 2026-09-18 — this compare used to keep the perpetual per-round conflict loop alive).
    if (va && vb && typeof va === 'object' && typeof vb === 'object') {
      // Key-order-insensitive canonical compare (peers build payloads with different key order)
      if (mergeCore.contentFingerprint(va) !== mergeCore.contentFingerprint(vb)) return true
      continue
    }
    return true
  }
  return false
}

/**
 * Local account id (round-3 review, item: userId passthrough). Inbound rows carry the PEER's
 * userId verbatim — cross-account pollution plus an identifier leak. Determined from the local
 * todos' userId (the same value renderer genTaskId stamps); falls back to the offline default
 * profile id (renderer utils/core.js loadLocalUser). Memoized per sync session: the local
 * account never changes while the node runs.
 */
function localUserId (state) {
  if (state.localUserId != null) return state.localUserId
  try {
    for (const t of state.db.call('getAll', { deleted: null }) || []) {
      if (t && t.userId != null) { state.localUserId = t.userId; return state.localUserId }
    }
  } catch { /* fall through to the default */ }
  state.localUserId = 840001
  return state.localUserId
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
const SKEW_CLAMP_MS = 10 * 60 * 1000
function clampSkew (row) {
  if (!row || typeof row !== 'object') return row
  const now = Date.now()
  const limit = now + SKEW_CLAMP_MS
  const future = (row.updatedAt > limit) || (row.deletedAt > limit)
  if (!future) return row
  const out = {
    ...row,
    updatedAt: row.updatedAt > limit ? now : row.updatedAt,
    deletedAt: row.deletedAt > limit ? now : row.deletedAt,
  }
  if (out.data && typeof out.data === 'object') {
    const d = { ...out.data }
    if (Number(d.updateTime) > limit) d.updateTime = now
    if (Number(d.deletedAt) > limit) d.deletedAt = now
    out.data = d
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
  } catch (e) { log.warn('[LanSync] conflict-copy dedup scan failed:', e.message) }
  return false
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
    if (t) localRow = { updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t }
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
    localRow = { updatedAt: cache.metaTs().get(incoming.id) || 0, deleted: false, deletedAt: 0, data: { key: incoming.id, value: localVal } }
  } else if (entity === 'tomato') {
    const r = cache.tomato(incoming.id)
    // tomatoAll filters deleted=0 (db.js), so a local tomato tombstone reads as "absent" here;
    // localRow stays null and the incoming row (including its tombstone) wins and is landed via
    // the tomatoRemoveByIds branch below — the tombstone still takes effect, idempotently.
    if (r) localRow = { updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r }
  } else if (entity === 'category') {
    const c = cache.category(incoming.id)
    if (c) localRow = { updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c }
  } else if (entity === 'plan') {
    // planAll/filterList do not SELECT updatedAt (db.js), so the local LWW age is UNKNOWN, not 0.
    // An honest LWW is impossible across that domain: treating unknown as 0 makes every remote
    // row (ts > 0) win, so two devices ping-pong plan/filter edits every round, each clobbering
    // the other newer state. ageUnknown rows are therefore SKIPPED for live-row writes
    // (conservative); tombstones still land (deletion propagation is strictly safer).
    const c = cache.plan(incoming.id)
    if (c) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, ageUnknown: true, data: c }
  } else if (entity === 'filter') {
    const f = cache.filter(incoming.id)
    if (f) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, ageUnknown: true, data: f }
  }
  // Symmetric tie-breaks (merge.mjs compareRecency): the local side must carry THIS device's
  // id so a full LWW tie resolves to the same winner on both peers instead of flip-flopping
  // on insertion order (loop fix 2026-09-18; inbound rows are stamped with the sender's id
  // at the transport boundary in lan-sync-bootstrap).
  if (localRow && localRow.deviceId == null && state.deviceId) localRow.deviceId = state.deviceId
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
        const copyId = `${baseId}-conflict-${Date.now().toString(36)}`
        state.pendingWrites.todos.push({ ...conflictCopy.data, taskId: copyId, delete: 1, deletedAt: Date.now() })
        log.warn('[LanSync] conflict on', entity, baseId, '— loser materialized to recycle bin as', copyId)
      }
      // P1-5: the user-facing toast is driven by the round summary (one per round, see markConflict)
      markConflict(state, 'todo', (conflictCopy.data && conflictCopy.data.taskContent) || baseId, false)
    } else {
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
      // upsertMany.
      state.pendingWrites.todos.push({ taskId: incoming.id, delete: 1, deletedAt: winner.deletedAt || incoming.deletedAt || 0 })
      return true
    }
    if (!winner.data) return false
    // userId normalization at the sync boundary (round-3 review): the row lands with THIS
    // device's account id, never the peer's.
    state.pendingWrites.todos.push({ ...winner.data, taskId: winner.data.taskId != null ? winner.data.taskId : incoming.id, userId: localUserId(state) })
  } else if (entity === 'setting') {
    if (winner.deleted) {
      // Tombstone winner (delete-wins). settingsRowPut/putRow clears `deleted` on write, so pushing
      // the (data-carrying) tombstone through the buffer would RESURRECT the row; land the
      // deletion through the dedicated tombstone op instead. Direct sync call: deletes are rare
      // and tiny, no bulk buffering needed.
      state.db.call('settingsRowDelete', { key: incoming.id })
      markAppliedSetting(state, incoming.id, undefined) // P1-2a: blob field dropped + hot-apply bookkeeping
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.settings.push({ key: incoming.id, value: winner.data.value })
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
      state.db.call('tomatoRemoveByIds', [incoming.id])
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.tomatoes.push(winner.data)
  } else if (entity === 'category' && winner.data) {
    // Bulk-buffered (2026-09-18): a first-sync snapshot can carry hundreds of categories —
    // one commit per row starved rounds the same way todos did before the write buffer.
    state.pendingWrites.categories.push({ ...winner.data, id: winner.data.categoryId })
  } else if (entity === 'plan') {
    if (incoming.deleted) {
      // Ghost-tombstone guard (2026-09-19 live storm): a plan pointer whose chip planAll cannot
      // see hydrates as a tombstone (see hydrateRow), and planRemoveIds logged the delete into
      // the oplog EVEN when we never had the chip — so both peers echoed the same delete back
      // and forth at ~1000 oplog rows/s and every round carried the whole echo (120s+ rounds).
      // Only delete a chip we actually have; a ghost tombstone is a no-op.
      if (localRow) state.db.call('planRemoveIds', [incoming.id])
      else return false
    } else if (localRow && localRow.ageUnknown) return false // cross-domain LWW: local age unknown, refuse to clobber
    else state.pendingWrites.plans.push(winner.data) // bulk-buffered via planAddMany at flush
  } else if (entity === 'filter') {
    if (incoming.deleted) {
      // Same ghost-tombstone guard as plan: never re-capture a delete for a filter we don't have.
      if (localRow) state.db.call('filterDelete', Number(incoming.id))
      else return false
    } else if (localRow && localRow.ageUnknown) return false // cross-domain LWW: local age unknown, refuse to clobber
    else state.pendingWrites.filters.push({ ...winner.data, id: Number(incoming.id) }) // bulk-buffered
  } else if (entity === 'meta') {
    // GAP-A fix (2026-09-19): meta lands through the regular setMeta/deleteMeta ops (re-captured
    // into the local oplog, which is what acknowledges the state back to the peer). LWW-newer-wins
    // with NO conflict copy for meta: it is a KV table whose values are whole documents — a losing
    // whole-document copy has no recycle-bin semantics, and convergence is already guaranteed by
    // the identical-content no-op above (both peers deterministically settle on the newer ts).
    if (winner.deleted) {
      state.db.call('deleteMeta', incoming.id)
      return true
    }
    if (!winner.data) return false
    state.db.call('setMeta', [incoming.id, winner.data.value])
    // Running-tomato announcements (feature: live cross-device focus countdown): after the
    // peer's announce key landed, fan it out to the renderer. Announce keys pass the
    // machine-local filter on purpose (display-only remote runtime; see tomato-announce.js).
    if (require('./tomato-announce').isAnnounceKey(incoming.id)) {
      require('./tomato-announce').emitRemoteAnnounce(incoming.id, winner.data.value)
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
 */
function flushPendingWrites (state) {
  const buf = state.pendingWrites
  // Per-buffer-op isolation (round-3 review): ONE malformed row used to throw out of a single
  // bulk op and leave every buffer dirty — the throw re-fired on every later flush, wedging
  // apply AND flush forever (poison-pill row). Now each op gets its own try/catch: a failing op
  // drops only ITS buffer segment with log.error (the data stays in the oplog, so it remains
  // recoverable via a later snapshot), the buffers clear either way, and the other ops proceed.
  const flushOne = (list, op) => {
    if (!list || !list.length) return
    try { state.db.call(op, list) } catch (e) {
      log.error(`[LanSync] flush ${op} failed — dropping ${list.length} buffered rows (recoverable via snapshot):`, e && e.message)
    }
  }
  flushOne(buf.todos, 'upsertMany')
  flushOne(buf.settings, 'settingsRowPutMany')
  flushOne(buf.tomatoes, 'tomatoAppendMany')
  flushOne(buf.categories, 'upsertCategoryMany')
  flushOne(buf.plans, 'planAddMany')
  flushOne(buf.filters, 'filterUpsertMany')
  buf.todos = []
  buf.settings = []
  buf.tomatoes = []
  if (buf.categories) buf.categories = []
  if (buf.plans) buf.plans = []
  if (buf.filters) buf.filters = []
}

/**
 * Local max oplog seq — reported to peers as `ack.appliedToSeq` so their per-peer push watermarks
 * can advance and rounds ship deltas instead of re-pushing the full backlog every time.
 * syncOplogSince is ascending-only with a clamped limit, so page forward; the ring buffer keeps
 * ~10k rows, so this is one query in practice (two at most right after a trim boundary).
 */
function readMaxOplogSeq (state) {
  let since = 0
  for (let i = 0; i < 10000; i++) {
    const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: 10000 }) || []
    if (rows.length < 10000) return rows.length ? rows[rows.length - 1].seq : since
    since = rows[rows.length - 1].seq
  }
  return since
}

module.exports = {
  SYNCABLE_ENTITIES,
  SECURITY_LOCK_KEY,
  // Exported (2026-09-19): lan-sync-bootstrap destructures this for allRows()/hydration skips —
  // the missing export made every allRows() call (legacy seed, snapshot serving) throw TypeError.
  isMachineLocalSettingKey,
  // Exported (2026-09-19, GAP-A): lan-sync-bootstrap's allRows() uses both to keep machine-local
  // meta and the settings/habits blobs out of snapshot/seed pushes.
  isMachineLocalMetaKey,
  isSyncBlobMetaKey,
  createHydrationCache,
  hydrateRow,
  rowContentDiffers,
  localUserId,
  clampSkew,
  applyRowSafe,
  consumeAppliedRound,
  flushPendingWrites,
  readMaxOplogSeq,
}
