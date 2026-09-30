/**
 * PickDone sync-core v2: immutable revision envelope codec (spec §7/§8/§13/§14,
 * design doc `docs/sync-v2-core-design.md` step 3).
 *
 * An envelope is the ONLY unit that crosses a transport in v2. It is immutable:
 * revisionId, HLC, authorDeviceId, parents and payloadHash never change after
 * creation (spec §8). The payload is the canonical entity content at that
 * revision — never "the current row re-read later" (that was the v1 oplog defect,
 * docs/sync-v2-old-architecture-problems.md P1-2).
 *
 * Pure module: no db, no transport, no wall clock.
 */

import { createHash } from 'node:crypto'
import { revisionIdFrom } from '../clock/hlc.mjs'

/**
 * Bookkeeping fields excluded from content identity — same exclusion set as the
 * v1 contentFingerprint (merge.mjs BOOKKEEPING) so "stamp-only difference" never
 * mints a conflict copy. Business payload only.
 */
const CONTENT_IGNORE = new Set([
  'id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'userId', 'author', 'syncAuthor',
])

const EMPTY_SET = new Set()

/** Deterministic JSON: recursively sorted object keys, stable across devices.
 *  Bookkeeping fields are stripped at the TOP LEVEL ONLY (they are row stamps on
 *  the entity row) — stripping at every depth collided distinct nested objects
 *  (e.g. subtasks differing only by their own ids) and weakened verifyEnvelope. */
export function canonicalJson(value, ignore = CONTENT_IGNORE, depth = 0) {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v, ignore, depth + 1)).join(',')}]`
  if (value && typeof value === 'object') {
    const drop = depth === 0 ? ignore : EMPTY_SET
    const keys = Object.keys(value)
      .filter(k => !drop.has(k))
      .filter(k => value[k] !== undefined)
      .sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k], ignore, depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function hashPayload(payload, ignore = CONTENT_IGNORE) {
  return createHash('sha256').update(canonicalJson(payload, ignore)).digest('hex')
}

/**
 * Mint a revision envelope. `hlc` is the author's stamp for this event; parents
 * are the revisionIds this revision supersedes ([] for an entity's first revision).
 */
export function createEnvelope({ entity, entityId, hlc, parents = [], payload }) {
  if (!entity || !entityId) throw new Error('envelope: entity and entityId required')
  if (!hlc || typeof hlc.physical !== 'number' || !hlc.nodeId) throw new Error('envelope: hlc stamp required')
  const payloadHash = hashPayload(payload)
  // Content-hash suffix in the id: a device that loses its persisted HLC and
  // restarts on a rolled-back wall clock could re-mint the same (hlc, nodeId) for a
  // DIFFERENT payload — the sort key alone would collide and silently shadow a
  // real revision (found by adversarial review). Same HLC + same content = the
  // same revision by definition, so the suffix makes genuine duplicates dedupe
  // while distinct content can never share an id.
  const revisionId = revisionIdFrom(hlc) + '-' + payloadHash.slice(0, 8)
  return {
    revisionId,
    entity,
    entityId,
    authorDeviceId: hlc.nodeId,
    hlc: { physical: hlc.physical, logical: hlc.logical, nodeId: hlc.nodeId },
    parents: [...parents],
    payloadHash,
    payload,
  }
}

/** Integrity check: the envelope's declared hash must match its payload (spec §17 validate step). */
export function verifyEnvelope(envelope) {
  return hashPayload(envelope.payload) === envelope.payloadHash
}

/** Wire codec — JSON for LAN parity today; bytes-only once the HTTPS adapter lands. */
export function packEnvelope(envelope) {
  return JSON.stringify(envelope)
}

export function unpackEnvelope(bytes) {
  const envelope = JSON.parse(bytes)
  if (!envelope.revisionId || !envelope.entityId || !envelope.hlc) {
    throw new Error('envelope: malformed frame')
  }
  if (!verifyEnvelope(envelope)) throw new Error('envelope: payload hash mismatch')
  return envelope
}
