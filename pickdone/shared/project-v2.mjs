/**
 * PickDone project-v2: independent identity, explicit task membership and provenance.
 * Storage uses per-entity synced meta keys to remain compatible with existing A/B peers.
 * Never infer a project from a #tag; never manufacture a name for a damaged legacy row.
 */
export const PROJECT_V2_PREFIX = 'pd.project.v2:'
export const TASK_PROJECT_V2_PREFIX = 'pd.taskProject.v2:'
export const PROJECT_V2_SCHEMA = 1
export const projectIdFromLegacy = id => {
  if (!/^\d+$/.test(String(id)) || Number(id) <= 0) throw Error('INVALID_LEGACY_CATEGORY_ID')
  return 'prj_legacy_' + String(id)
}
export function projectKey (id) {
  if (!/^prj_[a-zA-Z0-9_-]{1,100}$/.test(String(id))) throw Error('INVALID_PROJECT_ID')
  return PROJECT_V2_PREFIX + id
}
export function taskProjectKey (taskId) {
  if (!/^tid_[\w-]+$/.test(String(taskId))) throw Error('INVALID_TASK_ID')
  return TASK_PROJECT_V2_PREFIX + taskId
}
export function createLegacyProjectRecord (c, status = 'active') {
  if (!c || !/^\d+$/.test(String(c.categoryId)) || !(String(c.categoryName || '').trim())) throw Error('LEGACY_PROJECT_UNVERIFIED')
  const name = String(c.categoryName).trim()
  if (name.length > 150) throw Error('PROJECT_NAME_TOO_LONG')
  const validStatuses = new Set(['active', 'paused', 'done', 'cancelled'])
  if (!validStatuses.has(status)) throw Error('PROJECT_STATUS_INVALID')
  return {
    schemaVersion: PROJECT_V2_SCHEMA,
    projectId: projectIdFromLegacy(c.categoryId),
    name,
    status,
    legacyCategoryId: Number(c.categoryId),
    origin: 'verified-legacy-category',
    createdAt: Number(c.createTime) || 0,
    deleted: false
  }
}
export function parseProjectRecord (value) {
  let row
  try { row = typeof value === 'string' ? JSON.parse(value) : value } catch { return null }
  if (!row || row.schemaVersion !== PROJECT_V2_SCHEMA || typeof row.name !== 'string' || !row.name.trim() ||
    !row.projectId || !/^prj_[a-zA-Z0-9_-]{1,100}$/.test(String(row.projectId))) return null
  return row
}
export function quarantinedLegacyProjects (categories, projectIds, todos) {
  const byId = new Map((categories || []).map(c => [String(c.categoryId), c]))
  return [...new Set((projectIds || []).map(String))]
    .filter(id => !byId.has(id) || !String(byId.get(id)?.categoryName || '').trim())
    .map(id => {
      const linked = (todos || []).filter(t => !t.delete && String(t.categoryId) === id)
      const category = byId.get(id)
      return {
        legacyCategoryId: id,
        state: 'name-unverified',
        taskCount: linked.length,
        unfinishedCount: linked.filter(t => !t.complete).length,
        sourceRecordExists: !!category,
        // Preserve identity only. An empty name is NOT a project name.
        name: null
      }
    })
}
