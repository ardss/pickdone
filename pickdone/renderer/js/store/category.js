import { safeSet, getMetaManyWithFallback } from '../utils/core.js'
import { loadMilestones } from '../utils/milestones.js'
import { normalizeStatus } from '../utils/projectStatus.js'
import { commit as commitCommand } from "../utils/commandBus.js"
import { today0, dayStart, dayShift } from '../utils/todayBounds.js'
/** Category module (offline persistence via localStorage; cloud APIs like getCategoryList reserved) */
const LS_KEY = 'categoryState'
export const COLOR_PALETTE = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3', '#98a4ae']

function loadList () {
  let corrupt = false
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    if (d && Array.isArray(d.list)) return d.list
    corrupt = true
  } catch { corrupt = true }
  // Initial example categories (colors aligned with the project baseline defaults)
  // Don't persist-overwrite immediately when LS is corrupted: the DB-side init may still have recoverable real data; just let the seeds enter memory for now
  const now = Date.now()
  const mk = (i, name, color) => ({ categoryId: 100000 + i, userId: 840001, categoryName: name, categoryColor: color, createTime: now + i, listSort: 100 * i, folderIs: false, folderId: 0, delete: false })
  // Names follow the UI language so an en-US first boot doesn't grow Chinese categories
  const en = (function () { try { return (localStorage.getItem('appLocale') || 'zh-CN') === 'en-US' } catch (e) { return false } })()
  const list = en
    ? [mk(1, 'Work', '#0f9d8f'), mk(2, 'Study', '#f2a63b'), mk(3, 'Life', '#7ac74f')]
    : [mk(1, '工作', '#0f9d8f'), mk(2, '学习', '#f2a63b'), mk(3, '生活', '#7ac74f')]
  if (!corrupt) persist(list)
  return list
}
/** camelCase -> SQLite row (same style as db.js todoToRow) */
function toRow (c, { restore = false } = {}) {
  return {
    id: c.categoryId,
    userId: c.userId != null ? c.userId : 840001,
    name: c.categoryName,
    color: c.categoryColor || null,
    createdAt: c.createTime || 0,
    sort: c.listSort || 0,
    isFolder: c.folderIs ? 1 : 0,
    parentId: c.folderId || 0,
    deleted: c.delete ? 1 : 0,
    // D5 (2026-09-20): carry the tombstone stamp — markCascade sets deletedAt, but toRow dropped it,
    // so the DB row never saw the value. The db layer preserves an existing stamp and stamps when
    // absent; carrying the value here keeps renderer/CLI/db in one shape.
    deletedAt: c.deletedAt || 0,
    // Round-6 P2: a restored backup carries no category timestamp, so the db layer's now-stamp made
    // backup-time tombstones win category LWW and re-delete categories a peer has since recovered or
    // renamed. Restored tombstones get the epoch-oldest stamp (any real peer row — live or tombstone
    // — wins the next LWW round); live restored rows still take the now-stamp (backup wins locally).
    updatedAt: restore && c.delete ? 1 : undefined
  }
}

/** Dual write: localStorage stays as cache/disaster recovery, SQLite is authoritative (unified CLI/UI data source).
 *  Write-amplification fix (2026-09-25): persist used to re-commit EVERY row as category.put on every call,
 *  and setList was reachable from the DB-read path (category/init) — externalReload → init → setList(rows) →
 *  persist → N × upsertCategory writes → each audited as category.upsert → the writes broadcast todos-changed →
 *  reload fires again. That read-back→persist loop was the ~80 lines/s category.upsert audit storm (~5MB per
 *  7-10 min, 24MB+ archives on the real %APPDATA% side, 51MB+ un-rotated on .dev-data). Two guards now:
 *    1. the read-back path goes through setListFromDb (NEVER persists — see that mutation);
 *    2. persist diffs each row against the last SUCCESSFULLY committed row (per id) and only commits real
 *       changes, so even a full-list caller rewrites only the rows that actually moved. A failed commit is
 *       not remembered, so the next persist retries it (LS is already updated — SQLite must converge). */
const lastPersistedRows = new Map() // categoryId → JSON of the row last committed successfully
// Exported read-only for the leak regression (see pendingMetaBackups below): keys must track the live list.
export { lastPersistedRows }
/** Leak fix (dw wave 2026-10-02): the diff baseline kept an entry for every id ever persisted, even
 *  after the row left the list (purged tombstone, hard delete) — unbounded growth over a long session.
 *  Every persist()/setListFromDb() caller passes the FULL list, so a key absent from it is dead. */
function prunePersistBaseline (list) {
  const live = new Set(list.map(c => c.categoryId))
  for (const id of [...lastPersistedRows.keys()]) if (!live.has(id)) lastPersistedRows.delete(id)
}
function persist (list, opts = {}) {
  safeSet(LS_KEY, JSON.stringify({ list }))
  prunePersistBaseline(list)
  try {
    // Failures must be visible: LS is already updated above, so a silent per-row catch meant the user
    // believed categories were saved while SQLite (the CLI-visible authority) silently diverged
    const jobs = []
    for (const c of list) {
      const row = toRow(c, opts)
      const sig = JSON.stringify(row)
      if (lastPersistedRows.get(c.categoryId) === sig) continue // unchanged since the last successful commit
      jobs.push(
        commitCommand("category", "put", row)
          .then(() => { lastPersistedRows.set(c.categoryId, sig) })
          .catch(e => ({ err: e, id: c.categoryId }))
      )
    }
    if (!jobs.length) return
    Promise.all(jobs).then(results => {
      for (const r of results) if (r && r.err) lastPersistedRows.delete(r.id)
      const failed = results.filter(r => r && r.err)
      if (failed.length) console.error('[category] save failed for', failed.length, 'of', list.length, 'rows:', failed[0].err)
    }).catch(e => console.error('[category] save failed:', e))
  } catch (e) { console.warn('[category] SQLite write failed (cached locally only):', e) }
}

let idSeed = null
/** NOT globally unique — each window keeps its own seed. The seed starts at Date.now() plus a random
 *  offset (±5ms window, ~1e5 slots): two windows creating a category in the same millisecond used to
 *  derive identical ++Date.now() ids and silently overwrite each other's row; the random start slot
 *  makes that collision probability negligible (≈1e-5 per same-ms pair) while ids stay plain numbers
 *  compatible with the existing === comparisons and the numeric id column. */
function nextId () {
  if (!idSeed) idSeed = Date.now() + Math.floor(Math.random() * 100000)
  return ++idSeed
}

/** Meta key for project flags: value is a JSON array of categoryIds. A project = a flagged category, zero schema changes */
const PROJECT_IDS_KEY = 'projectCategoryIds'
/** Y/X3 (sync-coverage-2): per-category flag keys `projectCategoryFlag:<id>` = '1' — the legacy
 *  whole-array blob was whole-key LWW, so two devices flagging different categories clobbered each
 *  other. Per-cat flags sync field-granular; the legacy blob is READ-ONLY now (U7, 2026-09-20: the
 *  renderer never writes it anymore — init() still unions it so old data survives). */
const projectFlagKey = id => 'projectCategoryFlag:' + id
/** Error-safety fix (dw wave 2026-10-02): a failed meta put/delete used to vanish into
 *  `.catch(() => {})` — the in-memory projectIds said "project flagged" while the durable per-cat
 *  flag said otherwise, so the project silently resurrected (failed delete) or silently vanished
 *  (failed put) at next init. The failure is now surfaced AND `onFail` lets the caller revert the
 *  in-memory state to match what is actually durable (D13-A4 / D14-B7 pattern). */
function writeProjectFlag (id, flag, onFail) {
  try {
    const p = flag
      ? commitCommand("meta", "put", [projectFlagKey(id), '1'])
      : commitCommand("meta", "delete", projectFlagKey(id))
    p.catch(e => {
      console.error('[category] project flag write failed for', id, flag ? '(put)' : '(delete)', e)
      if (typeof onFail === 'function') { try { onFail(e) } catch (e2) { /* revert must not throw */ } }
    })
  } catch (e) {
    // degraded host: the durable write never even started, so the in-memory flip is a lie too
    console.error('[category] project flag write unavailable (degraded host) for', id, e)
    if (typeof onFail === 'function') { try { onFail(e) } catch (e2) { /* revert must not throw */ } }
  }
}
const deadlineKey = id => 'projectDeadline:' + id
/** Project lifecycle status (contract shared with the CLI): string active|paused|done|cancelled, absent = 'active' */
const statusKey = id => 'projectStatus:' + id
const milestonesKey = id => 'projectMilestones:' + id
/** D15-B4: project documents (ProjectDocs.vue persist) live in `projectDocs:<id>` — the same
 *  durable, recoverable category-meta family as deadline/status/milestones, so the soft-delete
 *  backup roundtrip below treats it identically (backed up into catProjectMetaBak.<id>, cleared
 *  from the live key, restored on recover). */
const projectDocsKey = id => 'projectDocs:' + id
/** U-4 (2026-09-20): machine-local backup of a soft-deleted project category's meta. The old code
 *  hard-deleted projectCategoryFlag/Status/Deadline (and left milestones orphaned), so recovering the
 *  category irreversibly lost its project metadata. Pattern mirrors metaConflictBackup.*: the live keys
 *  are copied into one `catProjectMetaBak.<id>` JSON blob, cleared from their live keys, and restored +
 *  the backup deleted on recover. */
const catMetaBakKey = id => 'catProjectMetaBak.' + id
/** Review P2 (2026-09-22): per-victim in-flight backup promises. softDelete fires
 *  backupThenClearProjectMeta per victim without blocking the UI; recover used to read the backup
 *  key immediately — an undo clicked inside the read→backup-write→clear roundtrip saw NO backup yet
 *  and permanently lost deadline/milestones/status. recover now awaits the victim's pending backup
 *  promise before restoring, so the category only becomes recoverable once its meta is safely
 *  backed up (or provably absent). */
const pendingMetaBackups = new Map()
// Exported read-only for the leak regression (r5/r6 precedent of exporting internals for tests):
// the map must hold only IN-FLIGHT roundtrips, never settled promises of never-recovered victims.
export { pendingMetaBackups }
/** renderer-5 (sharp-review 2026-09-22): pendingMetaBackups above is per-window module state, so a
 *  recover in window B never sees window A's in-flight delete-time backup and used to read the backup
 *  key before A's write landed — deadline/milestones/status permanently lost. A durable in-DB marker
 *  (`catProjectMetaBak.pending.<id>`) now brackets the read→backup-write→clear roundtrip: softDelete
 *  writes it first (ordering through the same IPC pipe as the backup reads/writes), the backup deletes
 *  it only after the live keys are cleared, and recover — in ANY window — waits it out (bounded) before
 *  restoring. Local promise map stays as the fast path for same-window undo. */
const pendingMetaBakKey = id => 'catProjectMetaBak.pending.' + id
const PENDING_META_BAK_WAIT_MS = 3000
function markPendingMetaBak (id) {
  // Error-safety fix: this marker is the cross-window gate that keeps recover from reading the
  // backup key before the roundtrip wrote it (renderer-5). A failed write previously vanished into
  // `.catch(() => {})` — recover could then proceed up to PENDING_META_BAK_WAIT_MS early and read a
  // not-yet-written backup. Surfaced loudly; the bounded wait stays the last-line guard.
  try { commitCommand('meta', 'put', [pendingMetaBakKey(id), '1']).catch(e => console.error('[category] pending-meta-backup MARKER write failed for', id, '— cross-window recover may race the backup roundtrip:', e)) } catch (e) { console.error('[category] pending-meta-backup marker unavailable (degraded host) for', id, e) }
}
function clearPendingMetaBak (id) {
  // A failed clear is tolerated (waitOutPendingMetaBak's bounded wait clears stale markers), but it
  // must not be invisible: every recover of this id would otherwise burn the full 3s wait silently.
  try { commitCommand('meta', 'delete', pendingMetaBakKey(id)).catch(e => console.warn('[category] pending-meta-backup marker clear failed for', id, '(bounded wait will clear it):', e)) } catch (e) { /* degraded host: no marker to clear */ }
}
/** Resolves once the durable marker is gone (backup roundtrip finished in whichever window) or the
 *  bounded wait expires — a leaked marker (crash mid-roundtrip) must not wedge recover forever, so the
 *  timeout also clears the stale marker. */
async function waitOutPendingMetaBak (id) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
  const deadline = Date.now() + PENDING_META_BAK_WAIT_MS
  while (Date.now() < deadline) {
    let marker = null
    try { marker = await window.todoAPI.dbCall('getMeta', pendingMetaBakKey(id)) } catch (e) { return }
    if (!marker) return
    await new Promise(r => setTimeout(r, 50))
  }
  clearPendingMetaBak(id)
}
/** Read a project category's four meta surfaces into one backup blob, write the backup, THEN clear the
 *  live keys (read→backup-write→delete sequence, never the reverse — a failed backup write keeps the
 *  live keys instead of destroying unbacked metadata). */
async function backupThenClearProjectMeta (id) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
  const blob = {}
  try { blob.flag = (await window.todoAPI.dbCall('getMeta', projectFlagKey(id))) === '1' } catch (e) { /* absent */ }
  try { blob.status = (await window.todoAPI.dbCall('getMeta', statusKey(id))) || '' } catch (e) { /* absent */ }
  try { blob.deadline = (await window.todoAPI.dbCall('getMeta', deadlineKey(id))) || '' } catch (e) { /* absent */ }
  try { blob.milestones = (await window.todoAPI.dbCall('getMeta', milestonesKey(id))) || '' } catch (e) { /* absent */ }
  // D15-B4: docs ride the same blob — absent raw ('' after the ||) stays falsy so an
  // old backup blob without the field restores cleanly.
  try { blob.docs = (await window.todoAPI.dbCall('getMeta', projectDocsKey(id))) || '' } catch (e) { /* absent */ }
  if (blob.flag || blob.status || blob.deadline || blob.milestones || blob.docs) {
    try {
      await commitCommand("meta", "put", [catMetaBakKey(id), JSON.stringify(blob)])
    } catch (e) {
      console.warn('[category] project-meta backup write failed — live keys kept for', id, e)
      // Marker cleared: the live keys stay authoritative, so a waiting recover must not wait on us
      clearPendingMetaBak(id)
      return
    }
  }
  try { await commitCommand("meta", "delete", projectFlagKey(id)) } catch (e) { /* absent is fine */ }
  try { await commitCommand("meta", "delete", statusKey(id)) } catch (e) { /* absent is fine */ }
  try { await commitCommand("meta", "delete", deadlineKey(id)) } catch (e) { /* absent is fine */ }
  try { await commitCommand("meta", "delete", milestonesKey(id)) } catch (e) { /* absent is fine */ }
  try { await commitCommand("meta", "delete", projectDocsKey(id)) } catch (e) { /* absent is fine */ }
  // Only now (backup key durably written, live keys cleared) may any window's recover proceed
  clearPendingMetaBak(id)
}
/** D14-B10 (2026-10-01): milestones written BETWEEN the delete and the recover (CLI `milestone add`)
 *  re-create the live key — the old unconditional backup put clobbered that newer list irreversibly.
 *  Merge instead: live entries win per id (they are newer by construction), backup-only entries are
 *  re-added, result re-sorted by date like saveMilestones does. */
function mergeMilestoneBlobs (liveRaw, backupRaw) {
  let liveList, bakList
  try { liveList = JSON.parse(liveRaw) } catch (e) { return backupRaw }
  try { bakList = JSON.parse(backupRaw) } catch (e) { return liveRaw }
  if (!Array.isArray(liveList) || !Array.isArray(bakList)) return liveList && liveList.length ? liveRaw : backupRaw
  if (!liveList.length) return backupRaw
  const ids = new Set(liveList.map(m => m && m.id))
  return JSON.stringify(
    liveList.concat(bakList.filter(m => m && m.id && !ids.has(m.id))).sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0))
  )
}

/** U-4 recover path: restore the backed-up project meta to its live keys, then delete the backup.
 *  Resolves true when a backup existed and was restored. */
async function restoreProjectMetaBackup (id) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return false
  let blob = null
  try { blob = JSON.parse((await window.todoAPI.dbCall('getMeta', catMetaBakKey(id))) || 'null') } catch (e) { blob = null }
  if (!blob || typeof blob !== 'object') return false
  try { if (blob.flag) await commitCommand("meta", "put", [projectFlagKey(id), '1']) } catch (e) { /* best-effort */ }
  try { if (blob.status) await commitCommand("meta", "put", [statusKey(id), blob.status]) } catch (e) { /* best-effort */ }
  try { if (blob.deadline) await commitCommand("meta", "put", [deadlineKey(id), blob.deadline]) } catch (e) { /* best-effort */ }
  if (blob.milestones) {
    let ms = blob.milestones
    try { ms = mergeMilestoneBlobs((await window.todoAPI.dbCall('getMeta', milestonesKey(id))) || '', blob.milestones) } catch (e) { /* backup verbatim */ }
    try { if (ms) await commitCommand("meta", "put", [milestonesKey(id), ms]) } catch (e) { /* best-effort */ }
  }
  // D15-B4: documents restore verbatim (a purged category has no newer live docs to merge with;
  // ProjectDocs.vue reloads from the live key on its next mount).
  if (blob.docs) {
    try { await commitCommand("meta", "put", [projectDocsKey(id), blob.docs]) } catch (e) { /* best-effort */ }
  }
  try { await commitCommand("meta", "delete", catMetaBakKey(id)) } catch (e) { /* best-effort */ }
  return !!blob.flag
}
/** U-5 (2026-09-20): the ONE sanctioned legacy-array write — on unmark, rewrite `projectCategoryIds`
 *  without the id so init()'s legacy union cannot resurrect the unset project from a stale blob.
 *  (Per-cat flag key deletion stays the primary syncable write; CLI twin does the same — F-Main.)
 *  r6 (2026-09-28): the rewrite is no longer fire-and-forget. It is (a) chained per id (two
 *  overlapping unmarks of the same id cannot interleave read→filter→put and re-add the id) and
 *  (b) registered in pendingLegacyRewrites, which init() DRAINS before its legacy union read —
 *  previously an init() racing the async cleanup read the un-scrubbed blob and the cancelled
 *  project came back, the exact resurrection U-5 was written to kill. Failures stay non-fatal:
 *  logged, never unhandled. */
const pendingLegacyRewrites = new Map() // id -> in-flight rewrite promise
function rewriteLegacyProjectIdsWithout (id) {
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return Promise.resolve()
    const prev = pendingLegacyRewrites.get(id) || Promise.resolve()
    const p = prev.then(async () => {
      const arr = JSON.parse((await window.todoAPI.dbCall('getMeta', PROJECT_IDS_KEY)) || '[]')
      if (Array.isArray(arr) && arr.includes(id)) {
        await commitCommand("meta", "put", [PROJECT_IDS_KEY, JSON.stringify(arr.filter(x => x !== id))])
      }
    }).catch(e => console.warn('[category] legacy project-id rewrite failed for', id, e))
    pendingLegacyRewrites.set(id, p)
    p.then(() => { if (pendingLegacyRewrites.get(id) === p) pendingLegacyRewrites.delete(id) })
    return p
  } catch (e) { /* degraded host: nothing to rewrite (synchronous) */ return Promise.resolve() }
}
/** r6: resolve when every in-flight legacy rewrite has settled — init() awaits this so the
 *  union read can never observe a pre-cleanup PROJECT_IDS_KEY. */
function drainLegacyRewrites () {
  return Promise.all([...pendingLegacyRewrites.values()]).then(() => {})
}
/** Pure helper (unit-tested): the ids a cascade delete of `id` will mark deleted — the category itself plus,
 *  mirroring markCascade, folder descendants recursively and their non-folder children. Lets softDelete clean
 *  project meta for every victim, matching the CLI delete path. */
function collectCascadeIds (state, id) {
  const out = []
  // H1 (2026-09-16): A↔B mutual-parent cycles (corrupted data / cross-window race) used to recurse
  // forever → RangeError. A visited set truncates the cycle; each id is emitted once.
  const visited = new Set()
  const walk = cid => {
    if (visited.has(cid)) return
    visited.add(cid)
    out.push(cid)
    state.list.filter(x => x.folderId === cid && x.categoryId !== cid).forEach(x => { if (x.folderIs) walk(x.categoryId); else out.push(x.categoryId) })
  }
  walk(id)
  return out
}
export { collectCascadeIds }
// r5: exported for the unit regression that the async body's rejection is caught in-module
// (the old sync try/catch never covered it → unhandled rejection, cleanup silently lost).
// r6: drainLegacyRewrites exported for init()'s ordering contract + the revival regression.
export { rewriteLegacyProjectIdsWithout, drainLegacyRewrites }

/** D14-B9 (2026-10-01): the purge used to be one-sided — recover restored the row + project meta but
 *  the saved filters hard-deleted here were gone forever. The doomed filters (read from in-memory
 *  state, not the DB) are now backed up per victim into the `catFiltersBak` family in the same
 *  backup-key family as catProjectMetaBak before the deletes fire; recover re-puts them.
 *  D15-B6 (2026-10-03): the backup key carries the deletion stamp — `catFiltersBak.<deletedAt>.<id>`
 *  — so the startup meta GC (computeMetaGc) can bound its retention to the recover window (same
 *  30-day fallback as the tombstone expiry in init()); the legacy `catFiltersBak.<id>` shape (the
 *  CLI twin still writes it, and pre-fix renderer backups) stays readable and is GC'd only when the
 *  id is live again (recovered/re-created leftover — recover itself deletes the backup). */
const catFiltersBakKey = id => 'catFiltersBak.' + id
const catFiltersBakKeyTs = (deletedAt, id) => 'catFiltersBak.' + deletedAt + '.' + id
async function backupDoomedFilters (victim, doomed, deletedAt) {
  const mine = doomed.filter(f => f && f.conds && String(f.conds.catId) === String(victim))
  if (!mine.length) return
  // No stamp (legacy tombstone without deletedAt) → fall back to the legacy key shape: an
  // unstamped key's age is unknowable, so the GC conservatively keeps it (same rule init() uses
  // for no-stamp tombstones) instead of inventing a now-stamp recover could never re-derive.
  const key = deletedAt ? catFiltersBakKeyTs(deletedAt, victim) : catFiltersBakKey(victim)
  try {
    await commitCommand("meta", "put", [key, JSON.stringify(mine)])
  } catch (e) { console.warn('[category] filter backup write failed for victim', victim, e) }
}
/** Restore the backed-up filters of one recovered category (best-effort, then the backup is deleted).
 *  Reads the stamped key first (renderer writes since D15-B6, using the tombstone's deletedAt) and
 *  falls back to the legacy shape (CLI twin / pre-fix backups). */
async function restoreFiltersBackup (id, commit, deletedAt) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
  let raw = null
  let bakKey = catFiltersBakKey(id)
  if (deletedAt) {
    bakKey = catFiltersBakKeyTs(deletedAt, id)
    try { raw = await window.todoAPI.dbCall('getMeta', bakKey) } catch (e) { raw = null }
  }
  if (!raw) {
    bakKey = catFiltersBakKey(id)
    try { raw = await window.todoAPI.dbCall('getMeta', bakKey) } catch (e) { return }
  }
  if (!raw) return
  let list = null
  try { list = JSON.parse(raw) } catch (e) { list = null }
  if (Array.isArray(list) && list.length) {
    for (const f of list) {
      try { await commitCommand("filter", "put", f) } catch (e) { console.error('[category] filter restore put failed:', e) }
    }
    try { commit('filters/setList', await window.todoAPI.dbCall('filterList')) } catch (e) { /* list refresh is best-effort */ }
  }
  try { await commitCommand("meta", "delete", bakKey) } catch (e) { /* best-effort */ }
}

/** D5: remove saved filters referencing any victim categoryId. `this` = the store (mutations bind it).
 *  Best-effort: a DB failure leaves the in-memory purge skipped too, so state and DB stay consistent
 *  (the filter keeps working as before rather than silently diverging). */
function purgeFiltersForVictims (victims) {
  const fstate = this.state && this.state.filters
  if (!fstate || !Array.isArray(fstate.list) || !fstate.list.length) return
  const dead = new Set(victims.map(v => String(v)))
  const doomed = fstate.list.filter(f => f && f.conds && dead.has(String(f.conds.catId)))
  if (!doomed.length) return
  // D14-B9: back up BEFORE the deletes fire (the backup payload comes from in-memory state, so the
  // put/delete ordering across the IPC pipe cannot corrupt it; a failed backup keeps the delete
  // one-sided exactly as before rather than blocking the delete). D15-B6: pass the victim's
  // deletion stamp so the backup key carries the age the startup GC needs to bound its retention.
  const catList = (this.state && this.state.category && this.state.category.list) || []
  for (const v of victims) {
    const vRow = catList.find(c => c && c.categoryId === v)
    backupDoomedFilters(v, doomed, (vRow && vRow.deletedAt) || 0).catch(e => console.warn('[category] filter backup failed:', e))
  }
  const doomedIds = new Set(doomed.map(f => f.id))
  fstate.list = fstate.list.filter(f => !doomedIds.has(f.id))
  for (const f of doomed) {
    try { commitCommand("filter", "delete", f.id).catch(e => console.error('[category] filterDelete failed during category delete:', e)) } catch (e) { /* degraded host */ }
  }
  this.commit('filters/setList', fstate.list)
}

/** Deleted categories cannot come back through getAllCategories (WHERE deleted = 0), so they are mirrored
 *  in the LS cache by persist() and re-merged here on startup. Without this a soft-deleted category
 *  vanished from state on restart: visibleCount dropped to 0 and the recover-in-place entry went blind,
 *  contradicting the CLI's "recoverable in App" promise. Entries already re-added (same id, live in DB) win.
 *  Pure + exported for the D15-B15 regression: init() must apply it on EVERY successful DB read —
 *  including the zero-live-categories boot (delete ALL categories, restart), where the old
 *  `if (rows.length)` gate dropped in-retention tombstones from memory and the recover entry went
 *  blind exactly when it was needed most. */
function mergeableLsTombstones (rows, recycleBinAutoDeleteDays) {
  // G1 tombstone expiry: a tombstone whose category was already PURGED (hard-deleted from the
  // recycle bin) is invisible to the live-rows check and used to be re-merged forever —
  // the "permanently deleted" category resurrected as a ghost on every restart. Only re-attach
  // tombstones inside the recycle-bin retention window; old tombstones without deletedAt are
  // conservatively kept (pre-dates the stamp, may still be within an unknown window).
  // [tombstone-zero fix] 0 is the shipped 'never purge' option (SettingsDataTab radio): the
  // old `Number(...) || 30` read it as 30, so a 'never' user still lost the category
  // recovery entry after a month — diverging from the todo-row purge, which honors 0 via
  // `if (!days) return` (store/todo.js). 0 now keeps tombstones unconditionally; junk/NaN
  // still falls back to 30.
  const rawDays = Number(recycleBinAutoDeleteDays)
  const retentionDays = rawDays === 0 ? 0 : (rawDays > 0 ? rawDays : 30)
  // P3-6 (maint/dw 2026-09-23) + day-caliber (2026-10-03): same calendar-day cutoff as the
  // todo-row purge (store/todo.js: startOf('day').subtract(days,'day') = local midnight minus
  // N CALENDAR days) — computed via todayBounds.dayShift so this path stays independent of the
  // window.dayjs UMD global while keeping calendar semantics. The former
  // `_localMidnight - retentionDays * day-in-ms` arithmetic diverged from the purge cutoff by
  // 1h on DST-affected days: on such a day the recovery entry could expire while the rows it
  // would recover were still inside the retention window.
  const cutoff = retentionDays === 0 ? 0 : dayShift(dayStart(Date.now()), -retentionDays)
  return deletedFromLs().filter(d =>
    !rows.some(r => r.categoryId === d.categoryId) &&
    (retentionDays === 0 || !d.deletedAt || d.deletedAt > cutoff))
}
export { mergeableLsTombstones }
function deletedFromLs () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    return ((d && Array.isArray(d.list)) ? d.list : []).filter(c => c && c.delete)
  } catch { return [] }
}

export default {
  namespaced: true,
  state: () => ({ list: loadList(), projectIds: [], projectMeta: {} }),
  getters: {
    /** Views' single name/color lookup: a soft-deleted (or missing) categoryId resolves to null so every
     *  consumer (taskRow color-follow, name chips, …) falls back to the uncategorized default. Matches the
     *  CLI contract (cli/lib.js deleteCategory: "tasks keep categoryId and fall back to the default
     *  (uncategorized) in views") — previously a deleted category kept answering byId within the session,
     *  so its name/color haunted rows that the EditPanel dropdown (sortedAll) already excluded. */
    byId: s => id => s.list.find(c => c.categoryId === id && !c.delete) || null,
    /** Project-type categories (sorted by listSort) — progressive disclosure: empty array when no projects, sidebar renders no entry */
    projects: s => s.list
      .filter(c => !c.delete && s.projectIds.includes(c.categoryId))
      .sort((a, b) => a.listSort - b.listSort),
    /** Project metadata (deadline/nextMilestone/status), loaded uniformly by loadProjectMeta; views read-only to avoid each racing */
    projectMeta: s => s.projectMeta,
    /** Lifecycle status of one project (normalized: absent/invalid = 'active') */
    projectStatus: s => id => normalizeStatus((s.projectMeta[id] || {}).status),
    roots: s => s.list.filter(c => !c.folderIs && !c.folderId && !c.delete).sort((a, b) => a.listSort - b.listSort),
    // All non-deleted categories sorted by listSort (shared by EditPanel category dropdown etc.)
    sortedAll: s => s.list.filter(c => !c.delete).sort((a, b) => a.listSort - b.listSort),
    folders: s => s.list.filter(c => c.folderIs && !c.delete),
    visibleCount: s => s.list.filter(c => c.delete).length,
    hierarchical (s) {
      const live = s.list.filter(c => !c.delete).sort((a, b) => a.listSort - b.listSort)
      return live.filter(c => !c.folderId).map(c => c.folderIs
        ? Object.assign({}, c, { children: live.filter(x => !x.folderIs && x.folderId === c.categoryId) })
        : c)
    }
  },
  mutations: {
    setList (state, list) { state.list = list; persist(list) },
    // Backup-restore entry: same list replacement, but restored tombstones must not win LWW (see toRow)
    setListRestore (state, list) { state.list = list; persist(list, { restore: true }) },
    /** Write-amplification fix (2026-09-25): the ONLY sanctioned channel for lists READ BACK from SQLite
     *  (category/init startup + externalReload's every-round category/init re-run). Reads must never
     *  persist — the old setList here re-committed all N rows (each audited category.upsert) and the
     *  writes re-broadcast todos-changed, re-entering the reload: the ~80 lines/s audit storm. Memory
     *  assignment only; user edits still flow through addCategory/updateCategory/softDelete/... → persist.
     *  The rows ARE the authoritative DB content, so they also seed the persist diff-baseline: the first
     *  real user edit after load commits just that row, not the whole list re-synced. */
    setListFromDb (state, list) {
      state.list = list
      prunePersistBaseline(list)
      for (const c of list) lastPersistedRows.set(c.categoryId, JSON.stringify(toRow(c)))
    },
    addCategory (state, { categoryName = 'New Category', categoryColor = COLOR_PALETTE[state.list.length % COLOR_PALETTE.length], folderIs = false, folderId = 0 }) {
      state.list.push({ categoryId: nextId(), userId: 840001, categoryName, categoryColor, createTime: Date.now(), listSort: Math.max(0, ...state.list.map(c => c.listSort)) + 100, folderIs, folderId, delete: false })
      persist(state.list)
    },
    updateCategory (state, patch) {
      const i = state.list.findIndex(c => c.categoryId === patch.categoryId)
      if (i >= 0) { state.list[i] = { ...state.list[i], ...patch }; persist(state.list) }
    },
    softDelete (state, id) {
      // Meta cleanup aligned with the CLI delete path (cli/lib.js deletes projectDeadline:<id> and prunes
      // projectCategoryIds for every victim): the renderer only flipped the delete flag, so a deleted project
      // category kept haunting projectStatus:<id>/projectDeadline:<id> meta and the projectIds flag
      const victims = collectCascadeIds(state, id)
      this.commit('category/markCascade', id)
      // U7 (2026-09-20): the legacy whole-array `projectCategoryIds` meta is NO LONGER WRITTEN by
      // the renderer at all — whole-key LWW meant two devices editing different projects clobbered
      // each other. Per-cat flag keys (writeProjectFlag below) are the only syncable unit now; the
      // in-memory projectIds list is trimmed for the session (init() still unions the legacy blob).
      const ids = state.projectIds.filter(x => !victims.includes(x))
      if (ids.length !== state.projectIds.length) state.projectIds = ids
      for (const vid of victims) {
        // U-4: back up then clear the project meta (flag/status/deadline/milestones/docs) — recover restores it.
        // Review P2: the promise is retained per id; recover/undo awaits it before reading the backup key.
        const p = Promise.resolve().then(() => backupThenClearProjectMeta(vid))
        markPendingMetaBak(vid) // durable cross-window marker: written BEFORE the roundtrip's reads
        pendingMetaBackups.set(vid, p)
        // D15-B7 (2026-10-03): prune the durable legacy `projectCategoryIds` blob exactly like the
        // CLI twin (cli/lib-categories.cjs deleteCategory) — the renderer only trimmed the
        // in-memory list, so init()'s read-only legacy union resurrected every deleted project id
        // on the next launch (3 dead meta reads per id per load, stale project sidebar entries).
        rewriteLegacyProjectIdsWithout(vid)
        // Leak fix (dw wave 2026-10-02): the entry used to be deleted ONLY in recover(), so a victim
        // never recovered (purged, or recovered in another window) kept its settled promise — with its
        // closure — alive forever. A settled promise needs no awaiting: recover falls through
        // Promise.resolve(undefined) to waitOutPendingMetaBak, whose DURABLE marker (cleared only when
        // the backup roundtrip finished) remains the correctness gate.
        p.catch(() => {}).then(() => { if (pendingMetaBackups.get(vid) === p) pendingMetaBackups.delete(vid) })
        delete state.projectMeta[vid]
      }
      // D5 (2026-09-20): purge saved filters whose conds.catId references a victim — a filter on a
      // deleted category matched nothing forever (FilterView excludes deleted categories), haunting the
      // sidebar. Symmetric cleanup: DB rows deleted via filterDelete, then the state list trimmed.
      try { purgeFiltersForVictims.call(this, victims) } catch (e) { /* filters are optional; deletion must not fail */ }
      persist(state.list)
    },
    markCascade (state, id) {
      // H1 (2026-09-16): visited set — same cycle truncation as collectCascadeIds (A↔B mutual
      // parents recursed to a RangeError instead of marking anything).
      const visited = new Set()
      const mark = cid => {
        if (visited.has(cid)) return
        visited.add(cid)
        const c = state.list.find(x => x.categoryId === cid)
        if (c && !c.delete) { c.delete = true; c.deletedAt = Date.now() }
        state.list.filter(x => x.folderId === cid).forEach(x => { if (x.folderIs) mark(x.categoryId); else if (!x.delete) { x.delete = true; x.deletedAt = Date.now() } })
      }
      mark(id)
    },
    reorder (state, idsInOrder) {
      idsInOrder.forEach((id, idx) => {
        const c = state.list.find(x => x.categoryId === id)
        if (c) c.listSort = (idx + 1) * 100
      })
      persist(state.list)
    },
    /** Set/unset project: memory + per-cat flag meta only (U7: the legacy whole-array blob is never
     *  written anymore EXCEPT the sanctioned U-5 unmark rewrite below; caller removes the flag first
     *  when a category is deleted) */
    setProject (state, { id, flag }) {
      const prev = state.projectIds
      const ids = prev.filter(x => x !== id)
      if (flag) ids.push(id)
      state.projectIds = ids
      // Error-safety fix: on a failed durable flag write the in-memory flip is reverted to match what
      // is actually on disk (previously the optimistic list survived while the durable flag did not —
      // the project silently vanished/resurrected at next init with zero feedback). One write, one
      // failure callback — no identity guard (a reactive proxy never === the raw array).
      let flagWriteFailed = false
      writeProjectFlag(id, flag, () => {
        if (flagWriteFailed) return
        flagWriteFailed = true
        state.projectIds = flag
          ? prev.filter(x => x !== id) // put failed → durable has no flag → drop the id again
          : (ids.includes(id) ? ids : ids.concat(id)) // delete failed → durable still flagged → keep it
      }) // Y/X3: field-granular unit — the only persisted/synced write
      if (!flag) rewriteLegacyProjectIdsWithout(id) // U-5: unset must also scrub the stale legacy blob, else init()'s union resurrects the project
    },
    /** U-4 (2026-09-20): recover a soft-deleted category in place and restore its backed-up project
     *  meta (flag/status/deadline/milestones) from `catProjectMetaBak.<id>`, then delete the backup.
     *  A restored project flag also re-enters the in-memory projectIds list. */
    recover (state, id) {
      const c = state.list.find(x => x.categoryId === id)
      if (!c || !c.delete) return
      // D15-B6: capture the stamp BEFORE it is reset below — the async filter-restore link needs
      // the tombstone's deletedAt to address the stamped catFiltersBak key.
      const tombstoneDeletedAt = c.deletedAt || 0
      c.delete = false
      c.deletedAt = 0
      persist(state.list)
      // Review P2: wait out the in-flight delete-time backup so the backup key is guaranteed written
      // (or provably absent) before restoreProjectMetaBackup reads it — an instant undo no longer
      // races the read→backup-write→clear roundtrip and silently drops deadline/milestones/status.
      const pending = pendingMetaBackups.get(id)
      pendingMetaBackups.delete(id)
      Promise.resolve(pending).catch(() => {})
        // renderer-5: also wait out the DURABLE marker — the in-flight roundtrip may belong to another
        // window whose pendingMetaBackups map we cannot see; the marker (shared DB) is visible to all.
        .then(() => waitOutPendingMetaBak(id))
        .then(() => restoreProjectMetaBackup(id))
        // D14-B9: restore the saved filters the delete-time purge backed up (symmetric reversibility).
        // D15-B6: pass the tombstone's deletedAt so the stamped backup key (`catFiltersBak.<deletedAt>.<id>`)
        // can be read directly (legacy-shape keys remain the fallback).
        // The filter restore must NOT swallow the flagRestored result of the previous link — a flat
        // `.then(() => restoreFiltersBackup(...))` made the next link see `undefined` and the
        // recovered project id stopped re-entering projectIds.
        .then(flagRestored => restoreFiltersBackup(id, (m, p) => this.commit(m, p), tombstoneDeletedAt).then(() => flagRestored))
        .then(flagRestored => {
          if (flagRestored && !state.projectIds.includes(id)) {
            state.projectIds = [...state.projectIds, id]
            // loadProjectMeta re-reads status/deadline/milestone into projectMeta on its next run
          }
        }).catch(() => { /* best-effort */ })
    },
    setProjectIds (state, ids) { state.projectIds = Array.isArray(ids) ? ids : [] },
    setProjectMeta (state, meta) { state.projectMeta = meta || {} },
    /** Merge loaded meta into state per id/key (review P2 2026-09-10): the old snapshot-then-whole-replace
     *  commit rolled optimistic writes (setProjectStatus) back to stale reads that landed inside the await
     *  window — merging only touches the ids/keys actually read; loaded values win over existing ones. */
    mergeProjectMeta (state, patch) {
      const next = { ...state.projectMeta }
      for (const id of Object.keys(patch || {})) next[id] = Object.assign({}, next[id], patch[id])
      state.projectMeta = next
    },
    /** [D13 A3] memory-only half of the status write (the persistence moved to the awaited
     *  `setProjectStatus` action below — the old mutation fired the meta put fire-and-forget,
     *  so a failed write showed 'status changed' and silently reverted on next launch). */
    setProjectStatusLocal (state, { id, status }) {
      const norm = normalizeStatus(status)
      const meta = { ...state.projectMeta, [id]: { ...(state.projectMeta[id] || {}), status: norm } }
      state.projectMeta = meta
    }
  },
  actions: {
    async add ({ commit }, payload) { commit('addCategory', payload); return true }, // reserved: api.addCategoryList
    /** [D13 A3] awaited status write (mirrors ProjectView.setDeadline's R3 pattern): optimistic
     *  memory commit, then the meta put is AWAITED — on failure the in-memory status is rolled
     *  back to the previous value and the rejection propagates so the caller toasts an error
     *  instead of a success that the next launch silently reverts. */
    async setProjectStatus ({ state, commit }, { id, status }) {
      const prev = (state.projectMeta[id] || {}).status
      commit('setProjectStatusLocal', { id, status })
      try {
        await commitCommand('meta', 'put', [statusKey(id), normalizeStatus(status)])
      } catch (e) {
        commit('setProjectStatusLocal', { id, status: prev })
        throw e
      }
    },
    /** Unified loading of project metadata: status + deadline + next milestone (views/sidebar read only via this getter) */
    async loadProjectMeta ({ state, commit }) {
      if (!state.projectIds.length || !window.todoAPI || !window.todoAPI.dbCall) return
      const patch = {}
      // Day-caliber (2026-10-03): routed through todayBounds.today0 — the single non-reactive
      // day-start source. The inline wall-clock dayjs expression it replaced was an un-routed now-read.
      const today0Ts = today0()
      for (const id of state.projectIds) {
        const entry = {}
        // Status/deadline re-read UNCONDITIONALLY (review P1 2026-09-10): an `undefined` guard made both
        // sticky after the first load — a CLI `project --status/--deadline` write never reached a running
        // app through the external-write reload path, silently breaking CLI→app parity. Cheap meta reads.
        try { entry.status = normalizeStatus(await window.todoAPI.dbCall('getMeta', statusKey(id))) } catch { entry.status = 'active' }
        try { entry.deadline = Number(await window.todoAPI.dbCall('getMeta', deadlineKey(id))) || 0 } catch { entry.deadline = 0 }
        // Milestone re-read UNCONDITIONALLY too (review P1 2026-09-10): the `if (!cur.nextMilestone)` guard
        // cached it for the app's lifetime, so CLI `milestone add/rm` writes never reached a running app and
        // a rolled-over date kept showing a stale milestone. Read failure falls back to null.
        try {
          const ms = await loadMilestones(id)
          entry.nextMilestone = ms.filter(m => m.date >= today0Ts)[0] || null
        } catch { entry.nextMilestone = null }
        patch[id] = entry
      }
      commit('mergeProjectMeta', patch)
    },
    /** Startup loading: SQLite is authoritative; when the table is empty and a local cache exists, perform a one-time migration (LS → SQLite) */
    async init ({ commit, rootState }) {
      let rows = []
      // [LS-migration DB-fail fix] distinguish "DB genuinely empty" from "DB read FAILED": a
      // transient getAllCategories failure used to fall through into the LS→DB migration path
      // below, and loadList() re-seeded the FIXED default ids (100001-100003) which were then
      // committed via category.put — overwriting the real rows living under those same ids in
      // SQLite (rename a default category, hit one transient read failure, it reverts). On a read
      // failure the migration is skipped entirely: memory keeps the LS cache (setListFromDb never
      // persists), nothing is written to the DB, and the next init retries.
      let dbReadFailed = false
      try { rows = (await window.todoAPI.dbCall('getAllCategories')) || [] } catch (e) { dbReadFailed = true; console.warn('[category] SQLite read failed, using local cache', e) }
      try {
        // r6 ordering contract: the legacy blob may have an un-scrub rewrite in flight (setProject
        // unmark fired just before a reload) — drain it FIRST, else the union below resurrects a
        // project the user just cancelled from the not-yet-cleaned legacy array.
        await drainLegacyRewrites()
        const raw = await window.todoAPI.dbCall('getMeta', PROJECT_IDS_KEY)
        const ids = JSON.parse(raw || '[]')
        // Y/X3 legacy union: per-cat flag keys for every known row id, merged over the legacy blob
        // (a flag present only on a peer device arrives via its own per-cat key and must survive).
        const merged = (Array.isArray(ids) ? ids.slice() : [])
        // U-18: one batch read instead of an O(N) sequential getMeta per row (fallback keeps the loop)
        const flagVals = await getMetaManyWithFallback(rows.map(r => projectFlagKey(r.categoryId)))
        rows.forEach((r, i) => {
          if (flagVals[i] === '1' && !merged.includes(r.categoryId)) merged.push(r.categoryId)
        })
        if (merged.length) commit('setProjectIds', merged)
      } catch (e) { /* stays empty when no project flags */ }
      await this.dispatch('category/loadProjectMeta')
      // D15-B15: the LS-tombstone re-merge runs on EVERY successful DB read — not gated behind
      // rows.length. Deleting ALL categories and restarting used to fall through to the
      // `setListFromDb([])` migrated branch, dropping every in-retention tombstone from memory:
      // visibleCount read 0 and the recover-in-place entry went blind, contradicting the
      // documented recoverability promise precisely when the user needs it. (A failed DB read is
      // NOT a successful read: the dbReadFailed path below keeps the whole LS cache, tombstones
      // included, so nothing changes there.)
      if (dbReadFailed) {
        const lsCache = loadList()
        commit('setListFromDb', lsCache)
        return -1
      }
      const lsDels = mergeableLsTombstones(rows, rootState && rootState.settings && rootState.settings.recycleBinAutoDeleteDays)
      if (rows.length) {
        // Re-attach soft-deleted rows mirrored in LS (getAllCategories is live-only) so the in-app
        // recovery entry survives a restart; live DB rows win over a stale LS tombstone of the same id
        commit('setListFromDb', rows.concat(lsDels))
        return rows.length
      }
      // One-time migration flag: otherwise "migrate only when the table is empty" would resurrect old localStorage caches after the user deletes all categories
      let migrated = false
      try { migrated = (await window.todoAPI.dbCall('getMeta', 'categoryLsMigrated')) === '1' } catch (e) { /* empty */ }
      if (migrated) { commit('setListFromDb', lsDels); return 0 } // D15-B15: zero live categories ≠ zero recoverable categories
      const ls = loadList()
      try {
        // [D13 #7] the migration is restore-shaped (an empty DB being seeded from a cached copy):
        // without {restore:true}, toRow left LS-cached tombstones stampless and upsertCategory
        // stamped them `now` — after the first sync a peer's recovered/renamed category (real,
        // older updatedAt) lost LWW to the fresh now-tombstone and was re-deleted (Round-6 P2
        // hazard, unapplied to this path). restore:true gives only tombstones the epoch-oldest
        // stamp; live rows still take the now-stamp ('backup wins locally').
        for (const c of ls) await commitCommand("category", "put", toRow(c, { restore: true }))
        await commitCommand("meta", "put", ['categoryLsMigrated', '1'])
      } catch (e) { console.warn('[category] migration failed (local cache still usable):', e) }
      commit('setListFromDb', ls)
      return ls.length
    }
  }
}
