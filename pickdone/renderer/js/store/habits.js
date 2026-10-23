/** Habit check-ins + countdown/memorial dates — localStorage (instantly available on first paint) + main DB meta table (durable source of truth, covered by auto backup)
 *  habit: { id, name, color, createdAt, records: { 'YYYY-MM-DD': true },
 *           frequency: { type: 'daily'|'weekdays'|'interval', weekdays: [1,3,5], intervalN: 2 } }
 *  moment: { id, name, date(YYYY-MM-DD), kind: 'countdown' | 'memorial' } */
import { commit as commitCommand } from "../utils/commandBus.js"

const LS_KEY = 'habitsState'
/** DB meta key MUST carry the `db.` prefix: the v6 sync-schema bridge (src/main/db-sync-schema.js
 *  SYNC_BLOB_KEYS) only mirrors `db.settingsState` / `db.habitsState` into settings_rows — the bare
 *  legacy `habitsState` row never synced. One-time migration: initFromDb reads `db.habitsState`
 *  falling back to the legacy key, and (on fallback) copies the blob to the new key; the legacy row
 *  is left in place during the transition (a later schema migration may sweep it). */
const META_KEY = 'db.habitsState'
const LEGACY_META_KEY = 'habitsState'
/** Aux→main relay ping: aux windows can't call setMeta (MAIN_WINDOW_ONLY_OP); they write LS + this ping,
 *  and the main window's storage listener below re-persists the blob to the DB on its behalf. */
const SYNC_KEY = 'habitsSyncPing'
/** Persistence blob format version: readers treat old unstamped data as v1 (behavior unchanged) */
const SCHEMA_V = 1
const PALETTE = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3']

/** Records-map normalization: habits restored from old backups may lack the records field entirely; the
 *  streakOf/last30/toggleCheck getters assume it exists (`h.records[k]` throws → render crash). Coerce every
 *  habit to a plain object map on load. */
export function normalizeHabitRecords (habits) {
  for (const h of (Array.isArray(habits) ? habits : [])) {
    if (!h || typeof h !== 'object') continue
    if (!h.records || typeof h.records !== 'object') h.records = {}
  }
  return habits
}

/** D15-B9 (2026-10-03, unit-tested): the module's ONE staleness predicate for inbound external
 *  rounds — TIES REJECT (prior writer wins, `<=`). applyExternalPatch used to hand-roll `<` and
 *  accept a same-ms LAN fold round, letting a tie round rewrite whole habits/moments arrays over
 *  state that had already recorded an equal-stamp write; its sibling applyExternal already used
 *  `<=` (D14-B15). Every inbound boundary below routes through this predicate so the semantics
 *  can never drift apart again. (replaceAll keeps the DB-restore tie-goes-to-DB contract and is
 *  deliberately NOT routed here — see its comment.) */
export function isStaleExternalRound (incomingSavedAt, currentSavedAt) {
  return (Number(incomingSavedAt) || 0) <= (Number(currentSavedAt) || 0)
}

/** D-wave (2026-10-14): union-max merge of two check-in records maps. Check-ins are monotonically
 *  INCREASING events, so for each day key we keep the LARGER value (a boolean `true` counts as 1).
 *  This is the semantics trade-off: a count-up style habit that was corrected DOWN on one device
 *  can be resurrected by an older peer copy — we accept losing a decrement rather than silently
 *  losing the other device's check-in, which the previous whole-array LWW replace did on EVERY
 *  concurrent check-in (the LAN fold channel is one blob, unlike settings' per-field rows). */
export function unionMaxRecords (incoming, local) {
  const out = Object.assign({}, incoming || {})
  for (const day of Object.keys(local || {})) {
    const l = Number(local[day]) || 0
    const cur = Number(out[day]) || 0
    if (l > cur) out[day] = local[day]
  }
  return out
}

/** Match incoming habits against the local array by id and fold the LOCAL check-ins that the
 *  incoming blob never saw into the incoming records (union-max). Config fields (name/color/
 *  frequency/deletion) still follow the blob-level savedAt LWW: habits absent from the incoming
 *  array stay absent, incoming config values win — only the records map is conservatively merged. */
function mergeHabitRecords (incomingHabits, localHabits) {
  const localById = new Map((localHabits || []).filter(h => h && h.id != null).map(h => [h.id, h]))
  for (const h of incomingHabits) {
    const local = h && h.id != null ? localById.get(h.id) : null
    if (local && local.records && typeof local.records === 'object') {
      h.records = unionMaxRecords(h.records, local.records)
    }
  }
  return incomingHabits
}

/** [F2 2026-10-19 P2] moments union-merge (same family as unionMaxRecords): an inbound blob only
 *  carries the moments its author KNOWS about, so the previous whole-array LWW replace silently
 *  deleted the other device's countdowns/anniversaries on every concurrent edit. Merge by id:
 *  ids present on either side survive; for an id on both sides the incoming copy wins, and
 *  undefined fields backfill from the local copy (records' per-key union-max analog). */
export function unionMoments (incoming, local) {
  const out = (incoming || []).filter(m => m && m.id != null).map(m => ({ ...m }))
  const byId = new Map(out.map(m => [m.id, m]))
  for (const m of (local || [])) {
    if (!m || m.id == null) continue
    const cur = byId.get(m.id)
    if (!cur) { out.push({ ...m }); byId.set(m.id, out[out.length - 1]) }
    else for (const k of Object.keys(m)) if (cur[k] === undefined) cur[k] = m[k]
  }
  return out
}

/** [F3 fix] delete tombstones: delHabit records `{ id, deletedAt }` in the blob's `deleted` array,
 *  so a peer blob that still carries the habit (its savedAt may even be newer) can no longer
 *  resurrect it through mergeHabitRecords/applyExternal/applyExternalPatch. Backward compatible:
 *  blobs without a `deleted` field behave exactly as before (field optional, old readers ignore it,
 *  old blobs merge to an empty list).
 *  Cross-device caliber (minimal correct version): a tombstone WINS regardless of savedAt —
 *  deletion is sticky. Rationale: a habit id is `Date.now() + random suffix`, so a "re-created"
 *  habit with the same id is impossible by construction; any id reappearing in an inbound blob is
 *  a stale peer copy, and re-adding through addHabit mints a fresh id that no tombstone shadows.
 *  Records maps of surviving habits keep the d846a3e3 union-max merge — untouched. */
export function mergeHabitTombstones (local, incoming) {
  const out = new Map((local || []).filter(t => t && t.id != null).map(t => [t.id, Number(t.deletedAt) || 0]))
  for (const t of (incoming || [])) {
    if (!t || t.id == null) continue
    const at = Number(t.deletedAt) || 0
    if (!out.has(t.id) || at > (out.get(t.id) || 0)) out.set(t.id, at)
  }
  return Array.from(out, ([id, deletedAt]) => ({ id, deletedAt }))
}

/** Drop tombstoned ids from an inbound habits array (returns the array unchanged when nothing is
 *  tombstoned). Applied at every inbound boundary so a peer blob can never resurrect a deletion. */
export function applyHabitTombstones (habits, tombstones) {
  const dead = new Set((tombstones || []).filter(t => t && t.id != null).map(t => t.id))
  if (!dead.size) return habits
  return habits.filter(h => !(h && h.id != null && dead.has(h.id)))
}

/** [W7-R 2026-10-23 P2] moments deletion tombstones — same shape and stickiness caliber as the
 *  habits `deleted` array above. delMoment used to only filter the local array, so a peer blob
 *  (or a synced round with an equal/newer savedAt) whose `moments` still carried the deleted id
 *  resurrected it through the unionMoments merge at every inbound boundary (union-merge keeps
 *  ids present on EITHER side — exactly the resurrection vector). `deletedMoments` rides the
 *  blob top level next to `deleted`; both the tombstone-shape helpers above are id-generic
 *  ({ id, deletedAt }), so they are reused as-is (aliases exported for readability/tests). */
export const mergeMomentTombstones = mergeHabitTombstones
export const applyMomentTombstones = applyHabitTombstones

function readLs () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    // Format-version tolerance: old unstamped data treated as v1 (behavior unchanged)
    if (d && Array.isArray(d.habits) && (d.schemaV || 1) <= SCHEMA_V) { normalizeHabitRecords(d.habits); return d }
  } catch {}
  return null
}

/** First-paint state: localStorage takes precedence (synchronously available); newer values from the main DB are merged by initFromDb at startup */
function load () {
  const d = readLs()
  if (d) return { habits: d.habits, moments: d.moments || [], savedAt: d.savedAt || 0, deleted: d.deleted || [], deletedMoments: d.deletedMoments || [] }
  return { habits: [], moments: [], savedAt: 0, deleted: [], deletedMoments: [] }
}

/** Aux-window detection: same judgment as dbMirror's writeNow (float / quick-add hashes).
 *  setMeta is a MAIN_WINDOW_ONLY_OP — an aux window's direct dbCall is rejected by the main process,
 *  which previously left the aux window's LS edit never reaching the durable DB copy.
 *  Review P3 (2026-09-22): the helper is centralized in utils/auxWindow.js (shared with
 *  todoBackup/settings); re-exported here for the existing habits-specific importers. */
export { isAuxWindow } from '../utils/auxWindow.js'
import { isAuxWindow } from '../utils/auxWindow.js'
// B7 (daily 2026-09-24): reuse dbMirror's read sentinel — same fix family as F-C4 on the
// settings side. The old inline getMeta + silent catch collapsed "read FAILED" into "no
// mirror": a transient getMeta rejection at startup left the stale LS blob in place and the
// NEXT persist() drowned the (newer) durable DB copy under it.
import { restoreFromDb, DB_MIRROR_ERROR, consumeUnflushed } from '../utils/dbMirror.js'
import { preserveCorrupt } from '../utils/corrupt-quarantine.js'
// F-C7 (maint/dw wave3): local day-key from the shared module — was hand-rolled twice below
import { localDayKey } from '../../../shared/date-key.mjs'

/** Dual write: localStorage (synchronous fallback) + main DB meta table (source of truth, included in auto backup).
 *  Aux windows: LS write + relay ping only — the main window's storage listener persists to the DB on their behalf. */
function persist (state) {
  // [F3 fix] the blob now carries the deletion tombstones (additive field — old readers/blobs
  // without it behave unchanged)
  const blob = { schemaV: SCHEMA_V, habits: state.habits, moments: state.moments || [], savedAt: Date.now(), deleted: state.deleted || [], deletedMoments: state.deletedMoments || [] }
  state.savedAt = blob.savedAt
  try { localStorage.setItem(LS_KEY, JSON.stringify(blob)) } catch {}
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return
    if (isAuxWindow()) {
      try { localStorage.setItem(SYNC_KEY, String(Date.now()) + ':' + Math.random().toString(36).slice(2)) } catch (e) { /* empty */ }
      return
    }
    // 2026-09-12: silent .catch(() => {}) hid meta write failures (DB is the durable source of truth) — log them
    commitCommand("meta", "put", [META_KEY, JSON.stringify(blob)]).catch(e => console.error('[habits] setMeta failed:', e))
  } catch (e) { /* empty environment */ }
}

// Main window relay: an aux window's habits edit arrives via LS + ping; the main window re-reads the
// blob, feeds it into the main window's Vuex state (applyExternal — otherwise the next main-window
// persist would overwrite the aux edit with stale state) and writes the durable DB meta row on its
// behalf (storage events only fire in the OTHER windows, so the writer never relays itself).
let externalApplier = null
/** Hook for main.js: register a callback receiving every external (aux-window) habits blob so it can
 *  be applied to the main window's Vuex store. U-10: the callback must RETURN whether the blob was
 *  accepted (same savedAt guard as applyExternal) — the relay only persists accepted blobs to the DB. */
export function onExternalHabitBlob (fn) { externalApplier = typeof fn === 'function' ? fn : null }

/** Test seam: the relay runs from the module-level storage listener; behavior tests invoke it directly. */
export const _testInternals = { relayAuxBlob }

function relayAuxBlob () {
  // 2026-10-09 P3: distinguish "no blob at all" (consume the ping — nothing to relay) from "blob
  // present but corrupt" (KEEP the ping). The old `if (!d) removeItem(SYNC_KEY)` collapsed both:
  // a corrupt LS blob (quota-corrupt JSON / shape junk) silently consumed every aux check-in ping
  // — the float window's check-ins were dropped forever with no trace. Corrupt bytes go through
  // the codebase's quarantine-first contract (preserveCorrupt) so they can be recovered, the
  // error is loud, and the ping stays on its retry channel.
  let raw = null
  try { raw = localStorage.getItem(LS_KEY) } catch (e) { raw = null }
  if (raw == null) { try { localStorage.removeItem(SYNC_KEY) } catch (e) { /* empty */ } return }
  const d = readLs()
  if (!d) {
    console.error('[habits] relay: LS blob corrupt — ping KEPT for retry (aux check-in not dropped)')
    try { preserveCorrupt('habits.relay', LS_KEY, raw) } catch (e) { console.error('[habits] relay: corrupt-blob quarantine failed:', e) }
    return
  }
  try {
    // U-10 (2026-09-20): the durable DB write only happens when applyExternal ACCEPTED the blob.
    // The applier's savedAt guard rejects stale rounds; writing the rejected (stale) blob to the DB
    // anyway clobbered the newer DB state with older data. No applier registered (headless/test) →
    // write directly, the blob is the freshest state known to this window.
    let accepted = true
    if (externalApplier) {
      accepted = false
      try { accepted = externalApplier(d) === true } catch (e) { console.error('[habits] external blob apply failed:', e) }
    }
    if (!accepted) return
    // The ping is consumed only after the durable DB write settles: consuming it up front let one
    // failed IPC drop the aux edit from the retry channel entirely (the next main-window persist
    // would paper over it at best, or lose it on quit at worst).
    if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.dbCall) {
      commitCommand("meta", "put", [META_KEY, JSON.stringify(d)]).then(
        () => { try { localStorage.removeItem(SYNC_KEY) } catch (e) { /* empty */ } },
        err => console.error('[habits] relay setMeta failed — ping kept for retry:', err)
      )
    }
  } catch (err) { /* empty */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !isAuxWindow()) {
  window.addEventListener('storage', e => {
    if (!e || e.key !== SYNC_KEY) return
    relayAuxBlob()
  })
  // Residual delivery: a ping written while no main window was listening (main window was closed/
  // reloading when the aux window saved) is relayed once at registration, then cleared.
  try { if (localStorage.getItem(SYNC_KEY)) relayAuxBlob() } catch (e) { /* empty */ }
}

/** Habit domain day reads are owned by the REACTIVE store.todo.todayTimestamp (refreshed by the
 *  60s day-rollover loop via store/todo.js setTodayTs). The former `todayKey()` read the wall
 *  clock through window.dayjs() with no reactive dependency, so streakOf's due-but-unchecked
 *  leniency kept answering with YESTERDAY's day key after midnight until an unrelated state
 *  change. Getters below derive the day key from localDayKey(rootState.todo.todayTimestamp) —
 *  one definition (shared/date-key.mjs), reactively refreshed. */

/** Reactive day owner, with a wall-clock fallback for direct getter calls without rootState (unit tests) */
function reactiveTodayTs (rootState) {
  return (rootState && rootState.todo && rootState.todo.todayTimestamp) || Date.now()
}

/** Whether a date is a check-in day for the habit (frequency filter) */
export function isDueOn (habit, dateKey) {
  const f = habit.frequency || { type: 'daily' }
  if (f.type === 'daily') return true
  const d = new Date(dateKey + 'T12:00:00')
  const dow = d.getDay() // 0=Sun
  const mon0 = (dow + 6) % 7 // 0=Mon
  if (f.type === 'weekdays') return (f.weekdays || []).includes(mon0)
  if (f.type === 'interval') {
    const created = new Date(habit.createdAt || Date.now())
    created.setHours(12, 0, 0, 0)
    const diff = Math.round((d.getTime() - created.getTime()) / 86400000)
    return diff >= 0 && diff % (f.intervalN || 1) === 0
  }
  return true
}

export default {
  namespaced: true,
  state: () => load(),
  getters: {
    streakOf: (s, g, rootState) => id => {
      const h = s.habits.find(x => x.id === id)
      if (!h) return 0
      let streak = 0
      // Walk back day by day from the REACTIVE today (2026-10-03: the walk used to start at the
      // `new Date()` wall clock, so after midnight the lenient-today exclusion below was
      // evaluated against yesterday's day key until an unrelated state change).
      // Non-due days (frequency filter) are skipped without breaking the streak.
      // P2 root fix: the loop used to ignore isDueOn, so a Mon/Wed/Fri habit "broke" on an idle Sunday.
      // Today being due-but-unchecked doesn't break either (same lenient semantics as before).
      const d = new Date(reactiveTodayTs(rootState))
      const todayKey = localDayKey(d)
      const createdKey = h.createdAt ? localDayKey(h.createdAt) : null
      // G1 hard cap: `frequency:{type:'weekdays',weekdays:[]}` with a missing createdAt used to make both
      // loop-exit conditions unreachable (no due day ever breaks, no createdKey guard) → infinite loop,
      // frozen renderer. Two years of look-back is far beyond any meaningful streak.
      for (let guard = 0; guard < 730; guard++) {
        const k = localDayKey(d) // F-C7: shared/date-key.mjs — was the third hand-rolled copy of the same concatenation
        if (h.records[k]) { streak++ } else if (k !== todayKey && isDueOn(h, k)) break
        if (createdKey && k < createdKey) break // walked back before the habit's creation: nothing earlier can be due (loop guard)
        d.setDate(d.getDate() - 1)
      }
      return streak
    },
    last30: (s, g, rootState) => id => {
      const h = s.habits.find(x => x.id === id)
      const out = []
      const d = new Date(reactiveTodayTs(rootState)); d.setDate(d.getDate() - 29)
      for (let i = 0; i < 30; i++) {
        const k = localDayKey(d) // F-C7: shared/date-key.mjs
        out.push({ key: k, on: !!(h && h.records[k]) })
        d.setDate(d.getDate() + 1)
      }
      return out
    },
    /** Whether a habit is due on a date (frequency filter) */
    isDue: s => (id, dateKey) => {
      const h = s.habits.find(x => x.id === id)
      if (!h) return false
      return isDueOn(h, dateKey)
    }
  },
  mutations: {
    /** On startup, a newer main DB value overwrites local (last-write-wins by savedAt).
     *  Round-2 P1 F6 (2026-09-21): the restore-backup path passes {force:true} — a backup with an
     *  OLDER savedAt must still apply (the user explicitly chose to restore), and the restored
     *  blob must reach the durable DB meta row via persist(). Without force+persist the restore
     *  silently no-opped whenever local savedAt was newer and never reached DB/sync. */
    replaceAll (s, blob) {
      if (!blob || !Array.isArray(blob.habits)) return
      const force = blob.force === true
      if (!force && (blob.savedAt || 0) < (s.savedAt || 0)) return
      normalizeHabitRecords(blob.habits) // DB archive is the restore path for old backups — same missing-records guard as readLs
      // [F3 fix] deletion is sticky across restores too: merge the blob's tombstones with the
      // local ones, then drop tombstoned ids from the incoming array (an old backup without the
      // `deleted` field cannot resurrect a habit deleted after it was taken).
      s.deleted = mergeHabitTombstones(s.deleted, blob.deleted)
      s.habits = applyHabitTombstones(blob.habits, s.deleted)
      // [W7-R P2] sticky tombstone merge for moments too (same caliber as the `deleted` line
      // above): an old backup without `deletedMoments` cannot resurrect a moment deleted after
      // the backup was taken; the inbound array is filtered before it lands.
      s.deletedMoments = mergeMomentTombstones(s.deletedMoments, blob.deletedMoments)
      s.moments = applyMomentTombstones(blob.moments || [], s.deletedMoments)
      s.savedAt = blob.savedAt || 0
      // 2026-10-09 P3: `force` is an INTERNAL control flag (restore-backup override), not blob
      // content — strip it from the persisted copy so it never reaches LS/DB or the sync fan-out
      // (same internal-field discipline as todo.js's deleting flag strip).
      const clean = Object.assign({}, blob); delete clean.force
      clean.deleted = s.deleted // tombstones survive the LS rewrite (see persist()'s blob shape)
      clean.deletedMoments = s.deletedMoments
      try { localStorage.setItem(LS_KEY, JSON.stringify(clean)) } catch {}
      if (force) persist(s) // dual-write: durable DB meta row (single writer discipline kept — persist() IS the store's writer)
    },
    /** G1: an aux window's habits edit relayed through the main window — update the main window's Vuex
     *  state so its next persist doesn't resurrect stale data and clobber the aux edit (LS already holds
     *  the blob; no persist here to avoid an echo loop). Last-write-wins guard; D14-B15 (2026-10-01):
     *  TIES now reject (prior writer wins, `<=` not `<`), aligning this boundary with the
     *  settings.js initFromDb LWW doctrine (D13-B15: an equal stamp never lets a late-arriving copy
     *  re-write state that already recorded it). Note replaceAll deliberately KEEPS `<`: it is the
     *  DB-restore boundary where settings' doctrine resolves ties in the DB blob's favor — applying
     *  the DB blob on a tie IS the aligned behavior there, no change needed. */
    applyExternal (s, blob) {
      if (!blob || !Array.isArray(blob.habits)) return
      if (isStaleExternalRound(blob.savedAt, s.savedAt)) return
      normalizeHabitRecords(blob.habits)
      // D-wave (2026-10-14): the blob still wins as a whole (config LWW), but its records maps are
      // union-max merged with the local ones first — two devices checking in different days must
      // not lose either side just because the newer blob replaced the whole array.
      // [F3 fix] tombstones first (merged from the peer blob AND local), then filter the inbound
      // array — a peer blob that still carries a deleted habit can no longer resurrect it.
      s.deleted = mergeHabitTombstones(s.deleted, blob.deleted)
      s.habits = mergeHabitRecords(applyHabitTombstones(blob.habits, s.deleted), s.habits)
      // [W7-R P2] moments: merge the peer's deletion tombstones first, then filter the inbound
      // array BEFORE the union-merge — unionMoments keeps ids present on either side, so an
      // unfiltered deleted moment would be resurrected by the local copy every round.
      s.deletedMoments = mergeMomentTombstones(s.deletedMoments, blob.deletedMoments)
      // F2 2026-10-19: same union-merge as records — a newer peer blob must not erase this
      // device's moments (countdowns/anniversaries) it never saw.
      s.moments = unionMoments(applyMomentTombstones(blob.moments, s.deletedMoments), s.moments)
      s.savedAt = Math.max(blob.savedAt || 0, s.savedAt || 0)
    },
    /** F2 (2026-09-20): LAN-sync habits fold channel — S1's main process emits
     *  'external-habits-changed' with { fields: { habits?, moments? }, savedAt }. Merge the peer
     *  fields into state WITHOUT persisting: the incoming savedAt is recorded as applied, so the
     *  next persist (triggered only by a real user edit) writes the merged state once and the
     *  applied echo is dropped by the monotonic savedAt guard — no feedback loop. Partial fields
     *  are allowed (a round that only touched moments must not need a habits array). */
    applyExternalPatch (s, payload) {
      if (!payload || typeof payload !== 'object') return
      const fields = (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields))
        ? payload.fields
        : payload // tolerate the bare blob shape { habits, moments, savedAt }
      const savedAt = Number(payload.savedAt) || Number(fields.savedAt) || 0
      // [patch-savedat-guard fix] a missing/0 savedAt used to bypass the staleness guard and apply
      // unconditionally; siblings replaceAll/applyExternal treat missing savedAt as 0 and reject
      // against a saved local state. Same rule via the shared predicate (D15-B9): an unsaved or
      // tied patch is stale — drop it (ties previously slipped through `<`).
      if (isStaleExternalRound(savedAt, s.savedAt)) return // stale/tied peer round — already superseded
      let changed = false
      // D-wave (2026-10-14): same conservative records merge as applyExternal — the LAN fold
      // channel used to swap the whole habits array, silently dropping the other device's
      // concurrent check-in whenever the incoming savedAt was newer.
      // [F3 fix] the peer round may also carry deletion tombstones (fields.deleted, or top-level
      // on the bare-blob shape): merge them first, then filter the inbound array so a peer copy
      // still holding a deleted habit cannot resurrect it.
      const tombs = Array.isArray(fields.deleted) ? fields.deleted : (Array.isArray(payload.deleted) ? payload.deleted : null)
      if (tombs) { s.deleted = mergeHabitTombstones(s.deleted, tombs); changed = true }
      // [W7-R P2] moment tombstones ride the same two shapes as habit tombstones
      const momentTombs = Array.isArray(fields.deletedMoments) ? fields.deletedMoments : (Array.isArray(payload.deletedMoments) ? payload.deletedMoments : null)
      if (momentTombs) { s.deletedMoments = mergeMomentTombstones(s.deletedMoments, momentTombs); changed = true }
      if (Array.isArray(fields.habits)) {
        normalizeHabitRecords(fields.habits)
        s.habits = mergeHabitRecords(applyHabitTombstones(fields.habits, s.deleted), s.habits)
        changed = true
      }
      // F2 2026-10-19: union-merge, same caliber as applyExternal above — inbound moments are
      // tombstone-filtered first so a peer copy of a deleted moment cannot resurrect it.
      if (Array.isArray(fields.moments)) { s.moments = unionMoments(applyMomentTombstones(fields.moments, s.deletedMoments), s.moments); changed = true }
      if (!changed) return // nothing applicable: no state change, no savedAt bump
      s.savedAt = savedAt || s.savedAt
      // Deliberately NO persist() here — same no-echo contract as applyExternal above.
    },
    addHabit (s, { name, frequency }) {
      // Millisecond-precision Date.now() alone can collide (rapid double-add), breaking delete/check-in by id
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      s.habits.push({
        id,
        name,
        color: PALETTE[s.habits.length % PALETTE.length],
        createdAt: Date.now(),
        frequency: frequency || { type: 'daily' },
        records: {}
      })
      // [F3 fix] defensive: a deliberately re-added id (import/restore with a fixed id) clears its
      // tombstone — addHabit always mints a fresh id in practice, so this is a no-op normally
      s.deleted = (s.deleted || []).filter(t => t.id !== id)
      persist(s)
    },
    renameHabit (s, { id, name }) {
      const h = s.habits.find(x => x.id === id); if (h) h.name = name
      persist(s)
    },
    delHabit (s, id) {
      s.habits = s.habits.filter(x => x.id !== id)
      // [F3 fix] record a delete tombstone so any peer blob (or older backup) that still carries
      // this habit id can no longer resurrect it via applyExternal/applyExternalPatch/replaceAll.
      s.deleted = mergeHabitTombstones(s.deleted, [{ id, deletedAt: Date.now() }])
      persist(s)
    },
    toggleCheck (s, { id, day }) {
      const h = s.habits.find(x => x.id === id); if (!h) return
      if (h.records[day]) delete h.records[day]
      else h.records[day] = true
      persist(s)
    },
    /** [A6 fix] set a specific day to an explicit value (not a toggle): the check-in Undo must
     *  restore the PRE-action snapshot, not re-toggle (a toggle double-fired by a stray second
     *  click or an interleaved action would corrupt the day's state). */
    setCheck (s, { id, day, on }) {
      const h = s.habits.find(x => x.id === id); if (!h) return
      if (on) h.records[day] = true
      else delete h.records[day]
      persist(s)
    },
    addMoment (s, { name, date, kind }) {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      s.moments.push({ id, name, date, kind })
      // [W7-R P2] defensive parity with addHabit: a deliberately re-added identical id clears its tombstone
      s.deletedMoments = (s.deletedMoments || []).filter(t => t.id !== id)
      persist(s)
    },
    delMoment (s, id) {
      s.moments = s.moments.filter(x => x.id !== id)
      // [W7-R P2] record a deletion tombstone so peer blobs (and old backups) still carrying the
      // moment id cannot resurrect it through the union-merge inbound boundaries.
      s.deletedMoments = mergeMomentTombstones(s.deletedMoments, [{ id, deletedAt: Date.now() }])
      persist(s)
    }
  },
  actions: {
    /** Restore from the main DB at startup: replaceAll already does last-write-wins by savedAt (the DB archive is the fallback when LS is cleared)
     *  B7 (daily 2026-09-24): a DB READ ERROR is not "no mirror" — restoreFromDb surfaces the
     *  DB_MIRROR_ERROR sentinel and this cycle warns and SKIPS both the restore and any later
     *  write-back, so a transient getMeta failure can no longer leave stale LS state that the
     *  next persist() would mirror over the newer durable DB copy (F-C4 parity, settings side). */
    async initFromDb ({ state, commit }) {
      try {
        if (!window.todoAPI?.dbCall) return
        // [D13 #12] unflushed-mirror parking: the previous session gave up mirroring this key —
        // the LS copy is newer than whatever the DB holds. Skip the restore (LS state is already
        // live) and re-mirror it via persist() (fresh savedAt + meta write) instead of letting
        // the stale DB blob drown it (DB-precedence assumes the mirror actually landed).
        const parked = consumeUnflushed(META_KEY)
        if (parked && parked.blob) { persist(state); return }
        let blob = await restoreFromDb(META_KEY)
        if (blob === DB_MIRROR_ERROR) {
          console.warn('[habits] initFromDb: DB mirror read failed this startup — skipping the restore (and the write-back) so the DB copy is preserved')
          return
        }
        let legacy = false
        if (!blob) {
          // One-time migration source: pre-rename installs persisted under the bare 'habitsState' key
          blob = await restoreFromDb(LEGACY_META_KEY)
          if (blob === DB_MIRROR_ERROR) {
            console.warn('[habits] initFromDb: legacy DB mirror read failed this startup — skipping the restore so the DB copy is preserved')
            return
          }
          legacy = !!blob
        }
        if (blob) {
          commit('replaceAll', blob)
          if (legacy) {
            // Copy the legacy blob to the db.-prefixed key so the sync bridge picks it up; the legacy
            // row is kept (read path no longer depends on it after this write succeeds)
            await commitCommand("meta", "put", [META_KEY, JSON.stringify(blob)])
          }
        }
      } catch { /* empty environment */ }
    }
  }
}
