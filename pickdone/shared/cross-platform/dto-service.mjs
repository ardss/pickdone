/* eslint-env node */
/**
 * Cross-platform inbound apply service (Lane A, 2026-11-07).
 *
 * Applies validated cross-platform DTO ops to the AUTHORITATIVE desktop tables via an
 * injected repository — the repository interface is exactly the existing db abstraction
 * surface (entity + op + row), so no second data model exists anywhere in the lane.
 *   repo = {
 *     get(entity, id) -> row|null        // todos|categories|work_episodes|source_refs|task_source_links
 *     put(entity, row) -> void           // the existing upsert door (preserves unknown fields)
 *   }
 *
 * Guarantees per op:
 *   - idempotent: applying the same (entity, id, updatedAt) twice is a no-op the second time
 *   - stale-guard: an inbound row older than the local updatedAt never regresses the row
 *   - tombstone adjudication: delete-vs-edit collisions NEVER silently destroy local edits —
 *     the newer timestamp wins and a `conflict` verdict is returned for user-visible surfacing
 *   - unknown DTO fields ride on the row into repo.put untouched (preserved, not dropped)
 */

export const ENTITIES = ['todos', 'categories', 'work_episodes', 'source_refs', 'task_source_links']

export const VERDICTS = {
  APPLIED: 'applied',
  IDEMPOTENT_SKIP: 'idempotent_skip',
  STALE_SKIP: 'stale_skip',
  CONFLICT_TOMBSTONE_WINS: 'conflict_tombstone_wins',
  CONFLICT_EDIT_WINS: 'conflict_edit_wins',
  REJECTED: 'rejected'
}

function validEntity (entity) {
  return ENTITIES.includes(entity)
}

function stampOf (row) {
  return (row && typeof row.updatedAt === 'number') ? row.updatedAt : 0
}

/**
 * Apply one inbound row (already DTO-decoded to canonical column shape).
 * Returns {verdict, conflict?} — conflict entries carry evidence for surfacing.
 */
export function applyInboundRow (repo, entity, inbound, { now = Date.now() } = {}) {
  if (!repo || typeof repo.get !== 'function' || typeof repo.put !== 'function') {
    throw new TypeError('applyInboundRow: repo with get/put required')
  }
  if (!validEntity(entity)) {
    return { verdict: VERDICTS.REJECTED, reason: `unknown entity: ${entity}` }
  }
  if (!inbound || inbound.id == null || inbound.id === '') {
    return { verdict: VERDICTS.REJECTED, reason: 'row id required' }
  }
  const local = repo.get(entity, inbound.id)
  const inStamp = stampOf(inbound)

  // exact duplicate (same id + same stamp): idempotent no-op
  if (local && stampOf(local) === inStamp && local.deleted === inbound.deleted) {
    return { verdict: VERDICTS.IDEMPOTENT_SKIP }
  }
  // stale inbound: local is strictly newer — never regress
  if (local && stampOf(local) > inStamp) {
    return { verdict: VERDICTS.STALE_SKIP }
  }

  const inDeleted = !!inbound.deleted
  const localDeleted = local ? !!local.deleted : false

  // delete-vs-edit collision (reaching here means the inbound stamp is the newer one):
  // apply the newer side AND surface the conflict so it is never a silent destroy.
  if (local && !localDeleted && inDeleted) {
    repo.put(entity, { ...inbound, updatedAt: inStamp || now })
    return { verdict: VERDICTS.CONFLICT_TOMBSTONE_WINS, conflict: { entity, id: inbound.id, winner: 'delete', source: 'inbound', localUpdatedAt: stampOf(local), inboundUpdatedAt: inStamp } }
  }
  if (local && localDeleted && !inDeleted) {
    repo.put(entity, { ...inbound, updatedAt: inStamp || now })
    return { verdict: VERDICTS.CONFLICT_EDIT_WINS, conflict: { entity, id: inbound.id, winner: 'edit', source: 'inbound', localUpdatedAt: stampOf(local), inboundUpdatedAt: inStamp } }
  }

  // plain apply: preserve the inbound stamp as-is (ms epoch contract), never fabricate
  const row = { ...inbound, updatedAt: inStamp || now }
  repo.put(entity, row)
  return { verdict: VERDICTS.APPLIED }
}

/** Apply a batch; per-row outcomes are independent (one poison row never blocks the batch). */
export function applyInboundBatch (repo, entity, rows, opts = {}) {
  const outcomes = []
  for (const row of rows || []) {
    outcomes.push(applyInboundRow(repo, entity, row, opts))
  }
  return outcomes
}
