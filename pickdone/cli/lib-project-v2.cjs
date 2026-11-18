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
  quarantinedLegacyProjects
} = require('../shared/project-v2.mjs')

module.exports = function makeProjectV2Api ({ lib }) {
  const db = () => lib.open()
  function liveEntities () {
    return (db().call('listMetaKeys') || [])
      .filter(k => String(k).startsWith(PROJECT_V2_PREFIX))
      .map(k => ({ key: k, entity: parseProjectRecord(db().call('getMeta', k)) }))
      .filter(x => x.entity && projectKey(x.entity.projectId) === x.key)
      .map(x => x.entity)
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
    const counts = new Map()
    const liveIdSet = new Set(tasks.map(t => t.taskId))
    for (const x of assignments()) {
      if (!liveIdSet.has(x.taskId)) continue
      counts.set(x.projectId, (counts.get(x.projectId) || 0) + 1)
    }
    return liveEntities().map(p => ({ ...p, assignedTaskCount: counts.get(p.projectId) || 0 }))
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
      if (old && (!parsed || parsed.name !== entity.name || parsed.legacyCategoryId !== entity.legacyCategoryId)) {
        throw new lib.CliError('v2 entity already differs: ' + key, 'PROJECT_V2_CONFLICT')
      }
      entities.push({ entity, key, old })
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
  return { list, audit, migrate, migrationPlan }
}
