// Matches desktop Lane A DTO contract at 85d5f3c1. No network or DB access here.
export const DTO_VERSION = 1

const taskFields = ['description', 'categoryId', 'complete', 'scheduledAt', 'scheduledDay', 'remindAt', 'deadlineTs', 'createdAt', 'updatedAt', 'deleted', 'deletedAt', 'syncAuthor', 'version', 'handoffTo', 'handoffFrom', 'handoffNote', 'handoffAckedAt']
const categoryFields = ['id', 'name', 'color', 'isFolder', 'parentId', 'deleted', 'deletedAt', 'updatedAt']
const episodeFields = ['taskId', 'startedAt', 'endedAt', 'actorType', 'role', 'deleted', 'deletedAt', 'updatedAt']

function pick(row, fields) {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]))
}

function base(row, fields) {
  if (!row || typeof row !== 'object') throw new TypeError('row object required')
  return { ...pick(row, fields), deleted: row.deleted || row.delete ? 1 : 0, updatedAt: Number(row.updatedAt || row.updateTime || 0), dtoVersion: DTO_VERSION }
}

export function taskToDto(row) {
  if (!row?.id) throw new TypeError('task id required')
  return { ...base(row, taskFields), taskId: row.id, title: row.content }
}

export function categoryToDto(row) {
  if (row?.id == null) throw new TypeError('category id required')
  return { ...base(row, categoryFields), isProject: 1 }
}

export function episodeToDto(row) {
  if (!row?.id) throw new TypeError('episode id required')
  return { ...base(row, episodeFields), episodeId: row.id, summary: row.note }
}

export const VERDICTS = Object.freeze({
  APPLIED: 'applied',
  IDEMPOTENT_SKIP: 'idempotent_skip',
  STALE_SKIP: 'stale_skip',
  CONFLICT_TOMBSTONE_WINS: 'conflict_tombstone_wins',
  CONFLICT_EDIT_WINS: 'conflict_edit_wins',
  REJECTED: 'rejected'
})

// Desktop dto-service resolves by updatedAt. A deletion/edit collision must be surfaced.
export function inboundVerdict(local, incoming) {
  if (!incoming || !Number.isFinite(Number(incoming.updatedAt))) throw new TypeError('inbound updatedAt required')
  if (!local) return VERDICTS.APPLIED
  const localStamp = Number(local.updatedAt || local.updateTime || 0)
  const inboundStamp = Number(incoming.updatedAt)
  if (localStamp === inboundStamp && Boolean(local.deleted || local.delete) === Boolean(incoming.deleted)) return VERDICTS.IDEMPOTENT_SKIP
  if (localStamp > inboundStamp) return VERDICTS.STALE_SKIP
  if (!Boolean(local.deleted || local.delete) && Boolean(incoming.deleted)) return VERDICTS.CONFLICT_TOMBSTONE_WINS
  if (Boolean(local.deleted || local.delete) && !Boolean(incoming.deleted)) return VERDICTS.CONFLICT_EDIT_WINS
  return VERDICTS.APPLIED
}
// ---- inbound: DTO -> canonical row (aliases restored; unknown fields preserved verbatim) ----

function carryUnknown(source, out, known) {
  for (const k of Object.keys(source)) {
    if (!known.includes(k) && !Object.hasOwn(out, k)) out[k] = source[k]
  }
}

export function taskFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  const id = dto.taskId != null ? dto.taskId : dto.id
  if (id == null || id === '') throw new TypeError('taskId/id required')
  const row = pick(dto, taskFields)
  const content = Object.hasOwn(dto, 'title') ? dto.title : dto.content
  if (typeof content !== 'string') throw new TypeError('task title/content required')
  row.id = String(id)
  row.content = content
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...taskFields, 'taskId', 'title', 'dtoVersion'])
  return row
}

export function categoryFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  if (dto.id == null || dto.id === '') throw new TypeError('category id required')
  if (typeof dto.name !== 'string') throw new TypeError('category name required')
  const row = pick(dto, categoryFields)
  row.id = Number(dto.id)
  if (!Number.isInteger(row.id)) throw new TypeError('category id must be an integer key')
  delete row.isProject // desktop view flag, not a categories column
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...categoryFields, 'isProject', 'dtoVersion'])
  return row
}

export function episodeFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  const id = dto.episodeId != null ? dto.episodeId : dto.id
  if (id == null || id === '') throw new TypeError('episodeId/id required')
  const row = pick(dto, episodeFields)
  const note = Object.hasOwn(dto, 'summary') ? dto.summary : dto.note
  if (typeof dto.taskId !== 'string' || !dto.taskId) throw new TypeError('episode taskId required')
  row.id = String(id)
  row.taskId = dto.taskId
  row.note = typeof note === 'string' ? note : ''
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...episodeFields, 'episodeId', 'summary', 'dtoVersion'])
  return row
}

export const ENTITY_ENCODERS = Object.freeze({ todos: taskToDto, categories: categoryToDto, work_episodes: episodeToDto })
export const ENTITY_DECODERS = Object.freeze({ todos: taskFromDto, categories: categoryFromDto, work_episodes: episodeFromDto })
export const ENTITIES = Object.freeze(['todos', 'categories', 'work_episodes'])
