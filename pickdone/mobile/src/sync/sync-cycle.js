// Pure sync cycle over the pair contract — pull merge + push planning.
// Verdicts come from inboundVerdict (same truth table as the desktop dto-service); this module
// only orchestrates: decode inbound DTOs, decide, and hand {entity, row} changes back to the
// caller which persists them through the repository's applyPulled door. No transport, no DB.

import { ENTITY_DECODERS, ENTITY_ENCODERS, ENTITIES, inboundVerdict, VERDICTS } from './pair-contract.js'

export { VERDICTS }

/**
 * Merge a pulled desktop snapshot into the local rows (raw rows INCLUDING tombstones).
 * Returns {changes:[{entity, row}], conflicts:[{entity, id, verdict, local, incoming}], skipped}.
 * A poison DTO (decode throw) is counted as skipped and never blocks the batch.
 */
export function mergePull(localByEntity, entities, { decoders = ENTITY_DECODERS } = {}) {
  const changes = []
  const conflicts = []
  let skipped = 0
  for (const entity of ENTITIES) {
    const dtos = entities?.[entity]
    if (!Array.isArray(dtos)) continue
    const byId = new Map((localByEntity[entity] || []).map(row => [String(row.id), row]))
    for (const dto of dtos) {
      let incoming
      try { incoming = decoders[entity](dto) } catch { skipped += 1; continue }
      const local = byId.get(String(incoming.id))
      const verdict = inboundVerdict(local, incoming)
      if (verdict === VERDICTS.APPLIED || verdict === VERDICTS.CONFLICT_TOMBSTONE_WINS || verdict === VERDICTS.CONFLICT_EDIT_WINS) {
        changes.push({ entity, row: incoming })
        if (verdict !== VERDICTS.APPLIED) conflicts.push({ entity, id: incoming.id, verdict, local, incoming })
      } else {
        skipped += 1
      }
    }
  }
  return { changes, conflicts, skipped }
}

/**
 * Plan outbound ops from raw local rows (tombstones included — the desktop adjudicates).
 * Chunks to the wire caps: <=500 rows per op, <=500 ops per push. Poison rows are dropped.
 */
export function planPush(rawByEntity, { encoders = ENTITY_ENCODERS, maxRowsPerOp = 500, maxOpsPerPush = 500 } = {}) {
  const ops = []
  for (const entity of ENTITIES) {
    const encode = encoders[entity]
    const rows = rawByEntity[entity] || []
    for (let i = 0; i < rows.length; i += maxRowsPerOp) {
      const chunk = []
      for (const row of rows.slice(i, i + maxRowsPerOp)) {
        try { chunk.push(encode(row)) } catch { /* poison row never blocks the batch */ }
      }
      if (chunk.length) ops.push({ entity, rows: chunk })
    }
  }
  return { ops: ops.slice(0, maxOpsPerPush) }
}

/** Fold desktop push outcomes into counts + conflict evidence for the UI. */
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
