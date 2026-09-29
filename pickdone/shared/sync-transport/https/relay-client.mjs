/**
 * PickDone Sync v2 — HTTPS relay client (spec §16/§17/§18/§56, transport adapter).
 *
 * Wraps a sync-core revision store with the relay wire protocol: push pending
 * revisions, pull by durable serverSeq cursor, ack only past what actually
 * applied (cursor-commit rule §18: download → verify → merge → advance).
 *
 * Pure wire logic — no Electron, no db. The caller owns scheduling (spec §65)
 * and provides the store; commitLocal stays the only write path.
 */

import { Hlc } from '../../sync-core/clock/hlc.mjs'
import { createRevisionStore, commitLocal, applyEnvelope, materializedAll } from '../../sync-core/causality/merge.mjs'
import { packEnvelope, unpackEnvelope, hashPayload } from '../../sync-core/revision/envelope.mjs'
import { seal, open } from '../../sync-crypto/e2e.mjs'

/**
 * @param {object} opts
 * @param {string} opts.nodeId stable device id
 * @param {string} opts.account relay account id
 * @param {string} opts.baseUrl relay origin, e.g. http://127.0.0.1:58480
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {object} [opts.store] existing revision store (attach mode); created when omitted
 */
export function createRelayClient({ nodeId, account, baseUrl, fetchImpl = fetch, store, dataKey } = {}) {
  if (!nodeId || !account || !baseUrl) throw new Error('relay-client: nodeId, account, baseUrl required')
  const s = store || createRevisionStore(nodeId)
  const clock = new Hlc(nodeId)
  const cursorState = { cursor: 0, pushed: new Set() }

  async function post(path, body) {
    const res = await fetchImpl(baseUrl + path, { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`relay ${path} -> ${res.status}`)
    return res.json()
  }

  return {
    nodeId,
    store: s,
    clock,
    /** Local write: the ONLY way content enters the store from this device. */
    async commit(entityId, payload, entity = 'todo') {
      return commitLocal(s, { entity, entityId, clock, payload })
    },
    /** One sync round. Idempotent; safe to call from any scheduler cadence. */
    async round() {
      const items = []
      for (const env of s.revisions.values()) {
        if (!cursorState.pushed.has(env.revisionId)) {
          // E2E: the relay stores opaque ciphertext when a data key is present —
          // same schema, same endpoints (spec §3: payload stays opaque to the relay)
          items.push({ opId: env.revisionId, envelope: dataKey ? seal(dataKey, env) : packEnvelope(env) })
          cursorState.pushed.add(env.revisionId)
        }
      }
      if (items.length) await post('/v1/sync/push', { account, device: nodeId, items })
      const pull = await post('/v1/sync/pull', { account, afterSeq: cursorState.cursor })
      let applied = cursorState.cursor
      for (const item of pull.items) {
        const env = dataKey ? open(dataKey, item.envelope) : unpackEnvelope(item.envelope)
        const r = applyEnvelope(s, env)
        // ack advances only past frames that verified + merged (or were stale/dup) —
        // a verify/merge failure must NOT advance (spec §18/§67)
        if (r.status === 'applied' || r.status === 'ignored') applied = Math.max(applied, item.serverSeq)
      }
      cursorState.cursor = applied
      let ackInfo = null
      if (applied > 0) ackInfo = await post('/v1/sync/ack', { account, device: nodeId, ackSeq: applied })
      return { pushed: items.length, pulled: pull.items.length, cursor: cursorState.cursor, ack: ackInfo }
    },
    async register() { return post('/v1/device/register', { account, device: nodeId }) },
    materialized() { return materializedAll(s) },

    /**
     * Snapshot upload (spec §22/§23): the entity's CURRENT revision envelope per
     * entityId + coversSeq = the cursor this store is caught up to. A peer can
     * bootstrap from this snapshot + replay the tail after coversSeq — never a
     * full-oplog replay.
     */
    async uploadSnapshot() {
      if (cursorState.cursor === 0) await this.round()
      const entities = []
      for (const entityId of new Set([...s.currentByEntity.keys()])) {
        const cur = s.currentByEntity.get(entityId)
        const env = s.revisions.get(cur)
        if (env) entities.push(env)
      }
      const latest = await post('/v1/snapshot/latest', { account })
      const generation = (latest.snapshot ? latest.snapshot.generation : 0) + 1
      const snapshot = {
        snapshotId: `snap-${generation}-${nodeId}`,
        generation,
        coversSeq: cursorState.cursor,
        authorDeviceId: nodeId,
        createdAt: Date.now(),
        entities,
      }
      await post('/v1/snapshot/put', { account, snapshot: { ...snapshot, entities: dataKey ? seal(dataKey, entities) : entities } })
      return { generation, coversSeq: snapshot.coversSeq, entities: entities.length }
    },

    /**
     * Bootstrap (spec §23): latest valid snapshot → rebuild store from the current
     * envelopes → replay tail → normal sync. Local pending pushes are preserved:
     * they live in `pending` and are re-pushed on the next round (spec §24/§27 —
     * the relay never rejects a revision for arriving late).
     */
    async bootstrap() {
      const latest = await post('/v1/snapshot/latest', { account })
      if (!latest.snapshot) return { bootstrapped: false, reason: 'no-snapshot' }
      const pending = []
      for (const env of s.revisions.values()) {
        if (!cursorState.pushed.has(env.revisionId)) pending.push(env)
      }
      s.revisions.clear(); s.currentByEntity.clear(); s.headsByEntity.clear(); s.conflictsByEntity.clear()
      cursorState.pushed.clear()
      const snapEntities = typeof latest.snapshot.entities === 'string' && dataKey
        ? open(dataKey, latest.snapshot.entities)
        : (latest.snapshot.entities || [])
      for (const env of snapEntities) {
        // integrity first (spec §23 verify step): a tampered snapshot entry must
        // abort the bootstrap, never restore half-verified state
        if (hashPayload(env.payload) !== env.payloadHash) throw new Error('relay-client: snapshot payload hash mismatch')
        applyEnvelope(s, env)
        cursorState.pushed.add(env.revisionId)
      }
      cursorState.cursor = latest.snapshot.coversSeq || 0
      for (const env of pending) applyEnvelope(s, env)
      await this.round()
      return { bootstrapped: true, generation: latest.snapshot.generation, coversSeq: cursorState.cursor }
    },
  }
}
