'use strict'
/**
 * Sync apply hydration layer (extracted from sync-apply.js, structure-size ratchet — verbatim move).
 *
 * Everything that CLASSIFIES and HYDRATES an oplog pointer lives here:
 *   - the syncable-entity set + machine-local key filters (egress and ingress gates)
 *   - createHydrationCache (per-pass entity caches) + hydrateRow (oplog pointer -> merge-ready row)
 *
 * Pure moves only: the merge/apply pipeline stays in sync-apply.js, which re-exports these so
 * the lan-sync-bootstrap and the test harness keep their single require surface.
 */

const { SYNC_OPLOG_KEEP, oplogKeepLimit } = require('./db-oplog') // D3 2026-09-24: oplog page size derives from the ring retention (was bare 10000s)
// Domain-1 F-A1 (2026-09-23): the machine-local setting predicate lives in
// shared/machine-local-keys.mjs — single source; the manifest imports the same module.
const { isMachineLocalSettingKey } = require('../../shared/machine-local-keys.mjs')

// Entities whose local-counterpart lookup shares the live-row-then-tombstone-fallback shape
// (cache key names into createHydrationCache). todo/setting/meta/category stay hand-rolled in
// applyRowInner/hydrateRow — their lookup is genuinely bespoke (KV age from the oplog, raw-row
// tombstone columns, machine-local gates); the manifest documents that in the entity rows.
const TOMB_FALLBACK_LOOKUP = {
  tomato: { live: 'tomato', tomb: 'tomatoTomb' },
  plan: { live: 'plan', tomb: 'planTomb' },
  filter: { live: 'filter', tomb: 'filterTomb' }
}

const SYNCABLE_ENTITIES = new Set(['todo', 'setting', 'tomato', 'category', 'plan', 'filter', 'meta'])
// settings_rows keys holding password/question CIPHERTEXT — never egress, never ingress (round-3).
const SECURITY_LOCK_KEY = /^securityLock/

// Announce beacons are exempt from the B13 age-unknown refusal (see applyRowInner meta path).
const ANNOUNCE_KEY_PREFIX = 'tomatoRunAnnounce.'
const isAnnounceMetaKey = key => String(key || '').startsWith(ANNOUNCE_KEY_PREFIX)

// GAP-A fix (2026-09-19): meta rows (projectMilestones:*, projectCategoryIds, tomatoEstimateState,
// projectDeadline:/projectStatus:, repeatRule:*, ...) were captured into the oplog but never
// hydrated/applied, so they never reached peers. These meta keys are machine-local and must
// neither egress nor be overwritten by a peer's row — the full family list now lives in the
// SHARED module (domain-3 fix 2026-09-28, same single-sourcing the settings predicate got in
// F-A1): command-manifest.js's localKeys classifier imports the same function, so the
// check-command-bus mirror-agreement assert holds by construction instead of by sync'd copies.
const { isMachineLocalMetaKey, META_CONFLICT_BACKUP_PREFIX } =
  require('../../shared/machine-local-keys.mjs')

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
    tomatoTomb: id => load('tomatoTomb', 'tomatoTombstones', r => String(r.tomatoId)).get(String(id)),
    // M1 (2026-09-20): categories read RAW ROW shape (categoriesAllRows, tombstones included) —
    // the hydrated app shape (categoryName/...) has no row columns, so pushing it through
    // upsertCategoryMany threw "Invalid value" in better-sqlite3 and flushOne dropped the whole
    // categories buffer (category sync never landed); it also had no updatedAt (snapshot age 0).
    category: id => load('category', 'categoriesAllRows', r => String(r.id)).get(String(id)),
    plan: id => load('plan', 'planAll', r => String(r.id)).get(String(id)),
    filter: id => load('filter', 'filterList', r => String(r.id)).get(String(id)),
    // M3 (2026-09-20): tombstone reads — a LOCALLY deleted plan/filter must take part in inbound
    // LWW like a settings/tomato tombstone, otherwise ANY peer live row (even older) resurrects
    // it (categories need no separate read: categoriesAllRows carries their tombstones).
    planTomb: id => load('planTomb', 'planTombstones', r => String(r.id)).get(String(id)),
    filterTomb: id => load('filterTomb', 'filterTombstones', r => String(r.id)).get(String(id)),
    // meta is a KV table (no updatedAt column): the row value reads per key, and the local LWW
    // age for a key is the latest LOCAL oplog ts for it (one paged oplog scan per pass, cached).
    meta: key => state.db.call('getMeta', key),
    metaTs: () => metaStats().map,
    // D11 finding 4 (meta reconciliation): the ts of the OLDEST retained oplog row. A key whose
    // pointers all trimmed provably last changed at or before this floor — the bound both the
    // ingress accept rule (sync-apply.js) and the egress snapshot enumeration (metaSnapshotRows)
    // compare against. 0 = empty ring (every key is "first landing").
    metaFloorTs: () => metaStats().floor,
  }
  // One paged scan feeds both the per-key age map and the ring floor (D11 finding 4).
  function metaStats () {
    if (!caches.metaStats) {
      const m = new Map()
      let floor = 0
      let since = 0
      for (let i = 0; i < SYNC_OPLOG_KEEP; i++) {
        const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: oplogKeepLimit(SYNC_OPLOG_KEEP) }) || []
        if (rows.length && !floor) floor = rows[0].ts || 0 // ascending seq: the first row is the oldest retained
        for (const r of rows) if (r.entity === 'meta' && r.ts > (m.get(r.entityId) || 0)) m.set(r.entityId, r.ts)
        if (rows.length < SYNC_OPLOG_KEEP) break
        since = rows[rows.length - 1].seq
      }
      caches.metaStats = { map: m, floor }
    }
    return caches.metaStats
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
      // Provenance rides TOP-LEVEL (protocol v3, 2026-09-29): withPeerDeviceId only overwrites
      // `deviceId` (the hop/tie-break stamp), so `author` survives every relay — that is the
      // whole point. '' = pre-v7 legacy row (unknown author).
      return { ...base, author: t.syncAuthor || '', updatedAt: t.updateTime || ptr.ts, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t }
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
      // M1 (2026-09-20): data is the RAW ROW shape (see the cache comment) — the apply path
      // pushes it straight through upsertCategory, which binds the row columns. A locally
      // tombstoned row hydrates as a tombstone with its real age (M3/LWW).
      const cat = c.category(ptr.entityId)
      // D13 finding 8: a row-PRESENT tombstone carries its honest deletedAt (legacy pre-D5
      // deletes have deletedAt=0 — the old `(cat && cat.deletedAt) || ptr.ts` fabricated the
      // oplog pointer time as the deletion age, falsifying LWW and recycle-bin retention math,
      // exactly what the todo branch's D12 fix stopped). The ptr.ts fallback stays ONLY for the
      // row-gone case, where no stamp exists anywhere.
      if (!cat) return { ...base, updatedAt: ptr.ts, deleted: true, deletedAt: ptr.ts, data: null }
      if (cat.deleted) return { ...base, updatedAt: cat.updatedAt || ptr.ts, deleted: true, deletedAt: cat.deletedAt || 0, data: null }
      return { ...base, updatedAt: cat.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: cat }
    }
    if (ptr.entity === 'plan' || ptr.entity === 'filter') {
    // Manifest-documented plan/filter hydration (TOMB_FALLBACK_LOOKUP): identical shape, differing only in the cache
    // keys — live row first, tombstone fallback. M3: a locally deleted chip/filter hydrates from its tombstone read
    // with its real age so the deletion (not a fake ptr.ts age) participates in egress LWW. F3a/F3b (2026-09-20):
    // planAll/filterList now SELECT updatedAt — use the chip's real age so LWW works.
    const keys = TOMB_FALLBACK_LOOKUP[ptr.entity]
    const p = c[keys.live](ptr.entityId) || c[keys.tomb](ptr.entityId)
    if (!p) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
    // Tomb reads carry no `deleted` col (only deletedAt) — `p.deleted` never fired, so locally deleted chips hydrated LIVE (deletion never propagated).
    if (p.deleted || p.deletedAt) return { ...base, updatedAt: p.updatedAt || ptr.ts, deleted: true, deletedAt: p.deletedAt || ptr.ts, data: null }
    return { ...base, updatedAt: p.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: p }
  }
  } catch (e) {
    // r2 2026-09-28: a DB read failure is NOT the same as "not syncable". The old catch-all
    // collapsed both into `null`, so the LAN push's map+filter(Boolean) silently dropped the
    // oplog pointer while the cursor advanced past it — changes were lost one-way between full
    // snapshots with nothing but a local log.warn as a trace. RETHROW with the pointer attached;
    // the batch layer (lan-sync-bootstrap getRowsSince) catches per-pointer and counts the loss
    // into its egress report instead of swallowing it. Only the entity/local-key/gc branches
    // above return null (= legitimate skip).
    e.egressHydration = { entity: ptr.entity, id: ptr.entityId, seq: ptr.seq }
    throw e
  }
}

module.exports = {
  SYNCABLE_ENTITIES,
  SECURITY_LOCK_KEY,
  TOMB_FALLBACK_LOOKUP,
  ANNOUNCE_KEY_PREFIX,
  isAnnounceMetaKey,
  META_CONFLICT_BACKUP_PREFIX,
  isMachineLocalMetaKey,
  isSyncBlobMetaKey,
  isMachineLocalSettingKey,
  createHydrationCache,
  hydrateRow,
}
