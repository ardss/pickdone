import { safeSet, dayjs } from '../utils/core.js'
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
function toRow (c) {
  return {
    id: c.categoryId,
    userId: c.userId != null ? c.userId : 840001,
    name: c.categoryName,
    color: c.categoryColor || null,
    createdAt: c.createTime || 0,
    sort: c.listSort || 0,
    isFolder: c.folderIs ? 1 : 0,
    parentId: c.folderId || 0,
    deleted: c.delete ? 1 : 0
  }
}

/** Dual write: localStorage stays as cache/disaster recovery, SQLite is authoritative (unified CLI/UI data source) */
function persist (list) {
  safeSet(LS_KEY, JSON.stringify({ list }))
  try {
    // Failures must be visible: LS is already updated above, so a silent per-row catch meant the user
    // believed categories were saved while SQLite (the CLI-visible authority) silently diverged
    const jobs = list.map(c => window.todoAPI.dbCall('upsertCategory', toRow(c)).catch(e => ({ err: e })))
    Promise.all(jobs).then(results => {
      const failed = results.filter(r => r && r.err)
      if (failed.length) console.error('[category] save failed for', failed.length, 'of', list.length, 'rows:', failed[0].err)
    }).catch(e => console.error('[category] save failed:', e))
  } catch (e) { console.warn('[category] SQLite write failed (cached locally only):', e) }
}

let idSeed = null
function nextId () {
  if (!idSeed) idSeed = Date.now()
  return ++idSeed
}

/** Meta key for project flags: value is a JSON array of categoryIds. A project = a flagged category, zero schema changes */
const PROJECT_IDS_KEY = 'projectCategoryIds'
const deadlineKey = id => 'projectDeadline:' + id
/** Project lifecycle status (contract shared with the CLI): string active|paused|done|cancelled, absent = 'active' */
const statusKey = id => 'projectStatus:' + id
/** Pure helper (unit-tested): the ids a cascade delete of `id` will mark deleted — the category itself plus,
 *  mirroring markCascade, folder descendants recursively and their non-folder children. Lets softDelete clean
 *  project meta for every victim, matching the CLI delete path. */
function collectCascadeIds (state, id) {
  const out = []
  const walk = cid => {
    out.push(cid)
    state.list.filter(x => x.folderId === cid && x.categoryId !== cid).forEach(x => { if (x.folderIs) walk(x.categoryId); else out.push(x.categoryId) })
  }
  walk(id)
  return out
}
export { collectCascadeIds }

export default {
  namespaced: true,
  state: () => ({ list: loadList(), projectIds: [], projectMeta: {} }),
  getters: {
    byId: s => id => s.list.find(c => c.categoryId === id) || null,
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
      const ids = state.projectIds.filter(x => !victims.includes(x))
      if (ids.length !== state.projectIds.length) {
        state.projectIds = ids
        try { window.todoAPI.dbCall('setMeta', [PROJECT_IDS_KEY, JSON.stringify(ids)]).catch(() => {}) } catch (e) { /* degraded host */ }
      }
      for (const vid of victims) {
        try { window.todoAPI.dbCall('deleteMeta', statusKey(vid)).catch(() => {}) } catch (e) { /* absent is fine */ }
        try { window.todoAPI.dbCall('deleteMeta', deadlineKey(vid)).catch(() => {}) } catch (e) { /* absent is fine */ }
        delete state.projectMeta[vid]
      }
      persist(state.list)
    },
    markCascade (state, id) {
      const mark = cid => {
        const c = state.list.find(x => x.categoryId === cid)
        if (c) { c.delete = true }
        state.list.filter(x => x.folderId === cid).forEach(x => { if (x.folderIs) mark(x.categoryId); else x.delete = true })
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
    /** Set/unset project: memory + meta persistence (caller removes the flag first when a category is deleted) */
    setProject (state, { id, flag }) {
      const ids = state.projectIds.filter(x => x !== id)
      if (flag) ids.push(id)
      state.projectIds = ids
      try {
        window.todoAPI.dbCall('setMeta', [PROJECT_IDS_KEY, JSON.stringify(ids)]).catch(() => {})
      } catch (e) { /* in-memory only when the browser debug host degrades */ }
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
    async init ({ commit }) {
      let rows = []
      try { rows = (await window.todoAPI.dbCall('getAllCategories')) || [] } catch (e) { console.warn('[category] SQLite read failed, using local cache', e) }
      try {
        const raw = await window.todoAPI.dbCall('getMeta', PROJECT_IDS_KEY)
        const ids = JSON.parse(raw || '[]')
        if (Array.isArray(ids)) commit('setProjectIds', ids)
      } catch (e) { /* stays empty when no project flags */ }
      await this.dispatch('category/loadProjectMeta')
      if (rows.length) { commit('setList', rows); return rows.length }
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
