// Matches desktop Lane A DTO contract at 85d5f3c1. No network or DB access here.
export const DTO_VERSION = 1

const taskFields = ['description', 'categoryId', 'complete', 'scheduledAt', 'scheduledDay', 'remindAt', 'deadlineTs', 'createdAt', 'updatedAt', 'deleted', 'deletedAt', 'syncAuthor', 'version']
const categoryFields = ['id', 'name', 'color', 'isFolder', 'parentId', 'deleted', 'deletedAt', 'updatedAt']
const episodeFields = ['taskId', 'startedAt', 'endedAt', 'deleted', 'deletedAt', 'updatedAt']

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