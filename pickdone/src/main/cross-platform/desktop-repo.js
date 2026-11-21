'use strict'
/**
 * Desktop repo adapter for the cross-platform bridge (Lane A wiring, 2026-11-07).
 *
 * Maps the bridge's five authoritative entities onto the EXISTING db abstraction ops
 * (db.call) — no direct SQL at the bridge boundary, no second data model. The desktop
 * db.js module is injected (already initialized by the app); tests inject the same
 * interface backed by a temp SQLite with the canonical SCHEMA DDL.
 *
 * Tombstone discipline: episodePut/sourcePut/taskSourcePut only ever write LIVE rows
 * (they force deleted=0); inbound tombstones therefore go through the matching
 * *RemoveIds op with wire-carried stamps so LWW ordering survives the hop (same doctrine
 * as the LAN sync-apply ingress, db-episode-ops.cjs).
 */

const ENTITIES = ['todos', 'categories', 'work_episodes', 'source_refs', 'task_source_links']

// todos shape boundary (G2 contract fix, 2026-11-10): the DTO layer (shared/cross-platform/
// dto.mjs) speaks the CANONICAL STORAGE shape (id/content/updatedAt/deleted/...), but the real
// desktop db.js getAll/getById/upsert ops speak the renderer VIEW-MODEL shape (taskId/
// taskContent/updateTime/delete/...). The bridge tests inject raw-row stubs, which is why the
// mismatch never surfaced there — on a live desktop a pull served todos DTOs with no title and
// updatedAt=0, and a mobile push would have been refused by upsert's taskId assert. Normalize
// at this adapter boundary, once: view model -> canonical on reads, canonical -> view model on
// writes. Unknown keys are dropped by these mappers by design — dto.mjs's carryUnknown handles
// client-private extensions at the DTO layer, not here.
function todoVmToCanonical (row) {
  const t = row
  if (!t || typeof t !== 'object') return t
  if (t.id != null && t.taskId == null) return t // already canonical (raw-row inject/test stubs)
  return {
    id: t.taskId,
    content: t.taskContent,
    description: t.taskDescribe || '',
    complete: t.complete ? 1 : 0,
    completedAt: t.completedAt || 0,
    scheduledAt: t.todoTime || 0,
    scheduledDay: t.dayStart || 0,
    remindAt: t.reminderTime || 0,
    deadlineTs: t.deadlineTs || 0,
    createdAt: t.createTime || 0,
    updatedAt: t.updateTime || 0,
    deleted: t.delete ? 1 : 0,
    deletedAt: t.deletedAt || 0,
    categoryId: t.categoryId != null ? t.categoryId : 0,
    version: t.version || 0,
    syncAuthor: t.syncAuthor || null,
    handoffTo: t.handoffTo || null,
    handoffFrom: t.handoffFrom || null,
    handoffNote: t.handoffNote || null,
    handoffAckedAt: t.handoffAckedAt || 0
  }
}

function createDesktopRepo (dbCall) {
  if (typeof dbCall !== 'function') throw new TypeError('createDesktopRepo: dbCall(op, params) required')

  return {
    entities: ENTITIES,

    get (entity, id) {
      switch (entity) {
        case 'todos':
          return todoVmToCanonical(dbCall('getById', id)) || null
        case 'categories': {
          const all = dbCall('getAllCategories', {}) || []
          return all.find(c => String(c.id) === String(id)) || null
        }
        case 'work_episodes': {
          const all = dbCall('episodeAllRows', {}) || []
          return all.find(e => String(e.id) === String(id)) || null
        }
        case 'source_refs': {
          const all = dbCall('sourceAllRows', {}) || []
          return all.find(r => String(r.id) === String(id)) || null
        }
        case 'task_source_links': {
          const all = dbCall('taskSourceAllRows', {}) || []
          return all.find(l => String(l.id) === String(id)) || null
        }
        default:
          throw new Error(`desktop-repo: unknown entity ${entity}`)
      }
    },

    put (entity, row) {
      switch (entity) {
        case 'todos':
          // Canonical row passed through: the db layer's upsert/todoToRow normalizes BOTH
          // accepted shapes (view model and canonical — see todoToRow in db-rows.js), so raw
          // row test stubs and the real db.js op take the same payload.
          return dbCall('upsert', row)
        case 'categories':
          return dbCall('upsertCategory', row)
        case 'work_episodes':
          if (row && row.deleted) {
            // inbound tombstone: stamp-preserving remove, never a live-row upsert
            return dbCall('episodeRemoveIds', [{ id: row.id, deletedAt: row.deletedAt, updatedAt: row.updatedAt }])
          }
          return dbCall('episodePut', row)
        case 'source_refs':
          if (row && row.deleted) {
            return dbCall('sourceRemoveByIds', [{ id: row.id, deletedAt: row.deletedAt, updatedAt: row.updatedAt }])
          }
          return dbCall('sourcePut', row)
        case 'task_source_links':
          if (row && row.deleted) {
            return dbCall('taskSourceRemove', [{ id: row.id, deletedAt: row.deletedAt, updatedAt: row.updatedAt }])
          }
          return dbCall('taskSourcePut', row)
        default:
          throw new Error(`desktop-repo: unknown entity ${entity}`)
      }
    },

    /**
     * Pull side: raw rows per entity (storage columns, tombstones included) — the same
     * raw-shape doctrine as lan-sync-egress; the HTTP layer maps them through dto.mjs.
     */
    allRows (entity) {
      switch (entity) {
        case 'todos':
          return (dbCall('getAll', { deleted: null }) || []).map(todoVmToCanonical)
        case 'categories':
          return dbCall('getAllCategories', {}) || []
        case 'work_episodes':
          return dbCall('episodeAllRows', {}) || []
        case 'source_refs':
          return dbCall('sourceAllRows', {}) || []
        case 'task_source_links':
          return dbCall('taskSourceAllRows', {}) || []
        default:
          throw new Error(`desktop-repo: unknown entity ${entity}`)
      }
    }
  }
}

module.exports = { createDesktopRepo, ENTITIES }
