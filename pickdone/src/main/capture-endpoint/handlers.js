/**
 * capture-endpoint/handlers — the capture ingest logic (S4 browser-extension track, P0).
 *
 * Pure, dependency-injected: every write goes through the REAL command bus, every dedupe read
 * through an injected getMeta. One capture = three bus commands:
 *   1. bus.commit('todo', 'put', todo) — the INBOX task: no category (categoryId 0), no
 *      scheduled day (todoTime 0 / dayStart 0). The bus stamps updateTime itself.
 *   2. bus.commit('source', 'put', ref) + bus.commit('tasksource', 'put', link) — the S1
 *      internal rows (source_refs / task_source_links): the SourceRef carries the captured
 *      page (providerId 'capture', externalId = the source URL when present, else the
 *      fingerprint, else the task id) and the TaskSourceLink ties it to the inbox task.
 *   3. bus.commit('capture', 'ingest', pairs) — THIS slice's internal manifest row
 *      (op setMetaMany): the capture bookkeeping pair 'taskSourceLink:<fingerprint>' →
 *      JSON {taskId, sourceRefId}. That row IS the dedupe index — a re-sent fingerprint
 *      resolves to the original task without writing anything.
 *
 * Validation is fail-closed and happens BEFORE any bus commit — a rejected payload writes
 * nothing (asserted by the red→green suite).
 */

const crypto = require('crypto')

const META_TASK_LINK_PREFIX = 'taskSourceLink:'
const CAPTURE_PROVIDER_ID = 'capture'

const MAX_CONTENT = 5000 // same cap as the editor/db column (sanitizeText default)
const MAX_FINGERPRINT = 256
const MAX_TITLE = 500
const MAX_URL = 2048
// printable identifier chars — fingerprints are client-generated correlation ids, not free text
const FINGERPRINT_RE = /^[A-Za-z0-9._:\-/@+#]{1,256}$/

function invalid (error) { return { ok: false, status: 400, error } }

/**
 * Ingest one captured item.
 * @param {object} ctx
 * @param {object} ctx.bus  command bus ({ commit(entity, verb, payload) })
 * @param {(key: string) => string|null} ctx.getMeta  meta read (dedupe index lookup)
 * @param {object} ctx.payload  { content, dedupeFingerprint?, sourceUrl?, sourceTitle? }
 * @returns {{ok:true,status:201,taskId:string} | {ok:true,status:200,duplicate:true,taskId:string}
 *           | {ok:false,status:400,error:string}}
 */
function ingestCapture ({ bus, getMeta, payload }) {
  if (!payload || typeof payload !== 'object') return invalid('payload must be a JSON object')

  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (!content) return invalid('content is required')
  if (content.length > MAX_CONTENT) return invalid('content too long (max ' + MAX_CONTENT + ')')

  const fp = typeof payload.dedupeFingerprint === 'string' ? payload.dedupeFingerprint.trim() : ''
  if (fp && !FINGERPRINT_RE.test(fp)) {
    return invalid('dedupeFingerprint must be 1-' + MAX_FINGERPRINT + ' printable identifier chars')
  }

  let sourceUrl = null
  if (payload.sourceUrl != null && payload.sourceUrl !== '') {
    if (typeof payload.sourceUrl !== 'string' || payload.sourceUrl.length > MAX_URL) {
      return invalid('sourceUrl too long (max ' + MAX_URL + ')')
    }
    try {
      const u = new URL(payload.sourceUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return invalid('sourceUrl must be http(s)')
      sourceUrl = payload.sourceUrl
    } catch {
      return invalid('sourceUrl is not a valid URL')
    }
  }

  let sourceTitle = null
  if (payload.sourceTitle != null && payload.sourceTitle !== '') {
    if (typeof payload.sourceTitle !== 'string' || payload.sourceTitle.length > MAX_TITLE) {
      return invalid('sourceTitle too long (max ' + MAX_TITLE + ')')
    }
    sourceTitle = payload.sourceTitle
  }

  // dedupe: the capture bookkeeping meta row IS the fingerprint index
  if (fp) {
    const existing = getMeta(META_TASK_LINK_PREFIX + fp)
    if (existing) {
      try {
        const linked = JSON.parse(existing)
        if (linked && linked.taskId) return { ok: true, status: 200, duplicate: true, taskId: linked.taskId }
      } catch { /* corrupt row: fall through and re-ingest */ }
    }
  }

  const now = Date.now()
  // deterministic id for fingerprinted captures (idempotent even against a lost link row);
  // random suffix for fingerprint-less captures (each capture is its own task)
  const idSeed = fp || (content + '\n' + now + ':' + crypto.randomBytes(8).toString('hex'))
  const taskId = 'cap-' + crypto.createHash('sha256').update(idSeed, 'utf8').digest('hex').slice(0, 16)

  // 1. the inbox task — through the existing renderer-reachable todo.put manifest row
  bus.commit('todo', 'put', {
    taskId,
    taskContent: content,
    userId: null,
    categoryId: 0, // inbox mode: no category
    todoTime: 0, // inbox mode: unscheduled
    dayStart: 0,
    createTime: now,
    status: 'add'
  })

  // 2. SourceRef + TaskSourceLink — through the S1 internal manifest rows (source_refs /
  //    task_source_links). Both commits return their minted row ids.
  const externalId = sourceUrl || (fp ? 'fp:' + fp : 'capture:' + taskId)
  const sourceRefId = bus.commit('source', 'put', {
    providerId: CAPTURE_PROVIDER_ID,
    externalId,
    title: sourceTitle
  })
  bus.commit('tasksource', 'put', { taskId, sourceRefId: String(sourceRefId) })

  // 3. capture bookkeeping (dedupe index) — through THIS slice's capture.ingest internal row
  if (fp) {
    bus.commit('capture', 'ingest', [[META_TASK_LINK_PREFIX + fp, JSON.stringify({ taskId, sourceRefId: String(sourceRefId) })]])
  }

  return { ok: true, status: 201, taskId }
}

module.exports = { ingestCapture, META_TASK_LINK_PREFIX, CAPTURE_PROVIDER_ID }
