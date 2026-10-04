/* Categories sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Categories write (same SQLite categories table as the UI; camelCase row mapping mirrors store/category.js toRow). */
module.exports = ({ open, commit, audit, CliError, resolveCategory, projectFlagKey, projectStatusKey, MS_KEY, PROJECT_IDS_KEY }) => {
  const CAT_COLORS = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3', '#98a4ae']
  function catToRow (c) {
    return {
      id: c.categoryId, userId: c.userId != null ? c.userId : 840001,
      name: c.categoryName, color: c.categoryColor || null,
      createdAt: c.createTime || 0, sort: c.listSort || 0,
      isFolder: c.folderIs ? 1 : 0, parentId: c.folderId || 0, deleted: c.delete ? 1 : 0,
      // D18-DOM2 (#8, App parity store/category.js toRow): carry the tombstone stamp — markCascade
      // (App) sets deletedAt and toRow persists it; the CLI tombstones used to drop it, leaving the
      // stamped catFiltersBak.<deletedAt>.<id> key un-derivable on recover and the tombstone
      // age unknowable for the 30-day GC.
      deletedAt: c.deletedAt || 0
    }
  }
  function addCategory (name, { color, parent, folder } = {}) {
    const db = open()
    const cats = db.call('getAllCategories')
    if (cats.some(c => c.categoryName === name)) throw new CliError('category "' + name + '" already exists (names must stay unique so the CLI can address them)', 'CATEGORY_EXISTS')
    let parentId = 0
    if (parent != null && parent !== true) {
      // resolveCategory returns the bare id — look the row back up before the folder check
      // (was: p.folderIs on a number, always undefined → `category add --parent` rejected every parent)
      const pid = resolveCategory(parent)
      const p = cats.find(c => c.categoryId === pid)
      if (!p || !p.folderIs) throw new CliError('parent "' + parent + '" is not a folder', 'CATEGORY_NOT_FOLDER')
      if (folder) throw new CliError('nested folders are not supported — the App renders folders as roots only (same guard as category move)', 'CATEGORY_NESTED_FOLDER')
      parentId = pid
    }
    const cat = {
      categoryId: Date.now() * 1000 + Math.floor(Math.random() * 1000), userId: 840001,
      categoryName: String(name), categoryColor: color && CAT_COLORS.includes(color) ? color : CAT_COLORS[cats.length % CAT_COLORS.length],
      createTime: Date.now(), listSort: Math.max(0, ...cats.map(c => c.listSort)) + 100,
      folderIs: !!folder, folderId: parentId, delete: false
    }
    commit('category', 'put', catToRow(cat))
    audit.record({ action: 'category.add', targets: [], changes: [{ after: { name, id: cat.categoryId } }], note: (folder ? 'folder' : 'category') + ' created' })
    return cat
  }
  function renameCategory (input, nextName) {
    const db = open()
    const id = resolveCategory(input)
    const cat = db.call('getAllCategories').find(c => c.categoryId === id)
    if (db.call('getAllCategories').some(c => c.categoryId !== id && c.categoryName === nextName)) throw new CliError('category "' + nextName + '" already exists', 'CATEGORY_EXISTS')
    const updated = Object.assign({}, cat, { categoryName: nextName })
    commit('category', 'put', catToRow(updated))
    audit.record({ action: 'category.rename', targets: [], changes: [{ before: { name: cat.categoryName }, after: { name: nextName } }], note: 'category renamed' })
    return updated
  }
  /** Best-effort meta read for the delete backup path ('' when the row/host is absent) */
  function safeGetMeta (k) { try { return open().call('getMeta', k) || '' } catch { return '' } }
  /** Soft delete (same as UI: delete flag + cascade to children; tasks keep categoryId and fall back to the default (uncategorized) in views). Project flag/deadline meta cleaned here. */
  function deleteCategory (input) {
    const db = open()
    const id = resolveCategory(input)
    const all = db.call('getAllCategories')
    const cat = all.find(c => c.categoryId === id)
    const victims = [cat]
    if (cat.folderIs) {
      const mark = pid => { all.filter(c => c.folderId === pid).forEach(c => { victims.push(c); if (c.folderIs) mark(c.categoryId) }) }
      mark(id)
    }
    // D18-DOM2 (#8): ONE shared tombstone stamp for the whole cascade — recover re-derives the
    // stamped catFiltersBak key from the tombstone's deletedAt, so all victims of one delete
    // must stamp identically.
    const deletedAt = Date.now()
    for (const c of victims) commit('category', 'put', catToRow(Object.assign({}, c, { delete: true, deletedAt })))
    // Round-3 P1 (U-4 parity with renderer category.js backupThenClearProjectMeta): back up the
    // project meta surfaces into `catProjectMetaBak.<id>` BEFORE clearing them — the UI's recover
    // path restores exactly this blob, and the CLI used to hard-delete the keys with no backup,
    // making a recovered category lose its project flag/status/deadline/milestones irreversibly.
    // (Must run before ANY live-key deletion below.)
    const catMetaBakKey = vid => 'catProjectMetaBak.' + vid
    // D19-DOM2 (#1, App parity renderer category.js backupThenClearProjectMeta): project documents
    // (ProjectDocs.vue persist) live in `projectDocs:<id>` — the App backs them up into the same
    // catProjectMetaBak blob and clears the live key on soft-delete; the CLI used to skip docs
    // entirely, so `purge` then hard-deleted the key and the project's documents were gone forever.
    const projectDocsKey = id => 'projectDocs:' + id
    for (const v of victims) {
      const vid = String(v.categoryId)
      const blob = {
        flag: (safeGetMeta(projectFlagKey(vid)) === '1'),
        status: safeGetMeta(projectStatusKey(vid)) || '',
        deadline: safeGetMeta('projectDeadline:' + vid) || '',
        milestones: safeGetMeta(MS_KEY(vid)) || '',
        // D15-B4 (App): absent raw ('' after the ||) stays falsy so an old backup blob without
        // the field restores cleanly.
        docs: safeGetMeta(projectDocsKey(vid)) || ''
      }
      if (blob.flag || blob.status || blob.deadline || blob.milestones || blob.docs) {
        commit('meta', 'put', [catMetaBakKey(vid), JSON.stringify(blob)])
      }
    }
    // A deleted category must not linger as a project: X3 flag keys are removed per victim; the
    // legacy whole-doc array (read fallback) is pruned only when it actually lost an id.
    for (const v of victims) { try { commit('meta', 'delete', projectFlagKey(v.categoryId)) } catch { /* absent is fine */ } }
    let legacyIds = []
    try { const a = JSON.parse(open().call('getMeta', PROJECT_IDS_KEY) || '[]'); if (Array.isArray(a)) legacyIds = a } catch { /* corrupt → leave alone */ }
    const pruned = legacyIds.filter(x => !victims.some(v => String(v.categoryId) === String(x)))
    if (pruned.length !== legacyIds.length) commit('meta', 'put', [PROJECT_IDS_KEY, JSON.stringify(pruned)])
    for (const v of victims) {
      try { commit('meta', 'delete', projectFlagKey(v.categoryId)) } catch { /* absent is fine */ }
      try { commit('meta', 'delete', 'projectDeadline:' + v.categoryId) } catch { /* absent is fine */ }
      // same lifecycle cleanup for the explicit status meta (review P2 2026-09-11): a later category id
      // reuse would inherit the deleted project's stale status on both ends (key = projectStatus:<id>)
      try { commit('meta', 'delete', projectStatusKey(v.categoryId)) } catch { /* absent is fine */ }
      // milestones die with the deletion too (backed up above — renderer parity backupThenClearProjectMeta)
      try { commit('meta', 'delete', MS_KEY(v.categoryId)) } catch { /* absent is fine */ }
      // D19-DOM2 (#1): project docs die with the deletion too (backed up above — App parity
      // backupThenClearProjectMeta clears projectDocs:<id> after the backup write)
      try { commit('meta', 'delete', projectDocsKey(v.categoryId)) } catch { /* absent is fine */ }
    }
    // P1-3 (R5, sync-visible parity with renderer category.js purgeFiltersForVictims): saved
    // filters whose conds.catId references a cascade victim must die with the category — the
    // renderer cascades them (and its undo reports "{n} saved filter(s) removed"), the CLI used
    // to leave them behind pointing at a dead category id. Tombstone each victim filter through
    // the bus (filter.delete), back the set up for recover symmetry, and report the count in the
    // command output. D18-DOM2 (#8, D15-B6 parity): the backup key is now the STAMPED
    // `catFiltersBak.<deletedAt>.<id>` shape the renderer writes (so the startup meta GC can bound
    // its retention to the recover window); the legacy `catFiltersBak.<id>` shape stays readable
    // as a fallback (restoreFiltersBackup reads stamped first, legacy second — same as the App).
    const deadCatIds = new Set(victims.map(v => String(v.categoryId)))
    const catFiltersBakKey = 'catFiltersBak.' + deletedAt + '.' + id
    let removedFilters = 0
    let doomedFilters = []
    try {
      doomedFilters = (db.call('filterList') || []).filter(f => f && f.conds && deadCatIds.has(String(f.conds.catId)))
    } catch { /* degraded read: leave filters alone rather than half-cascading */ }
    if (doomedFilters.length) {
      commit('meta', 'put', [catFiltersBakKey, JSON.stringify(doomedFilters.map(f => ({ id: f.id, name: f.name, conds: f.conds, sort: f.sort })))])
      for (const f of doomedFilters) {
        try { commit('filter', 'delete', f.id); removedFilters++ } catch { /* skip and keep cascading */ }
      }
    }
    audit.record({ action: 'category.delete', targets: [], changes: [{ before: { names: victims.map(v => v.categoryName) } }], note: 'category soft-deleted (recoverable in UI), tasks kept' + (removedFilters ? `, ${removedFilters} saved filter(s) removed` : '') })
    return { deleted: victims.map(v => ({ id: v.categoryId, name: v.categoryName })), removedFilters }
  }

  /** Move a category under a folder or back to root ('root'). Parity note: the App's hierarchy getter
   *  (renderer/js/store/category.js `hierarchical`) renders folders as roots and only nests non-folder
   *  children — a nested folder would be silently dropped from the sidebar — so folder→folder moves are rejected. */
  function moveCategory (input, parentInput) {
    const db = open()
    const id = resolveCategory(input)
    const all = db.call('getAllCategories')
    const cat = all.find(c => c.categoryId === id)
    if (!cat) throw new CliError(`category not found: "${input}"`, 'CATEGORY_NOT_FOUND')
    const raw = String(parentInput == null ? '' : parentInput).trim().toLowerCase()
    let parentId = 0
    let parent = null
    if (raw && raw !== 'root' && raw !== 'none') {
      const pid = resolveCategory(parentInput)
      if (pid === id) throw new CliError('cannot move a category under itself', 'CATEGORY_CYCLE')
      parent = all.find(c => c.categoryId === pid)
      if (!parent) throw new CliError(`category not found: "${parentInput}"`, 'CATEGORY_NOT_FOUND')
      // Cycle guard first (more specific error): walk up from the parent; landing on the moved category closes a loop
      let cur = parent
      const seen = new Set()
      while (cur && cur.folderId && !seen.has(cur.categoryId)) {
        seen.add(cur.categoryId)
        if (cur.folderId === id) throw new CliError(`cannot move "${cat.categoryName}" into its own descendant (cycle)`, 'CATEGORY_CYCLE')
        const nextId = cur.folderId
        cur = all.find(c => c.categoryId === nextId)
      }
      if (!parent.folderIs) throw new CliError(`"${parent.categoryName}" is not a folder — the App only nests categories inside folders`, 'CATEGORY_NOT_FOLDER')
      if (cat.folderIs) throw new CliError(`"${cat.categoryName}" is a folder: the App renders folders as roots only (nested folders are dropped from the sidebar), so folder→folder moves are rejected`, 'CATEGORY_NESTED_FOLDER')
      parentId = pid
    }
    commit('category', 'put', catToRow(Object.assign({}, cat, { folderId: parentId })))
    audit.record({
      action: 'category.move',
      targets: [{ taskId: 'cat:' + id, content: cat.categoryName }],
      changes: [{ before: { parent: cat.folderId }, after: { parent: parentId } }],
      note: parent ? 'moved under folder "' + parent.categoryName + '"' : 'moved to root'
    })
    return { categoryId: id, name: cat.categoryName, folderId: parentId, parentName: parent ? parent.categoryName : null }
  }

  /** Flat rows for `categories --json`: getAllCategories rows (order unchanged) + additive parentName */
  function categoryRows () {
    const cats = open().call('getAllCategories')
    const byId = new Map(cats.map(c => [c.categoryId, c]))
    return cats.map(c => ({
      ...c,
      folderIs: !!c.folderIs,
      parentName: c.folderId && byId.get(c.folderId) ? byId.get(c.folderId).categoryName : null
    }))
  }

  /** Display order for the `categories` text listing: folders are roots with their children indented under
   *  them (mirrors the App's `hierarchical` getter); orphans render at root level rather than vanishing. */
  function categoryHierarchy () {
    const cats = categoryRows()
    const out = []
    const printed = new Set()
    for (const c of cats) {
      if (c.folderIs) {
        out.push({ row: c, depth: 0 })
        printed.add(c.categoryId)
        for (const ch of cats.filter(x => !x.folderIs && x.folderId === c.categoryId)) {
          out.push({ row: ch, depth: 1 })
          printed.add(ch.categoryId)
        }
      }
    }
    for (const c of cats) if (!printed.has(c.categoryId)) out.push({ row: c, depth: 0 })
    return out
  }

  return { addCategory, renameCategory, deleteCategory, moveCategory, categoryRows, categoryHierarchy }
}
