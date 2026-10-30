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

/** Per-POST push budget (~4MB serialized envelope bytes). The relay rejects bodies over its
 *  8MB cap with 413 — and the old single-POST push meant one oversized batch was rejected
 *  FOREVER, rebuilt identically every round: a permanent sync break. 4MB per POST keeps a
 *  healthy margin under the relay cap while still batching efficiently. */
export const PUSH_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Pure chunking helper (unit-testable): split push items into consecutive chunks whose
 * serialized-envelope bytes fit `budget`. A single item larger than the budget always gets
 * its own chunk — it is sent alone so the relay's per-item oversize handling (pull `skipped`,
 * spec §68) is the only failure mode, never a whole-batch 413.
 * @param {{opId: string, envelope: string}[]} items
 * @param {number} [budget] serialized byte budget per chunk (default PUSH_CHUNK_BYTES)
 * @returns {{items: {opId: string, envelope: string}[], ids: string[], bytes: number}[]}
 */
export function chunkPushItems(items, budget = PUSH_CHUNK_BYTES) {
  const chunks = []
  let cur = null
  for (const item of items) {
    const size = Buffer.byteLength(item.envelope)
    if (!cur || (cur.bytes + size > budget && cur.items.length > 0)) {
      cur = { items: [], ids: [], bytes: 0 }
      chunks.push(cur)
    }
    cur.items.push(item)
    cur.ids.push(item.opId)
    cur.bytes += size
  }
  return chunks
}

/**
 * @param {object} opts
 * @param {string} opts.nodeId stable device id
 * @param {string} opts.account relay account id
 * @param {string} opts.baseUrl relay origin, e.g. http://127.0.0.1:58480
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {object} [opts.store] existing revision store (attach mode); created when omitted
 * @param {string|null} [opts.deviceSecret] previously-minted bearer credential to ATTACH (durable
 *   restart path): the client presents it on every post WITHOUT re-registering — a blind
 *   re-register against a relay that still holds the device row is a 409 (secret-rotation
 *   guard, sync-relay registerDevice), which would lock the device out. Only a 401 (relay
 *   lost its registry) falls back to re-registration below.
 * @param {(secret: string) => void} [opts.onDeviceSecret] called on EVERY secret capture
 *   (initial register + 401 recovery re-register) so a durable host can persist it — the
 *   401-recovery mint used to be invisible to callers, so the rotated secret died with the
 *   process and every restart re-registered (409 against the still-populated row).
 * @param {{cursor?: number, pushed?: string[]}} [opts.state] durable resume state (ACK/cursor
 *   persistence, spec §18): cursor + already-pushed revisionIds survive process restarts.
 * @param {number} [opts.pushChunkBytes] per-POST serialized budget override (tests / adapters).
 * @param {string|null} [opts.enrollment] operator-issued enrollment secret (relay CTO sweep B#1):
 *   relays that set one reject open registration with 403 — the client presents it (timing-safe
 *   compare server-side) on the register body. Data routes are unaffected.
 * @param {number} [opts.fetchTimeoutMs] per-request abort budget (default 30000): a half-dead
 *   relay used to hang every POST on undici's ~300s default headers timeout × retries × both
 *   round steps — the whole sync loop wedged for many minutes. Timed-out requests throw a
 *   coded error (code 'RELAY_FETCH_TIMEOUT', no .status) which durable hosts classify as
 *   RETRYABLE (transport-level uncertainty, same bucket as a network throw).
 * @param {({applied: number, fromSeq: number, items: Array<{serverSeq: number, envelope: object, status: string}>, ownIds: Set<string>}) => (number|Promise<number>)} [opts.onBeforeAck]
 *   OPTIONAL cursor gate (durable-host hook, relay materialization fix 2026-10-14): called
 *   once per round after the pull frames are decrypted and merged, BEFORE the ack/cursor
 *   commit. `items` is EVERY decrypted frame of the batch in serverSeq order (duplicates
 *   included — a duplicate non-todo frame is still a frame the business layer never
 *   materialized). The returned number becomes the ack/cursor; it is clamped to
 *   [0, applied]. Absent (bare transport) keeps the historical advance-everything ack.
 */
export function createRelayClient({ nodeId, account, baseUrl, fetchImpl = fetch, store, dataKey,
  deviceSecret: initialSecret = null, onDeviceSecret = null, state = null, pushChunkBytes = PUSH_CHUNK_BYTES,
  enrollment = null, fetchTimeoutMs = 30_000, onBeforeAck = null } = {}) {
  if (!nodeId || !account || !baseUrl) throw new Error('relay-client: nodeId, account, baseUrl required')
  const s = store || createRevisionStore(nodeId)
  const clock = new Hlc(nodeId)
  const cursorState = { cursor: Number(state && state.cursor) || 0, pushed: new Set((state && state.pushed) || []) }

  // Per-device bearer credential (server: register is the only unauthenticated route; every data
  // route demands 'Authorization: Bearer <deviceSecret>' — b962d54c). The client half of the same
  // contract: register() captures the minted secret and EVERY post through this single choke point
  // presents it. A client that registered but stayed header-less could never sync (401 on the
  // first pull) — the auth feature was shipped server-only.
  let deviceSecret = null
  if (initialSecret) deviceSecret = String(initialSecret)

  // register logic hoisted to a closure so post()'s 401-recovery can share it (D25 drill-2)
  async function doRegister() {
    const body = { account, device: nodeId }
    if (enrollment) body.enrollment = String(enrollment)
    const res = await post('/v1/device/register', body)
    const secret = res && res.device && res.device.deviceSecret
    if (typeof secret === 'string' && secret) {
      deviceSecret = secret
      if (typeof onDeviceSecret === 'function') { try { onDeviceSecret(secret) } catch { /* a persist hook must never break the wire path */ } }
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
    // connection:'close' — pooled keep-alive sockets keep libuv handles alive across
    // process exit and trip the win32 teardown assert (async.c UV_HANDLE_CLOSING) in
    // short-lived CLI/test processes; a sync client does ~1 round/sec, so a per-round
    // TCP handshake is negligible (same doctrine as the unit-suite fetch fixes).
    // 2026-10-14: every request carries an abort budget (fetchTimeoutMs, default 30s) —
    // a half-dead relay used to hang each POST on undici's ~300s default, and retries ×
    // both round steps turned one bad round into many minutes of wedged sync.
    let res
    try {
      res = await fetchImpl(baseUrl + path, { method: 'POST', body: JSON.stringify(body), headers, connection: 'close', signal: AbortSignal.timeout(fetchTimeoutMs) })
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        // coded (no .status) so durable hosts classify it RETRYABLE (transport-level
        // uncertainty — adapter isRetryable treats status==null as retryable)
        throw Object.assign(new Error(`relay ${path} timed out after ${fetchTimeoutMs}ms`), { code: 'RELAY_FETCH_TIMEOUT' })
      }
      throw e
    }
    if (res.status === 401 && !retried && path !== '/v1/device/register') {
      // D25 drill-2: a relay that rebooted from torn state wiped its device registry — every
      // data route 401s forever until re-registration. One bounded re-auth + retry through the
      // same register() that also resets the stale cursor/pushed-set (see register()).
      await doRegister()
      return post(path, body, true)
    }
    if (!res.ok) {
      // status-bearing errors let durable hosts classify retryable (5xx/429/network-throw)
      // vs permanent (4xx: 409 secret-rotation guard, 413 oversize...) failures — a caller
      // that cannot distinguish them either retries forever on a 409 or gives up on a blip.
      const e = new Error(`relay ${path} -> ${res.status}`)
      e.status = res.status
      throw e
    }
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
      // Frames this device itself pushed (durable set + this round's push batch): the
      // cursor gate's "own frame" signal — pull-side marks must not leak into it (see
      // the unmark after the gate below), or a previously held peer frame would count
      // as own on its re-pull and the hold would last exactly one round.
      const pushedBeforeRound = new Set(cursorState.pushed)
      const items = []
      for (const env of s.revisions.values()) {
        if (!cursorState.pushed.has(env.revisionId)) {
          // E2E: the relay stores opaque ciphertext when a data key is present —
          // same schema, same endpoints (spec §3: payload stays opaque to the relay)
          items.push({ opId: env.revisionId, envelope: dataKey ? seal(dataKey, env) : packEnvelope(env) })
        }
      }
      // mark ONLY after the relay accepted each chunk: marking before made a transient push
      // failure orphan the revisions forever (never re-pushed, silent divergence). Chunked
      // pushes (2026-10-09 P1): one POST per ~4MB chunk — the old single POST 413'd forever on
      // an oversized batch (the same batch rebuilt identically every round = permanent break).
      // Per-chunk marking keeps the same invariant per chunk: only the accepted chunk's ids
      // enter the pushed-set; a failed chunk's revisions re-push next round.
      if (items.length) {
        for (const chunk of chunkPushItems(items, pushChunkBytes)) {
          await post('/v1/sync/push', { account, device: nodeId, items: chunk.items })
          for (const id of chunk.ids) cursorState.pushed.add(id)
        }
      }
      // D26: pin the byte budget explicitly (8MB, the relay's push body cap) instead of riding
      // the server default — an envelope up to that size is deliverable by construction, so a
      // pull can only report `skipped` for frames that are oversized-by-policy, never by a
      // budget this client chose implicitly.
      const PULL_MAX_BYTES = 8 * 1024 * 1024
      const pull = await post('/v1/sync/pull', { account, afterSeq: cursorState.cursor, maxBytes: PULL_MAX_BYTES })
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
      // Pull-side materialization seam (2026-10-10): every successfully decrypted,
      // non-duplicate frame is reported to the caller so a durable host can ingest it
      // into its local DAG + business tables. Without this the merge lived only in the
      // ephemeral store while the cursor advanced past the frames — silent loss on
      // restart. Purely additive result field; bare-transport callers may ignore it.
      const received = []
      // Cursor-gate input (2026-10-14): EVERY decrypted frame of the batch in serverSeq
      // order, duplicates INCLUDED. The durable host's business layer may only be able to
      // materialize a subset of entities; with duplicates filtered out, a re-pulled
      // unmaterializable frame would vanish from the gate's view and the next batch's
      // cursor would silently jump over it (silent-loss regression scenario).
      const ackItems = []
      // D26: `skipped` frames (relay-declared oversize — it can never deliver them) are
      // undeliverable by construction; quarantine semantics (spec §68): advance past them
      // and ack, or the cursor pins below the skip forever and every later envelope
      // deadlocks behind it.
      for (const sk of pull.skipped || []) {
        applied = Math.max(applied, sk.serverSeq)
        quarantined++
      }
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
        // The relay demonstrably holds this frame (we just pulled it): mark it pushed so a
        // durable host that ingested the revision into its store never re-pushes it (the
        // relay dedupes by opId anyway — this only spares the bytes). Durable persistence
        // of the marking stays the adapter's commit point, so a failed round replays.
        cursorState.pushed.add(env.revisionId)
        ackItems.push({ serverSeq: item.serverSeq, envelope: env, status: r.status, action: r.action })
        if (r.status !== 'duplicate') received.push({ envelope: env, status: r.status, action: r.action, serverSeq: item.serverSeq })
        // ack advances past applied/merged frames AND duplicates (own frames come back
        // on every pull — without this the cursor never moved and GC was pinned at 0)
        // but NOT past frames that failed to merge for other reasons (spec §18/§67)
        if (r.status === 'applied' || r.status === 'ignored' || r.status === 'duplicate') applied = Math.max(applied, item.serverSeq)
      }
      // Cursor gate (2026-10-14): the durable host holds the cursor at the last frame its
      // business layer fully materialized — a batch containing frames it could NOT
      // materialize (non-todo entities this slice) must not be acked/GC'd away, or those
      // remote changes are lost forever behind a green cursor. Re-pull is idempotent
      // (duplicate-safe by revisionId, LWW no-ops) — preferring duplicate pulls over
      // silent loss is the whole point. A gate failure is DETERMINISTIC (local apply
      // state), not a transport blip: mark noRetry so the adapter's step() fails the
      // round immediately instead of re-running the same failing apply 3×.
      let ackSeq = applied
      if (typeof onBeforeAck === 'function' && ackItems.length) {
        const ownIds = new Set(pushedBeforeRound)
        for (const it of items) ownIds.add(it.opId)
        try {
          ackSeq = await onBeforeAck({ applied, fromSeq: pull.fromSeq, items: ackItems, ownIds })
        } catch (e) {
          throw Object.assign(e, { noRetry: true })
        }
        if (!Number.isFinite(ackSeq) || ackSeq < 0) ackSeq = 0
        ackSeq = Math.min(ackSeq, applied)
        // Frames the gate held BELOW the ack must not stay in the pushed-set: the mark
        // told the durable host "this revision is safely local" — for a held (peer,
        // unmaterializable) frame that is exactly the lie that would let a later round
        // classify it as own and ack it into GC. Unmark so every replay sees it as a
        // foreign frame until the gate finally advances past it.
        for (const it of ackItems) {
          if (Number.isFinite(it.serverSeq) && it.serverSeq > ackSeq) cursorState.pushed.delete(it.envelope.revisionId)
        }
      }
      cursorState.cursor = ackSeq
      let ackInfo = null
      if (ackSeq > 0) ackInfo = await post('/v1/sync/ack', { account, device: nodeId, ackSeq })
      return { pushed: items.length, pulled: pull.items.length, quarantined, cursor: ackSeq, ack: ackInfo, received }
    },
    register: doRegister,
    materialized() { return materializedAll(s) },
    /** Durable-state introspection for ACK/cursor persistence (spec §18): the host snapshots
     *  this AFTER a successful round and seeds it back via the `state` option on restart. */
    state() { return { cursor: cursorState.cursor, pushed: [...cursorState.pushed] } },

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
