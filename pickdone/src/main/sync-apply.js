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

// Machine-local bookkeeping keys: CLI last-seen/save stamps are per-device state, not user
// data — syncing them made the two hosts fight over them every round (log noise, LWW churn).
// Domain-1 F-A1 (2026-09-23): the predicate moved to shared/machine-local-keys.mjs — the
// manifest used to carry a hand-maintained mirror AND the old three-branch version let
// machine-level config keys (enableSecurityLock/shortcutKeySettings/runWhenComputerStart/
// hideMainWindowOnStartup) through, so a peer could silently disable the security lock or
// re-register hotkeys here. Single source now; the manifest imports the same module.
const { isMachineLocalSettingKey } = require('../../shared/machine-local-keys.mjs')

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
    k.startsWith('cliTomato') ||
    // CLI sync command channel slots (feat/cli-sync-pair): cmd/receipt/seq are per-machine
    // transport state, never data — syncing them would replay stale commands on the peer.
    k.startsWith('cliSync') || k === 'todosVersion' || k.startsWith('firedReminders:') ||
    k === 'reminderLastSeenAt' || k.startsWith('settingsRows.src.') ||
    k === 'db.tomatoState' || k === 'habitsState' ||
    // M4 (2026-09-20): snowDedup:<task>:<key> = per-device dedup watermarks (bumpSnow), not data.
    k.startsWith('snowDedup:') ||
    // P1-5 (2026-09-19 data-safety round): meta LWW conflict backups are per-device recovery
    // copies of a LOSING local edit — they must stay local (syncing them would make the peer
    // apply the loser as a live value and mint its own backup of the backup, forever).
    // ALLOWLIST NOTE (P2-g): every key excluded here is deliberate machine-local state; any
    // NEW user-data meta key must NOT be added to this filter or it silently stops syncing.
    k.startsWith(META_CONFLICT_BACKUP_PREFIX) ||
    // Round-3 P1 (2026-09-21): migration/bookkeeping keys — a peer syncing its 'schemaVersion'
    // row could REGRESS (or over-advance) this device's schema-migrator stamp, and a peer's
    // legacy 'dayPlanState'/'dayPlanState.bak' whole-package chip JSON would re-poison a device
    // that already migrated to the plan_chips row store (db.js migration reads these keys).
    k === 'schemaVersion' || k === 'dayPlanState' || k.startsWith('dayPlanState.')
}

// P1-5: prefix for dated meta conflict-backup keys (see the meta branch in applyRowInner).
const META_CONFLICT_BACKUP_PREFIX = 'metaConflictBackup.'

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
      // M1 (2026-09-20): data is the RAW ROW shape (see the cache comment) — the apply path
      // pushes it straight through upsertCategory, which binds the row columns. A locally
      // tombstoned row hydrates as a tombstone with its real age (M3/LWW).
      const cat = c.category(ptr.entityId)
      if (!cat || cat.deleted) return { ...base, updatedAt: (cat && cat.updatedAt) || ptr.ts, deleted: true, deletedAt: (cat && cat.deletedAt) || ptr.ts, data: null }
      return { ...base, updatedAt: cat.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: cat }
    }
    if (ptr.entity === 'plan' || ptr.entity === 'filter') {
    // Manifest-documented plan/filter hydration (TOMB_FALLBACK_LOOKUP): identical shape, differing
    // only in the cache keys — live row first, tombstone-aware fallback. M3: a pointer for a locally
    // deleted chip/filter hydrates from its tombstone read with its real age so the deletion (not a
    // fake ptr.ts age) participates in egress LWW. F3a/F3b (2026-09-20): planAll/filterList now
    // SELECT updatedAt — use the chip's real age so LWW works.
    const keys = TOMB_FALLBACK_LOOKUP[ptr.entity]
    const p = c[keys.live](ptr.entityId) || c[keys.tomb](ptr.entityId)
    if (!p) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
    if (p.deleted) return { ...base, updatedAt: p.updatedAt || ptr.ts, deleted: true, deletedAt: p.deletedAt || ptr.ts, data: null }
    return { ...base, updatedAt: p.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: p }
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
    const ts36 = Date.now().toString(36)
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
      busWrite(state, 'settingsRowDelete', { key: incoming.id })
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
      busWrite(state, 'tomatoRemoveByIds', [incoming.id])
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
function flushPendingWrites (state) {
  const buf = state.pendingWrites
  let ok = true
  // Per-buffer-op isolation (round-3 review): ONE malformed row used to throw out of a single
  // bulk op and leave every buffer dirty — the throw re-fired on every later flush, wedging
  // apply AND flush forever (poison-pill row). Now each op gets its own try/catch: a failing op
  // drops only ITS buffer segment with log.error (the data stays in the oplog, so it remains
  // recoverable via a later snapshot), the buffers clear either way, and the other ops proceed.
  // Manifest-driven drain (Phase-3): buffer → bulk op mapping lives in flushRoutes (derived from
  // command-manifest.js at module load), so a buffer cannot silently lose its manifest census row.
  const flushOne = (list, op) => {
    if (!list || !list.length) return
    try { busWrite(state, op, list) } catch (e) {
      ok = false
      log.error(`[LanSync] flush ${op} failed — dropping ${list.length} buffered rows (recoverable via snapshot):`, e && e.message)
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
  return { ok } // P0-1: false = at least one bulk op threw; the segment must not be acked
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
  META_CONFLICT_BACKUP_PREFIX,
  META_CONFLICT_BACKUP_CAP,
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
  writeMetaConflictBackup,
  // Arch review 2026-09-22 rec #1: the injected-ingress write door (lan-sync-bootstrap routes
  // its manifest-op writes through the same helper so the engine stays one bus-routed surface).
  busFor,
  busWrite,
}
