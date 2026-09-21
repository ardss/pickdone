import { safeSet, dayjs, getMetaManyWithFallback } from '../utils/core.js'
import { loadMilestones } from '../utils/milestones.js'
import { normalizeStatus } from '../utils/projectStatus.js'
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

/** Dual write: localStorage stays as cache/disaster recovery, SQLite is authoritative (unified CLI/UI data source) */
function persist (list, opts = {}) {
  safeSet(LS_KEY, JSON.stringify({ list }))
  try {
    // Failures must be visible: LS is already updated above, so a silent per-row catch meant the user
    // believed categories were saved while SQLite (the CLI-visible authority) silently diverged
    const jobs = list.map(c => window.todoAPI.dbCall('upsertCategory', toRow(c, opts)).catch(e => ({ err: e })))
    Promise.all(jobs).then(results => {
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
function writeProjectFlag (id, flag) {
  try {
    if (flag) window.todoAPI.dbCall('setMeta', [projectFlagKey(id), '1']).catch(() => {})
    else window.todoAPI.dbCall('deleteMeta', projectFlagKey(id)).catch(() => {})
  } catch (e) { /* degraded host */ }
}
const deadlineKey = id => 'projectDeadline:' + id
/** Project lifecycle status (contract shared with the CLI): string active|paused|done|cancelled, absent = 'active' */
const statusKey = id => 'projectStatus:' + id
const milestonesKey = id => 'projectMilestones:' + id
/** U-4 (2026-09-20): machine-local backup of a soft-deleted project category's meta. The old code
 *  hard-deleted projectCategoryFlag/Status/Deadline (and left milestones orphaned), so recovering the
 *  category irreversibly lost its project metadata. Pattern mirrors metaConflictBackup.*: the live keys
 *  are copied into one `catProjectMetaBak.<id>` JSON blob, cleared from their live keys, and restored +
 *  the backup deleted on recover. */
const catMetaBakKey = id => 'catProjectMetaBak.' + id
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
  if (blob.flag || blob.status || blob.deadline || blob.milestones) {
    try {
      await window.todoAPI.dbCall('setMeta', [catMetaBakKey(id), JSON.stringify(blob)])
    } catch (e) {
      console.warn('[category] project-meta backup write failed — live keys kept for', id, e)
      return
    }
  }
  try { await window.todoAPI.dbCall('deleteMeta', projectFlagKey(id)) } catch (e) { /* absent is fine */ }
  try { await window.todoAPI.dbCall('deleteMeta', statusKey(id)) } catch (e) { /* absent is fine */ }
  try { await window.todoAPI.dbCall('deleteMeta', deadlineKey(id)) } catch (e) { /* absent is fine */ }
  try { await window.todoAPI.dbCall('deleteMeta', milestonesKey(id)) } catch (e) { /* absent is fine */ }
}
/** U-4 recover path: restore the backed-up project meta to its live keys, then delete the backup.
 *  Resolves true when a backup existed and was restored. */
async function restoreProjectMetaBackup (id) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return false
  let blob = null
  try { blob = JSON.parse((await window.todoAPI.dbCall('getMeta', catMetaBakKey(id))) || 'null') } catch (e) { blob = null }
  if (!blob || typeof blob !== 'object') return false
  try { if (blob.flag) await window.todoAPI.dbCall('setMeta', [projectFlagKey(id), '1']) } catch (e) { /* best-effort */ }
  try { if (blob.status) await window.todoAPI.dbCall('setMeta', [statusKey(id), blob.status]) } catch (e) { /* best-effort */ }
  try { if (blob.deadline) await window.todoAPI.dbCall('setMeta', [deadlineKey(id), blob.deadline]) } catch (e) { /* best-effort */ }
  try { if (blob.milestones) await window.todoAPI.dbCall('setMeta', [milestonesKey(id), blob.milestones]) } catch (e) { /* best-effort */ }
  try { await window.todoAPI.dbCall('deleteMeta', catMetaBakKey(id)) } catch (e) { /* best-effort */ }
  return !!blob.flag
}
/** U-5 (2026-09-20): the ONE sanctioned legacy-array write — on unmark, rewrite `projectCategoryIds`
 *  without the id so init()'s legacy union cannot resurrect the unset project from a stale blob.
 *  (Per-cat flag key deletion stays the primary syncable write; CLI twin does the same — F-Main.) */
function rewriteLegacyProjectIdsWithout (id) {
  try {
    void (async () => {
      if (!window.todoAPI || !window.todoAPI.dbCall) return
      const arr = JSON.parse((await window.todoAPI.dbCall('getMeta', PROJECT_IDS_KEY)) || '[]')
      if (Array.isArray(arr) && arr.includes(id)) {
        await window.todoAPI.dbCall('setMeta', [PROJECT_IDS_KEY, JSON.stringify(arr.filter(x => x !== id))])
      }
    })()
  } catch (e) { /* degraded host: nothing to rewrite */ }
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

/** D5: remove saved filters referencing any victim categoryId. `this` = the store (mutations bind it).
 *  Best-effort: a DB failure leaves the in-memory purge skipped too, so state and DB stay consistent
 *  (the filter keeps working as before rather than silently diverging). */
function purgeFiltersForVictims (victims) {
  const fstate = this.state && this.state.filters
  if (!fstate || !Array.isArray(fstate.list) || !fstate.list.length) return
  const dead = new Set(victims.map(v => String(v)))
  const doomed = fstate.list.filter(f => f && f.conds && dead.has(String(f.conds.catId)))
  if (!doomed.length) return
  const doomedIds = new Set(doomed.map(f => f.id))
  fstate.list = fstate.list.filter(f => !doomedIds.has(f.id))
  for (const f of doomed) {
    try { window.todoAPI.dbCall('filterDelete', f.id).catch(e => console.error('[category] filterDelete failed during category delete:', e)) } catch (e) { /* degraded host */ }
  }
  this.commit('filters/setList', fstate.list)
}

/** Deleted categories cannot come back through getAllCategories (WHERE deleted = 0), so they are mirrored
 *  in the LS cache by persist() and re-merged here on startup. Without this a soft-deleted category
 *  vanished from state on restart: visibleCount dropped to 0 and the recover-in-place entry went blind,
 *  contradicting the CLI's "recoverable in App" promise. Entries already re-added (same id, live in DB) win. */
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
        // U-4: back up then clear the project meta (flag/status/deadline/milestones) — recover restores it
        backupThenClearProjectMeta(vid)
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
      const ids = state.projectIds.filter(x => x !== id)
      if (flag) ids.push(id)
      state.projectIds = ids
      writeProjectFlag(id, flag) // Y/X3: field-granular unit — the only persisted/synced write
      if (!flag) rewriteLegacyProjectIdsWithout(id) // U-5: unset must also scrub the stale legacy blob, else init()'s union resurrects the project
    },
    /** U-4 (2026-09-20): recover a soft-deleted category in place and restore its backed-up project
     *  meta (flag/status/deadline/milestones) from `catProjectMetaBak.<id>`, then delete the backup.
     *  A restored project flag also re-enters the in-memory projectIds list. */
    recover (state, id) {
      const c = state.list.find(x => x.categoryId === id)
      if (!c || !c.delete) return
      c.delete = false
      c.deletedAt = 0
      persist(state.list)
      restoreProjectMetaBackup(id).then(flagRestored => {
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
    /** Set project lifecycle status: memory + meta persistence (same degradation as setProject) */
    setProjectStatus (state, { id, status }) {
      const norm = normalizeStatus(status)
      const meta = { ...state.projectMeta, [id]: { ...(state.projectMeta[id] || {}), status: norm } }
      state.projectMeta = meta
      try {
        window.todoAPI.dbCall('setMeta', [statusKey(id), norm]).catch(() => {})
      } catch (e) { /* in-memory only when the browser debug host degrades */ }
    }
  },
  actions: {
    async add ({ commit }, payload) { commit('addCategory', payload); return true }, // reserved: api.addCategoryList
    /** Unified loading of project metadata: status + deadline + next milestone (views/sidebar read only via this getter) */
    async loadProjectMeta ({ state, commit }) {
      if (!state.projectIds.length || !window.todoAPI || !window.todoAPI.dbCall) return
      const patch = {}
      const today0 = +dayjs().startOf('day')
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
          entry.nextMilestone = ms.filter(m => m.date >= today0)[0] || null
        } catch { entry.nextMilestone = null }
        patch[id] = entry
      }
      commit('mergeProjectMeta', patch)
    },
    /** Startup loading: SQLite is authoritative; when the table is empty and a local cache exists, perform a one-time migration (LS → SQLite) */
    async init ({ commit, rootState }) {
      let rows = []
      try { rows = (await window.todoAPI.dbCall('getAllCategories')) || [] } catch (e) { console.warn('[category] SQLite read failed, using local cache', e) }
      try {
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
      if (rows.length) {
        // Re-attach soft-deleted rows mirrored in LS (getAllCategories is live-only) so the in-app
        // recovery entry survives a restart; live DB rows win over a stale LS tombstone of the same id
        // G1 tombstone expiry: a tombstone whose category was already PURGED (hard-deleted from the
        // recycle bin) is invisible to the live-rows check above and used to be re-merged forever —
        // the "permanently deleted" category resurrected as a ghost on every restart. Only re-attach
        // tombstones inside the recycle-bin retention window; old tombstones without deletedAt are
        // conservatively kept (pre-dates the stamp, may still be within an unknown window).
        const retentionDays = Number(rootState && rootState.settings && rootState.settings.recycleBinAutoDeleteDays) || 30
        const cutoff = Date.now() - retentionDays * 86400000
        const dels = deletedFromLs().filter(d =>
          !rows.some(r => r.categoryId === d.categoryId) &&
          (!d.deletedAt || d.deletedAt > cutoff))
        commit('setList', rows.concat(dels))
        return rows.length
      }
      // One-time migration flag: otherwise "migrate only when the table is empty" would resurrect old localStorage caches after the user deletes all categories
      let migrated = false
      try { migrated = (await window.todoAPI.dbCall('getMeta', 'categoryLsMigrated')) === '1' } catch (e) { /* empty */ }
      if (migrated) { commit('setList', []); return 0 }
      const ls = loadList()
      try {
        for (const c of ls) await window.todoAPI.dbCall('upsertCategory', toRow(c))
        await window.todoAPI.dbCall('setMeta', ['categoryLsMigrated', '1'])
      } catch (e) { console.warn('[category] migration failed (local cache still usable):', e) }
      commit('setList', ls)
      return ls.length
    }
  }
}
