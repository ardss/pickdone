// Row <-> Lane A cross-platform DTO mapping (web client side of CROSSPLATFORM-CONTRACT-20261107).
// Mirrors desktop shared/cross-platform/dto.mjs aliases exactly:
//   todos.id <-> taskId, todos.content <-> title, work_episodes.id <-> episodeId, note <-> summary.
// Local IndexedDB rows already carry the canonical desktop column names (id/content/name/note),
// so the DTO swap is pure aliasing; unknown fields ride verbatim both ways. No transport here.

export const DTO_VERSION = 1

function pick(row, fields) {
  return Object.fromEntries(fields.filter(f => Object.hasOwn(row, f)).map(f => [f, row[f]]))
}

function carryUnknown(source, out, known) {
  for (const k of Object.keys(source)) {
    if (!known.includes(k) && !Object.hasOwn(out, k)) out[k] = source[k]
  }
}

const TASK_DTO_FIELDS = ['description', 'categoryId', 'complete', 'scheduledAt', 'scheduledDay', 'remindAt', 'deadlineTs', 'createdAt', 'updatedAt', 'deleted', 'deletedAt', 'syncAuthor', 'version']
const CATEGORY_DTO_FIELDS = ['id', 'name', 'color', 'isFolder', 'parentId', 'deleted', 'deletedAt', 'updatedAt']
const EPISODE_DTO_FIELDS = ['taskId', 'startedAt', 'endedAt', 'deleted', 'deletedAt', 'updatedAt']

function stamp(row) { return Number(row.updatedAt || row.updateTime || 0) }
function tomb(row) { return row.deleted || row.delete ? 1 : 0 }

// ---- outbound: local row -> DTO ----

export function taskToDto(row) {
  if (!row?.id) throw new TypeError('task id required')
  const dto = pick(row, TASK_DTO_FIELDS)
  dto.taskId = row.id
  dto.title = row.content
  dto.deleted = tomb(row)
  dto.updatedAt = stamp(row)
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function categoryToDto(row) {
  if (row?.id == null) throw new TypeError('category id required')
  const dto = pick(row, CATEGORY_DTO_FIELDS)
  dto.deleted = tomb(row)
  dto.updatedAt = stamp(row)
  dto.dtoVersion = DTO_VERSION
  return dto
}

export function episodeToDto(row) {
  if (!row?.id) throw new TypeError('episode id required')
  const dto = pick(row, EPISODE_DTO_FIELDS)
  dto.episodeId = row.id
  dto.summary = row.note
  dto.deleted = tomb(row)
  dto.updatedAt = stamp(row)
  dto.dtoVersion = DTO_VERSION
  return dto
}

export const ENTITY_OUT = { todos: taskToDto, categories: categoryToDto, work_episodes: episodeToDto }

// ---- inbound: DTO -> local row (canonical columns restored, unknowns preserved) ----

export function taskFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  const id = dto.taskId != null ? dto.taskId : dto.id
  if (id == null || id === '') throw new TypeError('taskId/id required')
  const row = pick(dto, TASK_DTO_FIELDS)
  const content = Object.hasOwn(dto, 'title') ? dto.title : dto.content
  if (typeof content !== 'string') throw new TypeError('task title/content required')
  row.id = String(id)
  row.content = content
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...TASK_DTO_FIELDS, 'taskId', 'title', 'dtoVersion'])
  return row
}

export function categoryFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  if (dto.id == null || dto.id === '') throw new TypeError('category id required')
  if (typeof dto.name !== 'string') throw new TypeError('category name required')
  const row = pick(dto, CATEGORY_DTO_FIELDS)
  row.id = Number(dto.id)
  if (!Number.isInteger(row.id)) throw new TypeError('category id must be an integer')
  // isProject is desktop app metadata, not a categories column — the web projects store IS
  // the category store, so the flag does not need to persist here.
  delete row.isProject
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...CATEGORY_DTO_FIELDS, 'isProject', 'dtoVersion'])
  return row
}

export function episodeFromDto(dto) {
  if (!dto || typeof dto !== 'object') throw new TypeError('dto object required')
  const id = dto.episodeId != null ? dto.episodeId : dto.id
  if (id == null || id === '') throw new TypeError('episodeId/id required')
  const row = pick(dto, EPISODE_DTO_FIELDS)
  const note = Object.hasOwn(dto, 'summary') ? dto.summary : dto.note
  const taskId = Object.hasOwn(dto, 'taskId') ? dto.taskId : dto.task
  if (typeof taskId !== 'string' || !taskId) throw new TypeError('episode taskId required')
  row.id = String(id)
  row.taskId = taskId
  row.note = typeof note === 'string' ? note : ''
  row.deleted = dto.deleted ? 1 : 0
  row.deletedAt = Number(dto.deletedAt || 0)
  row.updatedAt = Number(dto.updatedAt || 0)
  carryUnknown(dto, row, [...EPISODE_DTO_FIELDS, 'episodeId', 'summary', 'dtoVersion'])
  return row
}

export const ENTITY_IN = { todos: taskFromDto, categories: categoryFromDto, work_episodes: episodeFromDto }
