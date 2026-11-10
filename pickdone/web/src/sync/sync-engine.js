// Pure sync engine — pull merge + push planning against the desktop bridge contract.
// Merge verdicts mirror desktop shared/cross-platform/dto-service.mjs exactly (same names,
// same semantics): idempotent_skip / stale_skip / tombstone-vs-edit conflicts are surfaced,
// never silently destroyed. No transport, no IndexedDB here — rows come in as plain objects.

import { ENTITY_OUT, ENTITY_IN } from './dto-mapping.js'

export const VERDICTS = Object.freeze({
  APPLIED: 'applied',
  IDEMPOTENT_SKIP: 'idempotent_skip',
  STALE_SKIP: 'stale_skip',
  CONFLICT_TOMBSTONE_WINS: 'conflict_tombstone_wins',
  CONFLICT_EDIT_WINS: 'conflict_edit_wins',
  REJECTED: 'rejected'
})

function stamp(row) { return Number(row.updatedAt || row.updateTime || 0) }
function tomb(row) { return Boolean(row.deleted || row.delete) }

/** Desktop dto-service verdict for one inbound row against a local row (may be null). */
export function inboundVerdict(local, incoming) {
  if (!incoming || incoming.id == null || incoming.id === '') return VERDICTS.REJECTED
  const localStamp = local ? stamp(local) : 0
  const inStamp = stamp(incoming)
  if (local && localStamp === inStamp && tomb(local) === tomb(incoming)) return VERDICTS.IDEMPOTENT_SKIP
  if (local && localStamp > inStamp) return VERDICTS.STALE_SKIP
  if (local && !tomb(local) && tomb(incoming)) return VERDICTS.CONFLICT_TOMBSTONE_WINS
  if (local && tomb(local) && !tomb(incoming)) return VERDICTS.CONFLICT_EDIT_WINS
  return VERDICTS.APPLIED
}

/**
 * Merge a pulled desktop snapshot into local rows (per entity collection).
 * Returns {changes: [{store, row}], conflicts: [{store, id, verdict, local, incoming}],
 *          skipped: n} — the caller persists `changes` and refreshes; nothing is mutated here.
 * Entities map store names: todos->tasks, categories->projects, work_episodes->episodes.
 */
export const ENTITY_TO_STORE = { todos: 'tasks', categories: 'projects', work_episodes: 'episodes' }

export function mergePull(localByStore, entities, { decode = ENTITY_IN } = {}) {
  const changes = []
  const conflicts = []
  let skipped = 0
  for (const [entity, dtos] of Object.entries(entities || {})) {
    const store = ENTITY_TO_STORE[entity]
    const decodeRow = decode[entity]
    if (!store || typeof decodeRow !== 'function') continue // desktop may add entities later
    const localRows = localByStore[store] || []
    const byId = new Map(localRows.map(r => [String(r.id), r]))
    for (const dto of dtos || []) {
      let incoming
      try { incoming = decodeRow(dto) } catch { skipped += 1; continue }
      const local = byId.get(String(incoming.id))
      const verdict = inboundVerdict(local, incoming)
      if (verdict === VERDICTS.APPLIED || verdict === VERDICTS.CONFLICT_TOMBSTONE_WINS || verdict === VERDICTS.CONFLICT_EDIT_WINS) {
        changes.push({ store, row: incoming })
        if (verdict !== VERDICTS.APPLIED) conflicts.push({ store, id: incoming.id, verdict, local, incoming })
      } else {
        skipped += 1
      }
    }
  }
  return { changes, conflicts, skipped }
}

/**
 * Plan outbound ops from local rows: EVERY row is pushed (desktop dto-service is
 * stale-guarded + idempotent, so full snapshots are safe and tombstones never lag).
 * Chunks to the wire caps: <=500 rows per op, <=500 ops per push.
 * Returns {ops} or {ops: []} when there is nothing to send.
 */
export function planPush(localByStore, { encode = ENTITY_OUT, maxRowsPerOp = 500, maxOpsPerPush = 500 } = {}) {
  const STORE_TO_ENTITY = { tasks: 'todos', projects: 'categories', episodes: 'work_episodes' }
  const ops = []
  for (const [store, entity] of Object.entries(STORE_TO_ENTITY)) {
    const encodeRow = encode[entity]
    const rows = localByStore[store] || []
    for (let i = 0; i < rows.length; i += maxRowsPerOp) {
      const chunk = []
      for (const row of rows.slice(i, i + maxRowsPerOp)) {
        try { chunk.push(encodeRow(row)) } catch { /* a poison local row never blocks the batch */ }
      }
      if (chunk.length) ops.push({ entity, rows: chunk })
    }
  }
  return { ops: ops.slice(0, maxOpsPerPush) }
}

/** Fold desktop push outcomes back into local facts (conflict evidence for the UI). */
export function summarizePushResults(results) {
  const counts = {}
  const conflicts = []
  for (const entry of results || []) {
    for (const o of entry.outcomes || []) {
      counts[o.verdict] = (counts[o.verdict] || 0) + 1
      if (o.conflict) conflicts.push({ entity: entry.entity, ...o.conflict })
    }
  }
  return { counts, conflicts }
}
