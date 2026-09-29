/**
 * PickDone sync-core v2: causal revision store + merge (spec §9/§10/§11/§12/§60,
 * design doc `docs/sync-v2-core-design.md` steps 4-5).
 *
 * THE single merge engine of the system (spec §60: mergeRevision() only, no
 * mergeLan/mergeCloud). Replaces the v1 wall-clock LWW heuristic: conflict
 * classification is causal (duplicate / ancestor / descendant / concurrent),
 * ordering inside concurrent is deterministic HLC max, and a losing concurrent
 * branch is preserved as a conflict copy — never silently dropped (spec §11).
 *
 * Pure module: no db, no transport, no wall clock. The caller owns HLC ticking
 * and persistence.
 */

import { cmpHlc } from '../clock/hlc.mjs'
import { createEnvelope, hashPayload } from '../revision/envelope.mjs'

/** Depth bound for ancestry walks: beyond this, classify conservative-concurrent
 *  (same outcome as v1 for ancient rows; payload pruning makes deeper walks moot). */
const MAX_ANCESTRY_DEPTH = 32

export function createRevisionStore(nodeId) {
  if (!nodeId) throw new Error('revision-store: nodeId required')
  return {
    nodeId,
    /** revisionId -> envelope. Includes foreign revisions received from peers. */
    revisions: new Map(),
    /** entityId -> revisionId of the materialized current state. */
    currentByEntity: new Map(),
    /** entityId -> Set<revisionId> of concurrent branches not yet superseded. */
    headsByEntity: new Map(),
    /** Materialized conflict copies: entityId -> Map<revisionId, envelope>. */
    conflictsByEntity: new Map(),
  }
}

function headsOf(store, entityId) {
  if (!store.headsByEntity.has(entityId)) store.headsByEntity.set(entityId, new Set())
  return store.headsByEntity.get(entityId)
}

function conflictsOf(store, entityId) {
  if (!store.conflictsByEntity.has(entityId)) store.conflictsByEntity.set(entityId, new Map())
  return store.conflictsByEntity.get(entityId)
}

/** Is `candidate` an ancestor of `revisionId` within the locally known graph?
 *  Unknown parents stop the walk (conservative: caller then treats as concurrent). */
export function isAncestor(store, candidate, revisionId) {
  const seen = new Set()
  let frontier = [revisionId]
  for (let depth = 0; frontier.length && depth < MAX_ANCESTRY_DEPTH; depth++) {
    const next = []
    for (const id of frontier) {
      const rev = store.revisions.get(id)
      if (!rev) continue // unknown history segment: this path proves nothing
      for (const p of rev.parents) {
        if (p === candidate) return true
        if (!seen.has(p)) { seen.add(p); next.push(p) }
      }
    }
    frontier = next
  }
  return false
}

/**
 * Local write: mint a revision superseding the current state and any unresolved
 * concurrent heads (spec §4.2 multi-parent merge point), then apply it as current.
 *
 * Takes the author's CLOCK (not a ready stamp): before ticking, it receives the
 * HLC of every known parent revision into the clock (spec §6 rule 2 — a device
 * that has materialized a remote revision must advance past it before authoring
 * a child). This makes "child HLC > every parent HLC" a structural invariant;
 * the randomized simulator caught the violation when it was caller-ticked.
 */
export function commitLocal(store, { entity, entityId, clock, payload }) {
  const current = store.currentByEntity.get(entityId)
  const parentIds = current ? [current, ...headsOf(store, entityId)] : []
  for (const pid of parentIds) {
    const parent = store.revisions.get(pid)
    if (parent) clock.receive(parent.hlc)
  }
  const envelope = createEnvelope({ entity, entityId, hlc: clock.tick(), parents: parentIds, payload })
  applyEnvelope(store, envelope)
  headsOf(store, entityId).clear()
  pruneSuperseded(store, entityId, envelope.revisionId)
  return envelope
}

/** Prune per-entity bookkeeping once revisions become ancestors of current:
 *  heads that are superseded stop polluting future multi-parent commits, and
 *  conflict copies of causally-resolved branches stop surfacing in materialized()
 *  (both contracts were stated but unimplemented — adversarial review caught it). */
function pruneSuperseded(store, entityId, currentId) {
  const heads = headsOf(store, entityId)
  for (const h of [...heads]) {
    if (isAncestor(store, h, currentId)) heads.delete(h)
  }
  const conflicts = store.conflictsByEntity.get(entityId)
  if (conflicts) {
    for (const id of [...conflicts.keys()]) {
      if (isAncestor(store, id, currentId)) conflicts.delete(id)
    }
  }
}

/**
 * Apply a received (or just-minted) envelope. Returns one of:
 *   { status: 'duplicate' }                        — already known (spec §10 case 1)
 *   { status: 'ignored', action: 'ancestor' }      — stale, causally superseded (case 2)
 *   { status: 'applied', action: 'descendant' }    — fast-forward (case 3)
 *   { status: 'applied', action: 'concurrent', loser } — LWW materialized, loser preserved (case 4)
 * `loser` (when present) is the envelope of the losing branch, or null when the
 * losing content was identical/tombstone-equivalent and needs no copy.
 */
export function applyEnvelope(store, envelope) {
  const { entityId, revisionId } = envelope
  if (store.revisions.has(revisionId)) return { status: 'duplicate' }
  store.revisions.set(revisionId, envelope) // immutable insert only (spec §8)

  const currentId = store.currentByEntity.get(entityId)
  if (!currentId) {
    store.currentByEntity.set(entityId, revisionId)
    return { status: 'applied', action: 'descendant' }
  }

  if (isAncestor(store, revisionId, currentId)) {
    return { status: 'ignored', action: 'ancestor' }
  }
  if (isAncestor(store, currentId, revisionId)) {
    store.currentByEntity.set(entityId, revisionId)
    headsOf(store, entityId).delete(currentId)
    pruneSuperseded(store, entityId, revisionId)
    return { status: 'applied', action: 'descendant' }
  }

  // Concurrent (case 4): deterministic winner, loser preserved.
  const current = store.revisions.get(currentId)
  const winner = cmpHlc(envelope.hlc, current.hlc) >= 0 ? envelope : current
  const loser = winner === envelope ? current : envelope
  store.currentByEntity.set(entityId, winner.revisionId)
  headsOf(store, entityId).delete(winner.revisionId)
  headsOf(store, entityId).add(loser.revisionId)
  pruneSuperseded(store, entityId, winner.revisionId)

  let preserved = null
  if (hashPayload(loser.payload) !== hashPayload(winner.payload)) {
    conflictsOf(store, entityId).set(loser.revisionId, loser)
    preserved = loser
  }
  return { status: 'applied', action: 'concurrent', loser: preserved }
}

/** Materialized view for one entity: current payload + conflict-copy payloads. */
export function materialized(store, entityId) {
  const currentId = store.currentByEntity.get(entityId)
  const current = currentId ? store.revisions.get(currentId) : null
  return { current, conflicts: [...conflictsOf(store, entityId).values()] }
}

/** Full materialized state, entityId -> payload (for convergence assertions). */
export function materializedAll(store) {
  const out = {}
  for (const entityId of store.currentByEntity.keys()) {
    const { current } = materialized(store, entityId)
    out[entityId] = current ? current.payloadHash : null
  }
  return out
}
