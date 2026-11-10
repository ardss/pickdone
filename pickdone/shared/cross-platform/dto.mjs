/* eslint-env node */
/**
 * Cross-platform unified DTO v0 (Lane A, 2026-11-07).
 *
 * This is a MAPPING layer over the authoritative desktop model (todos / categories /
 * work_episodes / source_refs / task_source_links at db-schema.js, HEAD ad76628a) —
 * NOT a second data model. Every DTO field maps 1:1 to an existing persisted column
 * with an explicit alias; unknown fields on inbound payloads are preserved verbatim
 * so a round trip never loses client-private extensions.
 *
 * Aliases (CROSSPLATFORM-CONTRACT-20261107.md):
 *   todos.id            <-> task.taskId        (UI alias only; storage key stays id)
 *   todos.content       <-> task.title         (never persist a second 'title')
 *   work_episodes.id    <-> episode.episodeId
 *   work_episodes.note  <-> episode.summary
 * Timestamps are ms since epoch. Tombstone metadata (deleted/deletedAt/updatedAt) is
 * mandatory in every mapping — never silently dropped.
 */

export const DTO_VERSION = 1

export const TASK_DTO_FIELDS = [
  'id', 'content', 'description', 'categoryId', 'complete',
  'scheduledAt', 'scheduledDay', 'remindAt', 'deadlineTs',
  'createdAt', 'updatedAt', 'deleted', 'deletedAt', 'syncAuthor', 'version'
]

export const CATEGORY_DTO_FIELDS = [
  'id', 'name', 'color', 'isFolder', 'parentId', 'deleted', 'deletedAt', 'updatedAt'
]

export const EPISODE_DTO_FIELDS = [
  'id', 'taskId', 'startedAt', 'endedAt', 'note', 'deleted', 'deletedAt', 'updatedAt'
]

export const SOURCE_REF_DTO_FIELDS = [
  'id', 'providerId', 'externalId', 'title', 'deleted', 'deletedAt', 'updatedAt'
]

export const SOURCE_LINK_DTO_FIELDS = [
  'id', 'taskId', 'sourceRefId', 'deleted', 'deletedAt', 'updatedAt'
]

/** Keep only the known persisted columns present on `row`. */
function pickKnown (row, fields) {
  const out = {}
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(row, f)) out[f] = row[f]
  }
  return out
}

/** Copy unknown keys from `dto` verbatim onto `out` (private extensions survive round trips). */
function carryUnknown (dto, out, fields) {
  for (const k of Object.keys(dto)) {
    if (!fields.includes(k) && !Object.prototype.hasOwnProperty.call(out, k)) out[k] = dto[k]
  }
}

/** Row -> outbound DTO. Tombstones always present; drop device-private fields. */
export function taskToDto (row) {
  if (!row || typeof row !== 'object') throw new TypeError('taskToDto: row object required')
  const dto = pickKnown(row, TASK_DTO_FIELDS)
  dto.taskId = dto.id
  dto.title = dto.content != null ? row.content : undefined
  delete dto.id
  delete dto.content
  dto.deleted = row.deleted ? 1 : 0
  dto.updatedAt = row.updatedAt || 0
  dto.dtoVersion = DTO_VERSION
  return dto
}

/** Inbound DTO -> canonical row shape (id/content keys restored). Unknown fields preserved. */
export function taskFromDto (dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('taskFromDto: dto object required')
  const id = dto.taskId != null ? dto.taskId : dto.id
  if (id == null || id === '') throw new TypeError('taskFromDto: taskId/id required')
  const row = pickKnown(dto, TASK_DTO_FIELDS)
  delete row.id
  row.id = String(id)
  if (Object.prototype.hasOwnProperty.call(dto, 'title')) row.content = dto.title
  else if (Object.prototype.hasOwnProperty.call(dto, 'content')) row.content = dto.content
  if (!Object.prototype.hasOwnProperty.call(row, 'deleted')) row.deleted = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'deletedAt')) row.deletedAt = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'updatedAt')) row.updatedAt = 0
  carryUnknown(dto, row, [...TASK_DTO_FIELDS, 'taskId', 'title', 'dtoVersion'])
  return row
}

export function categoryToDto (row) {
  if (!row || typeof row !== 'object') throw new TypeError('categoryToDto: row object required')
  const dto = pickKnown(row, CATEGORY_DTO_FIELDS)
  dto.isProject = 1 // projects are categories flagged via app metadata (contract §Identity)
  dto.deleted = row.deleted ? 1 : 0
  dto.updatedAt = row.updatedAt || 0
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function categoryFromDto (dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('categoryFromDto: dto object required')
  if (dto.id == null || dto.id === '') throw new TypeError('categoryFromDto: id required')
  const row = pickKnown(dto, CATEGORY_DTO_FIELDS)
  row.id = Number(dto.id)
  if (!Number.isFinite(row.id)) throw new TypeError('categoryFromDto: id must be an integer key')
  if (!Object.prototype.hasOwnProperty.call(row, 'deleted')) row.deleted = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'deletedAt')) row.deletedAt = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'updatedAt')) row.updatedAt = 0
  // isProject is a view flag, not a persisted categories column — strip before apply.
  delete row.isProject
  carryUnknown(dto, row, [...CATEGORY_DTO_FIELDS, 'isProject', 'dtoVersion'])
  return row
}

export function episodeToDto (row) {
  if (!row || typeof row !== 'object') throw new TypeError('episodeToDto: row object required')
  const dto = pickKnown(row, EPISODE_DTO_FIELDS)
  dto.episodeId = dto.id
  dto.summary = dto.note
  delete dto.id
  delete dto.note
  dto.deleted = row.deleted ? 1 : 0
  dto.updatedAt = row.updatedAt || 0
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function episodeFromDto (dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('episodeFromDto: dto object required')
  const id = dto.episodeId != null ? dto.episodeId : dto.id
  if (id == null || id === '') throw new TypeError('episodeFromDto: episodeId/id required')
  const row = pickKnown(dto, EPISODE_DTO_FIELDS)
  delete row.id
  row.id = String(id)
  if (Object.prototype.hasOwnProperty.call(dto, 'summary')) row.note = dto.summary
  else if (Object.prototype.hasOwnProperty.call(dto, 'note')) row.note = dto.note
  if (!Object.prototype.hasOwnProperty.call(row, 'deleted')) row.deleted = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'deletedAt')) row.deletedAt = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'updatedAt')) row.updatedAt = 0
  carryUnknown(dto, row, [...EPISODE_DTO_FIELDS, 'episodeId', 'summary', 'dtoVersion'])
  return row
}

export function sourceRefToDto (row) {
  if (!row || typeof row !== 'object') throw new TypeError('sourceRefToDto: row object required')
  const dto = pickKnown(row, SOURCE_REF_DTO_FIELDS)
  dto.deleted = row.deleted ? 1 : 0
  dto.updatedAt = row.updatedAt || 0
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function sourceRefFromDto (dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('sourceRefFromDto: dto object required')
  if (dto.id == null || dto.id === '') throw new TypeError('sourceRefFromDto: id required')
  if (dto.providerId == null || dto.externalId == null) {
    throw new TypeError('sourceRefFromDto: providerId and externalId required (unique pair)')
  }
  const row = pickKnown(dto, SOURCE_REF_DTO_FIELDS)
  row.id = String(dto.id)
  if (!Object.prototype.hasOwnProperty.call(row, 'deleted')) row.deleted = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'deletedAt')) row.deletedAt = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'updatedAt')) row.updatedAt = 0
  carryUnknown(dto, row, [...SOURCE_REF_DTO_FIELDS, 'dtoVersion'])
  return row
}

export function sourceLinkToDto (row) {
  if (!row || typeof row !== 'object') throw new TypeError('sourceLinkToDto: row object required')
  const dto = pickKnown(row, SOURCE_LINK_DTO_FIELDS)
  dto.deleted = row.deleted ? 1 : 0
  dto.updatedAt = row.updatedAt || 0
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function sourceLinkFromDto (dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('sourceLinkFromDto: dto object required')
  if (dto.id == null || dto.id === '') throw new TypeError('sourceLinkFromDto: id required')
  const row = pickKnown(dto, SOURCE_LINK_DTO_FIELDS)
  row.id = String(dto.id)
  if (!Object.prototype.hasOwnProperty.call(row, 'deleted')) row.deleted = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'deletedAt')) row.deletedAt = 0
  if (!Object.prototype.hasOwnProperty.call(row, 'updatedAt')) row.updatedAt = 0
  carryUnknown(dto, row, [...SOURCE_LINK_DTO_FIELDS, 'dtoVersion'])
  return row
}
