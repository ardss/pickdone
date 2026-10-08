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

  // Per-device bearer credential (server: register is the only unauthenticated route; every data
  // route demands 'Authorization: Bearer <deviceSecret>' — b962d54c). The client half of the same
  // contract: register() captures the minted secret and EVERY post through this single choke point
  // presents it. A client that registered but stayed header-less could never sync (401 on the
  // first pull) — the auth feature was shipped server-only.
  let deviceSecret = null

  // register logic hoisted to a closure so post()'s 401-recovery can share it (D25 drill-2)
  async function doRegister() {
    const res = await post('/v1/device/register', { account, device: nodeId })
    const secret = res && res.device && res.device.deviceSecret
    if (typeof secret === 'string' && secret) {
      deviceSecret = secret
      // D25 drill-2: re-registration only happens when the relay lost its device registry —
      // i.e. its whole store (seq included) may have restarted. A cursor/pushed-set minted
      // against the OLD store would suppress re-push (everything looks acked) and skip pulls
      // (cursor above the new head): the silent-loss drill scenario. Reset both so the next
      // round re-pushes every revision and re-pulls from 0 — replays are duplicates/ignored,
      // and LWW makes the convergence safe.
      cursorState.cursor = 0
      cursorState.pushed.clear()
    }
    return res
  }

  async function post(path, body, retried = false) {
    const headers = { 'content-type': 'application/json' }
    if (deviceSecret) headers.authorization = `Bearer ${deviceSecret}`
    const res = await fetchImpl(baseUrl + path, { method: 'POST', body: JSON.stringify(body), headers })
    if (res.status === 401 && !retried && path !== '/v1/device/register') {
      // D25 drill-2: a relay that rebooted from torn state wiped its device registry — every
      // data route 401s forever until re-registration. One bounded re-auth + retry through the
      // same register() that also resets the stale cursor/pushed-set (see register()).
      await doRegister()
      return post(path, body, true)
    }
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
      const batch = []
      for (const env of s.revisions.values()) {
        if (!cursorState.pushed.has(env.revisionId)) {
          // E2E: the relay stores opaque ciphertext when a data key is present —
          // same schema, same endpoints (spec §3: payload stays opaque to the relay)
          items.push({ opId: env.revisionId, envelope: dataKey ? seal(dataKey, env) : packEnvelope(env) })
          batch.push(env.revisionId)
        }
      }
      // mark ONLY after the relay accepted the batch: marking before made a transient
      // push failure orphan the revisions forever (never re-pushed, silent divergence)
      if (items.length) { await post('/v1/sync/push', { account, device: nodeId, items }); for (const id of batch) cursorState.pushed.add(id) }
      const pull = await post('/v1/sync/pull', { account, afterSeq: cursorState.cursor })
      // D25 drill-2 (torn relay-state quarantine reboot): the relay's seq restarts at 1 while a
      // client's durable cursor sits above the new head — that client pulls nothing forever and
      // fresh writes silently never reach peers. headSeq (relay's live max seq) below the local
      // cursor is the fingerprint of a lost relay store: reset the local sync state (cursor and
      // pushed-set) and bail; the next round re-pushes every revision and re-pulls from 0 —
      // applyEnvelope treats the replays as duplicates/ignored, so convergence is LWW-safe.
      if (Number.isFinite(pull.headSeq) && pull.headSeq < cursorState.cursor) {
        cursorState.cursor = 0
        cursorState.pushed.clear()
        return { pushed: 0, pulled: pull.items.length, quarantined: 0, cursor: 0, regressionReset: true }
      }
      let applied = cursorState.cursor
      let quarantined = 0
      for (const item of pull.items) {
        let env
        try {
          env = dataKey ? open(dataKey, item.envelope) : unpackEnvelope(item.envelope)
        } catch (e) {
          // quarantine semantics (spec §68): a frame that can never verify (tamper,
          // bad version, corrupt JSON) must not wedge the device forever — skip it,
          // advance past it, keep local state intact
          applied = Math.max(applied, item.serverSeq)
          quarantined++
          continue
        }
        const r = applyEnvelope(s, env)
        // ack advances past applied/merged frames AND duplicates (own frames come back
        // on every pull — without this the cursor never moved and GC was pinned at 0)
        // but NOT past frames that failed to merge for other reasons (spec §18/§67)
        if (r.status === 'applied' || r.status === 'ignored' || r.status === 'duplicate') applied = Math.max(applied, item.serverSeq)
      }
      cursorState.cursor = applied
      let ackInfo = null
      if (applied > 0) ackInfo = await post('/v1/sync/ack', { account, device: nodeId, ackSeq: applied })
      return { pushed: items.length, pulled: pull.items.length, quarantined, cursor: cursorState.cursor, ack: ackInfo }
    },
    register: doRegister,
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
