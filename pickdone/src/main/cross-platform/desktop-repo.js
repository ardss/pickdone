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

function createDesktopRepo (dbCall) {
  if (typeof dbCall !== 'function') throw new TypeError('createDesktopRepo: dbCall(op, params) required')

  return {
    entities: ENTITIES,

    get (entity, id) {
      switch (entity) {
        case 'todos':
          return dbCall('getById', id) || null
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
          return dbCall('getAll', { deleted: null }) || []
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
