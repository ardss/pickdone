'use strict'
/**
 * Independent project entity / explicit task-project membership.
 *
 * Store one project per synced meta key, one task assignment per synced meta key.
 * No schema migration or legacy task/category rewrite during coexistence. All
 * writes go through the command bus; replay is idempotent.
 */
const {
  PROJECT_V2_PREFIX,
  TASK_PROJECT_V2_PREFIX,
  projectKey, taskProjectKey, createLegacyProjectRecord, parseProjectRecord,
  quarantinedLegacyProjects, projectIdFromLegacy
} = require('../shared/project-v2.mjs')

module.exports = function makeProjectV2Api ({ lib }) {
  const db = () => lib.open()
  function liveEntities () {
    return (db().call('listMetaKeys') || [])
      .filter(k => String(k).startsWith(PROJECT_V2_PREFIX))
      .map(k => ({ key: k, entity: parseProjectRecord(db().call('getMeta', k)) }))
      .filter(x => x.entity && projectKey(x.entity.projectId) === x.key)
      .map(x => x.entity)
      .filter(x => !x.deleted)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }
  function assignments () {
    return (db().call('listMetaKeys') || [])
      .filter(k => String(k).startsWith(TASK_PROJECT_V2_PREFIX))
      .map(k => ({ taskId: String(k).slice(TASK_PROJECT_V2_PREFIX.length), projectId: db().call('getMeta', k) }))
      .filter(x => x.taskId && x.projectId)
  }
  function list () {
    const tasks = lib.liveTasks()
    const taskById = new Map(tasks.map(t => [t.taskId, t]))
    const grouped = new Map()
    for (const x of assignments()) {
      const task = taskById.get(x.taskId)
      if (!task) continue
      if (!grouped.has(x.projectId)) grouped.set(x.projectId, [])
      grouped.get(x.projectId).push(task)
    }
    const now = Date.now()
    const today = new Date(now).setHours(0, 0, 0, 0)
    const week = today + 7 * 86400000
    const focusRows = typeof lib.tomatoRecords === 'function' ? lib.tomatoRecords() : []
    return liveEntities().map(p => {
      const assigned = grouped.get(p.projectId) || []
      const done = assigned.filter(t => t.complete)
      const ids = new Set(assigned.map(t => t.taskId))
      const key = p.legacyCategoryId || p.projectId
      const legacyDeadline = Number(db().call('getMeta', 'projectDeadline:' + key)) || 0
      const deadline = p.deadline == null ? legacyDeadline : Number(p.deadline) || 0
      return {
        ...p, categoryId: p.legacyCategoryId || null,
        assignedTaskCount: assigned.length, total: assigned.length, done: done.length,
        progress: assigned.length ? Math.round(done.length / assigned.length * 100) : 0,
        startedAt: assigned.length ? Math.min(...assigned.map(t => Number(t.createTime) || now)) : 0,
        lastActivity: done.reduce((n, t) => Math.max(n, Number(t.completedAt) || 0), 0),
        focusMinutes: focusRows.reduce((n, f) => n + (ids.has(f.focusTaskId) && f.succeed !== false ? Number(f.focusDuration) || 0 : 0), 0),
        overdue: assigned.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < today).length,
        next7days: assigned.filter(t => !t.complete && t.dayStart >= today && t.dayStart <= week).length,
        deadline
      }
    })
  }
  function audit () {
    const cats = db().call('getAllCategories')
    const tasks = lib.liveTasks()
    const ids = lib.getProjectIds()
    return {
      schemaVersion: 1,
      independentProjects: list(),
      quarantine: quarantinedLegacyProjects(cats, ids, tasks),
      liveLegacyProjectCount: ids.length,
      liveCategoryCount: cats.length,
      unassignedLegacyProjectTasks: tasks.filter(t => ids.includes(String(t.categoryId)) &&
        !db().call('getMeta', TASK_PROJECT_V2_PREFIX + t.taskId)).length,
      // Historical blank categories are neither deleted nor silently granted a name.
      blankCategories: cats.filter(c => !String(c.categoryName || '').trim()).length
    }
  }
  /** A migration plan is computed from original records only. No #tag inference. */
  function migrationPlan () {
    const eligible = lib.getProjects().filter(c => String(c.name || '').trim())
    const categoriesById = new Map(db().call('getAllCategories').map(c => [String(c.categoryId), c]))
    const tasks = lib.liveTasks()
    const entities = []
    const links = []
    for (const project of eligible) {
      const c = categoriesById.get(String(project.categoryId))
      if (!c || c.categoryName !== project.name) throw new lib.CliError('project/category mismatch for ' + project.categoryId, 'PROJECT_V2_SOURCE_MISMATCH')
      const entity = createLegacyProjectRecord(c, project.status)
      const key = projectKey(entity.projectId)
      const old = db().call('getMeta', key)
      const parsed = old ? parseProjectRecord(old) : null
      if (old && (!parsed || parsed.legacyCategoryId !== entity.legacyCategoryId)) {
        throw new lib.CliError('v2 entity already differs: ' + key, 'PROJECT_V2_CONFLICT')
      }
      entities.push({ entity, key, old })
      // Once a project is migrated, new category changes never reassign tasks implicitly.
      if (old) continue
      for (const task of tasks.filter(t => String(t.categoryId) === String(c.categoryId))) {
        const tk = taskProjectKey(task.taskId)
        const existing = db().call('getMeta', tk)
        if (existing && existing !== entity.projectId) throw new lib.CliError('task project conflict: ' + task.taskId, 'TASK_PROJECT_V2_CONFLICT')
        links.push({ taskId: task.taskId, key: tk, projectId: entity.projectId, existing })
      }
    }
    return { entities, links, quarantine: audit().quarantine }
  }
  function migrate ({ yes = false } = {}) {
    const plan = migrationPlan()
    const summary = {
      dryRun: !yes,
      projectCount: plan.entities.length,
      projectNames: plan.entities.map(x => x.entity.name),
      totalLinks: plan.links.length,
      newEntities: plan.entities.filter(x => !x.old).length,
      newLinks: plan.links.filter(x => !x.existing).length,
      unresolvedProjects: plan.quarantine.length,
      unresolvedTaskCount: plan.quarantine.reduce((n, p) => n + p.taskCount, 0)
    }
    if (!yes) return summary
    let wroteEntities = 0
    let wroteLinks = 0
    // All conflicts were checked prior to the first mutation. Retry is safe.
    for (const x of plan.entities) {
      if (x.old) continue
      lib.commit('meta', 'put', [x.key, JSON.stringify(x.entity)])
      wroteEntities++
    }
    for (const x of plan.links) {
      if (x.existing) continue
      lib.commit('meta', 'put', [x.key, x.projectId])
      wroteLinks++
    }
    // Report only what the DB really contains now, never assume the write succeeded.
    const verified = list()
    for (const x of plan.entities) {
      const row = verified.find(v => v.projectId === x.entity.projectId)
      if (!row || row.name !== x.entity.name) throw new Error('PROJECT_V2_READBACK_FAILED ' + x.key)
    }
    for (const x of plan.links) {
      if (db().call('getMeta', x.key) !== x.projectId) throw new Error('TASK_PROJECT_V2_READBACK_FAILED ' + x.key)
    }
    lib.audit.record({ action: 'project-v2.migrate', targets: [],
      changes: [{ after: { entities: wroteEntities, taskLinks: wroteLinks } }],
      note: 'verified legacy project identity migration; unknown names preserved without guessing' })
    return { ...summary, dryRun: false, wroteEntities, wroteLinks, verified: true }
  }

  const crypto = require('node:crypto')
  function allEntities () {
    return (db().call('listMetaKeys') || []).filter(k => String(k).startsWith(PROJECT_V2_PREFIX))
      .map(k => ({ key: k, entity: parseProjectRecord(db().call('getMeta', k)) }))
      .filter(x => x.entity && projectKey(x.entity.projectId) === x.key).map(x => x.entity)
  }
  function checkedName (value, excludingId) {
    const name = String(value || '').trim()
    if (!name || name.length > 150) throw new lib.CliError('project name must contain 1..150 characters', 'PROJECT_NAME_INVALID')
    const folded = name.normalize('NFKC').toLocaleLowerCase()
    if (allEntities().some(p => !p.deleted && p.projectId !== excludingId && p.name.normalize('NFKC').toLocaleLowerCase() === folded)) {
      throw new lib.CliError('project name already exists: ' + name, 'PROJECT_NAME_DUPLICATE')
    }
    return name
  }
  function writeChecked (key, value) {
    lib.commit('meta', 'put', [key, value])
    if (db().call('getMeta', key) !== value) throw new Error('PROJECT_V2_READBACK_FAILED:' + key)
  }
  function update ({ projectId, patch }) {
    const id = String(projectId || '')
    const previous = allEntities().find(p => p.projectId === id)
    if (!previous) throw new lib.CliError('project not found: ' + id, 'PROJECT_V2_NOT_FOUND')
    const whitelist = new Set(['name', 'status', 'color', 'deleted', 'deadline'])
    for (const k of Object.keys(patch || {})) if (!whitelist.has(k)) throw new lib.CliError('unsupported project field: ' + k, 'PROJECT_FIELD_INVALID')
    const next = { ...previous, ...(patch || {}), projectId: id, legacyCategoryId: previous.legacyCategoryId, updatedAt: Date.now() }
    if (previous.deleted && patch.deleted !== false) throw new lib.CliError('restore archived project explicitly', 'PROJECT_RESTORE_REQUIRED')
    if (patch.name !== undefined || (previous.deleted && patch.deleted === false)) next.name = checkedName(next.name, id)
    if (!['active','paused','done','cancelled'].includes(next.status)) throw new lib.CliError('invalid status', 'PROJECT_STATUS_INVALID')
    if (typeof next.deleted !== 'boolean') throw new lib.CliError('invalid archived flag', 'PROJECT_ARCHIVE_INVALID')
    if (next.color !== undefined && (typeof next.color !== 'string' || next.color.length > 30)) throw new lib.CliError('invalid color', 'PROJECT_COLOR_INVALID')
    writeChecked(projectKey(id), JSON.stringify(next))
    lib.audit.record({ action: 'project-v2.update', targets: [{ taskId: id, content: next.name }], note: 'independent project update' })
    return next
  }
  function create ({ name, color }) {
    const n = checkedName(name)
    const projectId = 'prj_' + crypto.randomUUID().replace(/-/g, '')
    const entity = { schemaVersion: 1, projectId, name: n, color: color || '#7ac74f',
      status: 'active', createdAt: Date.now(), updatedAt: Date.now(), deleted: false, origin: 'native-project-v2' }
    writeChecked(projectKey(projectId), JSON.stringify(entity))
    lib.audit.record({ action: 'project-v2.create', targets: [{ taskId: projectId, content: n }], note: 'independent project creation' })
    return entity
  }
  function assign ({ taskId, projectId }) {
    const task = String(taskId || '')
    if (!lib.liveTasks().some(t => t.taskId === task)) throw new lib.CliError('task not found: ' + task, 'TASK_NOT_FOUND')
    const key = taskProjectKey(task)
    const old = db().call('getMeta', key)
    if (projectId) {
      const dest = allEntities().find(x => x.projectId === projectId && !x.deleted)
      if (!dest) throw new lib.CliError('project not found: ' + projectId, 'PROJECT_V2_NOT_FOUND')
      if (old !== projectId) writeChecked(key, projectId)
    } else {
      lib.commit('meta', 'delete', key)
      if (db().call('getMeta', key) != null) throw new Error('PROJECT_V2_UNASSIGN_READBACK_FAILED')
    }
    lib.audit.record({ action: 'project-v2.assign', targets: [{ taskId: task, content: task }], note: String(old||'none')+' -> '+String(projectId||'none') })
    return { taskId: task, previousProjectId: old || null, projectId: projectId || null, verified: true }
  }
  function recover ({ legacyCategoryId, name }) {
    const id = String(legacyCategoryId)
    if (!lib.getProjectIds().map(String).includes(id)) throw new lib.CliError('not a known legacy project ID', 'LEGACY_PROJECT_NOT_FOUND')
    const record = db().call('getAllCategories').find(c => String(c.categoryId) === id)
    if (!record || String(record.categoryName || '').trim()) throw new lib.CliError('legacy category not quarantined', 'LEGACY_PROJECT_NOT_QUARANTINED')
    const projectId = projectIdFromLegacy(id)
    if (allEntities().some(p => p.projectId === projectId)) throw new lib.CliError('legacy project already recovered', 'LEGACY_PROJECT_ALREADY_RECOVERED')
    const valid = checkedName(name)
    const linked = lib.liveTasks().filter(t => String(t.categoryId) === id)
    const conflicts = linked.filter(t => {
      const assigned = db().call('getMeta', taskProjectKey(t.taskId))
      return !!assigned && assigned !== projectId
    })
    if (conflicts.length) throw new lib.CliError('existing explicit task ownership conflicts: '+conflicts.length, 'LEGACY_PROJECT_TASK_CONFLICT')
    const entity = {schemaVersion:1,projectId,name:valid,status:'active',legacyCategoryId:Number(id),
      createdAt:Number(record.createTime)||0,updatedAt:Date.now(),origin:'manually-confirmed-legacy-recovery',deleted:false}
    writeChecked(projectKey(projectId), JSON.stringify(entity))
    for (const t of linked) if (!db().call('getMeta', taskProjectKey(t.taskId))) writeChecked(taskProjectKey(t.taskId), projectId)
    lib.audit.record({ action:'project-v2.recover',targets:[{taskId:projectId,content:valid}],note:'confirmed legacy ID '+id+'; original category remains unchanged' })
    return {projectId,name:valid,linkedTasks:linked.length,verified:true}
  }

  function fromCategory ({ categoryId }) {
    const id = String(categoryId)
    const c = db().call('getAllCategories').find(x => String(x.categoryId) === id && String(x.categoryName || '').trim())
    if (!c) throw new lib.CliError('category not found or unnamed: ' + id, 'PROJECT_V2_CATEGORY_INVALID')
    const projectId = projectIdFromLegacy(id)
    const existing = allEntities().find(p => p.projectId === projectId)
    if (existing) {
      if (existing.deleted) return update({ projectId, patch: { deleted: false } })
      return existing
    }
    const name = checkedName(c.categoryName)
    const linked = lib.liveTasks().filter(t => String(t.categoryId) === id)
    for (const t of linked) {
      const old = db().call('getMeta', taskProjectKey(t.taskId))
      if (old && old !== projectId) throw new lib.CliError('category task ownership conflict: '+t.taskId, 'PROJECT_V2_OWNERSHIP_CONFLICT')
    }
    const entity = { schemaVersion:1, projectId, name, color: c.categoryColor || '#7ac74f',
      legacyCategoryId:Number(id), origin:'category-explicitly-converted', status:'active',
      createdAt:Number(c.createTime)||0, updatedAt:Date.now(), deleted:false }
    writeChecked(projectKey(projectId), JSON.stringify(entity))
    for (const t of linked) if (!db().call('getMeta', taskProjectKey(t.taskId))) writeChecked(taskProjectKey(t.taskId), projectId)
    lib.audit.record({ action:'project-v2.fromCategory', targets:[{taskId:projectId, content:name}], note:'explicit category conversion, original category unchanged' })
    return { ...entity, linkedTasks: linked.length, verified:true }
  }
  function projectTasks (projectId) {
    const ids = new Set(assignments().filter(x => x.projectId === projectId).map(x => x.taskId))
    return lib.liveTasks().filter(t => ids.has(t.taskId))
  }
  return { list, audit, migrate, migrationPlan, allEntities, create, update, assign, recover, fromCategory, projectTasks }
}
