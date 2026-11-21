/**
 * Project V2 - the only authoritative project identity and task membership in UI.
 * One synced meta record per project/assignment. Categories and #tags are independent.
 */
import { PROJECT_V2_PREFIX, TASK_PROJECT_V2_PREFIX, projectKey, taskProjectKey, parseProjectRecord } from '../../../shared/project-v2.mjs'
import { commit as writeCommand } from '../utils/commandBus.js'

const active = p => p && p.deleted !== true
const nameKey = s => String(s || '').trim().normalize('NFKC').toLocaleLowerCase()
const permittedStatus = new Set(['active', 'paused', 'done', 'cancelled'])
const api = () => {
  if (!window.todoAPI || !window.todoAPI.dbCall || !window.todoAPI.getMetaMany) throw Error('PROJECT_V2_STORAGE_UNAVAILABLE')
  return window.todoAPI
}
const makeId = () => {
  if (!globalThis.crypto || !crypto.randomUUID) throw Error('PROJECT_V2_SECURE_ID_UNAVAILABLE')
  return 'prj_' + crypto.randomUUID().replace(/-/g, '')
}
function uniqueName (projects, name, exclude) {
  const clean = String(name || '').trim()
  if (!clean || clean.length > 150) throw Error('PROJECT_V2_NAME_INVALID')
  if (projects.some(p => active(p) && p.projectId !== exclude && nameKey(p.name) === nameKey(clean))) throw Error('PROJECT_V2_DUPLICATE_NAME')
  return clean
}
function findProject (state, id) {
  const p = state.projects.find(p => p.projectId === id)
  if (!p || !active(p)) throw Error('PROJECT_V2_NOT_FOUND')
  return p
}
async function verifiedPut (key, value) {
  await writeCommand('meta', 'put', [key, value])
  const actual = await api().dbCall('getMeta', key)
  if (actual !== value) throw Error('PROJECT_V2_WRITE_NOT_VERIFIED:' + key)
}
export default {
  namespaced: true,
  state: () => ({ projects: [], taskProjects: {}, ready: false, error: null }),
  getters: {
    all: s => s.projects.filter(active),
    byId: s => id => s.projects.find(p => p.projectId === id && active(p)) || null,
    forTask: s => taskId => s.taskProjects[String(taskId)] || null,
    tasksOf: s => (projectId, todoList) => (todoList || []).filter(t => !t.delete && s.taskProjects[t.taskId] === projectId)
  },
  mutations: {
    replace (s, { projects, taskProjects }) {
      s.projects = projects
      s.taskProjects = taskProjects
      s.ready = true
      s.error = null
    },
    failed (s, reason) { s.error = String(reason) }
  },
  actions: {
    async refresh ({ commit }) {
      try {
        const a = api()
        const keys = await a.dbCall('projectV2Keys')
        if (!Array.isArray(keys)) throw Error('PROJECT_V2_KEYS_UNAVAILABLE')
        const rows = keys.length ? await a.getMetaMany(keys) : []
        if (!Array.isArray(rows)) throw Error('PROJECT_V2_ROWS_UNAVAILABLE')
        const projects = []
        const taskProjects = {}
        for (const row of rows) {
          const key = String((row && row.key) || '')
          if (row.value == null) continue
          if (key.startsWith(PROJECT_V2_PREFIX)) {
            const p = parseProjectRecord(row.value)
            if (p && projectKey(p.projectId) === key) projects.push(p)
          } else if (key.startsWith(TASK_PROJECT_V2_PREFIX)) {
            taskProjects[key.slice(TASK_PROJECT_V2_PREFIX.length)] = String(row.value)
          }
        }
        commit('replace', { projects, taskProjects })
        return { projects: projects.length, taskLinks: Object.keys(taskProjects).length }
      } catch (e) {
        commit('failed', e.message)
        throw e
      }
    },
    async create ({ state, dispatch }, { name, color = '#7ac74f' }) {
      const valid = uniqueName(state.projects, name)
      const projectId = makeId()
      const entity = { schemaVersion: 1, projectId, name: valid, status: 'active',
        color: String(color), createdAt: Date.now(), updatedAt: Date.now(), deleted: false, origin: 'native-project-v2' }
      await verifiedPut(projectKey(projectId), JSON.stringify(entity))
      await dispatch('refresh')
      return entity
    },
    async update ({ state, dispatch }, { projectId, patch }) {
      if (!patch || typeof patch !== 'object') throw Error('PROJECT_V2_PATCH_REQUIRED')
      const old = state.projects.find(p => p.projectId === projectId)
      if (!old) throw Error('PROJECT_V2_NOT_FOUND')
      if (old.deleted && patch.deleted !== false) throw Error('PROJECT_V2_ARCHIVED_RESTORE_REQUIRED')
      const allowed = new Set(['name', 'status', 'color', 'deleted', 'deadline'])
      for (const k of Object.keys(patch)) if (!allowed.has(k)) throw Error('PROJECT_V2_PATCH_NOT_ALLOWED:' + k)
      const next = { ...old, ...patch, projectId: old.projectId, legacyCategoryId: old.legacyCategoryId, updatedAt: Date.now() }
      if (patch.name !== undefined || (old.deleted && patch.deleted === false)) next.name = uniqueName(state.projects, next.name, projectId)
      if (!permittedStatus.has(next.status)) throw Error('PROJECT_V2_STATUS_INVALID')
      if (typeof next.color !== 'undefined' && (typeof next.color !== 'string' || next.color.length > 30)) throw Error('PROJECT_V2_COLOR_INVALID')
      if (typeof next.deleted !== 'boolean') throw Error('PROJECT_V2_DELETED_INVALID')
      if (next.deadline != null && (!Number.isSafeInteger(next.deadline) || next.deadline < 0)) throw Error('PROJECT_V2_DEADLINE_INVALID')
      await verifiedPut(projectKey(projectId), JSON.stringify(next))
      await dispatch('refresh')
      return next
    },
    async fromCategory ({ state, rootState, dispatch }, { categoryId }) {
      const id = Number(categoryId)
      const category = rootState.category.list.find(c => Number(c.categoryId) === id && !c.delete)
      if (!category || !String(category.categoryName || '').trim()) throw Error('PROJECT_V2_CATEGORY_INVALID')
      const projectId = 'prj_legacy_' + id
      const existing = state.projects.find(p => p.projectId === projectId)
      if (existing) {
        if (existing.deleted) return dispatch('update', { projectId, patch: { deleted: false } })
        return existing
      }
      const name = uniqueName(state.projects, category.categoryName)
      const tasks = (rootState.todo.todoList || []).filter(t => t && !t.delete && Number(t.categoryId) === id)
      for (const task of tasks) {
        if (state.taskProjects[task.taskId] && state.taskProjects[task.taskId] !== projectId) {
          throw Error('PROJECT_V2_CATEGORY_TASK_CONFLICT:' + task.taskId)
        }
      }
      const entity = { schemaVersion: 1, projectId, name, color: category.categoryColor || '#7ac74f',
        status: 'active', legacyCategoryId: id, origin: 'category-explicitly-converted',
        createdAt: Number(category.createTime) || 0, updatedAt: Date.now(), deleted: false }
      await verifiedPut(projectKey(projectId), JSON.stringify(entity))
      for (const task of tasks) {
        if (state.taskProjects[task.taskId] !== projectId) await verifiedPut(taskProjectKey(task.taskId), projectId)
      }
      await dispatch('refresh')
      return { ...entity, linkedTasks: tasks.length }
    },
    async recoverLegacy ({ state, rootState, dispatch }, { legacyCategoryId, name }) {
      const raw = String(legacyCategoryId || '')
      if (!/^\d+$/.test(raw) || !rootState.category.projectIds.map(String).includes(raw)) throw Error('PROJECT_V2_LEGACY_ID_INVALID')
      const projectId = 'prj_legacy_' + raw
      const valid = uniqueName(state.projects, name, projectId)
      const old = state.projects.find(p => p.projectId === projectId)
      if (old && (old.name !== valid || old.legacyCategoryId !== Number(raw))) throw Error('PROJECT_V2_RECOVERY_CONFLICT')
      const members = (rootState.todo.todoList || []).filter(t => t && !t.delete && String(t.categoryId) === raw)
      // Full preflight before the first write. No automatic relabeling of raw task/category rows.
      for (const task of members) {
        const other = state.taskProjects[task.taskId]
        if (other && other !== projectId) throw Error('PROJECT_V2_RECOVERY_OWNERSHIP_CONFLICT:' + task.taskId)
      }
      const record = old || { schemaVersion: 1, projectId, name: valid, status: 'active',
        legacyCategoryId: Number(raw), origin: 'manually-confirmed-legacy-recovery',
        createdAt: 0, updatedAt: Date.now(), deleted: false }
      if (!old) await verifiedPut(projectKey(projectId), JSON.stringify(record))
      for (const task of members) {
        if (state.taskProjects[task.taskId] !== projectId) await verifiedPut(taskProjectKey(task.taskId), projectId)
      }
      await dispatch('refresh')
      return { projectId, name: valid, linkedTasks: members.length }
    },
    async assign ({ state, dispatch, rootState }, { taskId, projectId }) {
      const id = String(taskId || '')
      if (!rootState.todo.todoList.some(t => t.taskId === id && !t.delete)) throw Error('PROJECT_V2_TASK_MISSING')
      if (projectId) findProject(state, projectId)
      const key = taskProjectKey(id)
      if (projectId) {
        await verifiedPut(key, projectId)
      } else {
        await writeCommand('meta', 'delete', key)
        const after = await api().dbCall('getMeta', key)
        if (after != null) throw Error('PROJECT_V2_UNASSIGN_NOT_VERIFIED')
      }
      await dispatch('refresh')
    }
  }
}
