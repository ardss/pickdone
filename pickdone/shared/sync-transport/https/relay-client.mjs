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
import { packEnvelope, unpackEnvelope } from '../../sync-core/revision/envelope.mjs'

/**
 * @param {object} opts
 * @param {string} opts.nodeId stable device id
 * @param {string} opts.account relay account id
 * @param {string} opts.baseUrl relay origin, e.g. http://127.0.0.1:58480
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {object} [opts.store] existing revision store (attach mode); created when omitted
 */
export function createRelayClient({ nodeId, account, baseUrl, fetchImpl = fetch, store } = {}) {
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
          items.push({ opId: env.revisionId, envelope: packEnvelope(env) })
          cursorState.pushed.add(env.revisionId)
        }
      }
      if (items.length) await post('/v1/sync/push', { account, device: nodeId, items })
      const pull = await post('/v1/sync/pull', { account, afterSeq: cursorState.cursor })
      let applied = cursorState.cursor
      for (const item of pull.items) {
        const env = unpackEnvelope(item.envelope)
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
  }
}
