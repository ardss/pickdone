/**
 * Command bus — the single write door for renderer mutations (Phase 1 of
 * docs/refactor-command-bus.md).
 *
 * commit(entity, verb, payload[, opts]):
 *   1. validate against the MANIFEST — an unknown command THROWS (code USAGE), never a
 *      silent no-op;
 *   2. normalize stamps — the bus, not the caller, is the source of truth for updatedAt.
 *      When the payload already carries the LWW field (the sync-apply internal path carries
 *      the peer row's age), the explicit stamp is preserved via opts.preserveStamp or an
 *      already-set field — BUT an explicit stamp more than STAMP_CLAMP_MS into the future
 *      is always clamped to local now (forgery guard; preserveStamp never shields a future
 *      stamp, see stampPayload below);
 *   3. dispatch to the existing tested db op — oplog capture stays where it is today
 *      (db.call appends it), so the wire/on-disk protocol is untouched;
 *   4. run post-commit fanout hooks in registration order. Subscribers (LS-mirror notice,
 *      undo-barrier notice) observe the commit — they are never second writers.
 *
 * Hookless-bus caveat (P3-2, R5): out-of-process CLI sessions commit through a bus instance
 * with zero registered onCommit hooks — no LS-mirror kick, no undo-barrier. Safety rests on
 * the "subscribers are never second writers" invariant (their absence cannot lose data), and
 * the external-write watcher kicks sync when the App observes a CLI-written file.
 *
 * The engine (oplog ring, watermarks, LWW merge) is explicitly out of bounds.
 *
 * Testability: createBus lets the unit tests inject a fake db layer; the default export is
 * the real bus bound to src/main/db.js's call().
 */

const manifest = require('./command-manifest')
// Arch review 2026-09-22 rec #3: the clamp window is the SHARED constant (src/main/stamp-clamp.js)
// — the same window/semantics as sync-apply.js's ingress clampSkew, enforced by the gate.
const { STAMP_CLAMP_MS } = require('./stamp-clamp')

const USAGE = 'USAGE'
// D6 P2 (2026-09-21): explicit-stamp clamp window — legit device clock skew, not forgery.
// Arch review 2026-09-22 rec #3: now aliased to the shared STAMP_CLAMP_MS (10min, was 5min).
const STAMP_SKEW_MS = STAMP_CLAMP_MS

function usageError (msg) {
  const e = new Error('[command-bus] ' + msg)
  e.code = USAGE
  return e
}

function createBus (dbCall, manifestMod = manifest) {
  if (typeof dbCall !== 'function') throw new Error('[command-bus] dbCall( op, params ) required')
  // Registration-ordered fanout. A hook named identically replaces its predecessor (the IPC
  // module re-registers on every registerIpc without leaking duplicates).
  const hooks = []

  function onCommit (name, fn) {
    if (typeof fn !== 'function') throw new Error('[command-bus] onCommit(name, fn) requires fn')
    const i = hooks.findIndex(h => h.name === name)
    if (i >= 0) hooks[i] = { name, fn }
    else hooks.push({ name, fn })
    return () => offCommit(name)
  }

  function offCommit (name) {
    const i = hooks.findIndex(h => h.name === name)
    if (i >= 0) hooks.splice(i, 1)
  }

  function runHooks (ctx) {
    // Fire-and-forget like every other post-write notice: a failing subscriber must never
    // turn a landed DB write into a rejected IPC promise.
    for (const h of hooks) {
      try { h.fn(ctx) } catch (e) { try { require('electron-log').warn('[command-bus] fanout hook failed:', h.name, e) } catch { /* headless test env */ } }
    }
  }

  /**
   * Stamp normalization. Returns the payload to persist:
   * - ROW-LIST payloads (bus-stamps fix 2026-09-22): arrays (todo.putMany, tomato.appendMany,
   *   plan/setting/category/filter putMany rows) and the todo.commitBatch { rows: [...] }
   *   envelope carry one age PER ROW — each plain-object element is stamped/clamped with the
   *   same rules. Non-object elements (meta ['k','v'] pair arrays have lwwField null and are
   *   never reached; defensive for scalars) pass through verbatim.
   * - NESTED PATCH payloads (tomato.updateById): the real LWW age lives in payload.patch —
   *   an explicit future stamp inside .patch is clamped exactly like a top-level one.
   * - wave-A (2026-09-21): the same clamp covers `deletedAt` wherever the payload (top level
   *   or .patch) carries one — a forged future tombstone stamp would win delete-vs-live LWW
   *   forever. The clamp applies regardless of opts.preserveStamp: that flag protects the
   *   caller's LWW AGE (lwwField), never a future-dated deletion stamp.
   * NON-PLAIN payloads (bare string keys, scalars) pass through VERBATIM.
   * Payload is never mutated in place — callers may hold reactive rows.
   */
  function stampPayload (row, payload, opts = {}) {
    const f = row.lwwField
    if (!f || payload == null || typeof payload !== 'object') return payload
    if (Array.isArray(payload)) return payload.map(el => stampValue(f, el, opts))
    // todo.commitBatch envelope: commitSyncBatch takes { rows, version } — the ages ride on
    // payload.rows, so the bus stamps/clamps each row instead of the envelope itself.
    if (Array.isArray(payload.rows)) {
      return Object.assign({}, payload, { rows: payload.rows.map(el => stampValue(f, el, opts)) })
    }
    return stampValue(f, payload, opts)
  }

  /** Clamp-or-stamp one plain-object row against the manifest's lwwField. */
  function stampValue (f, p, opts) {
    if (p == null || typeof p !== 'object' || Array.isArray(p)) return p
    const limit = Date.now() + STAMP_CLAMP_MS
    const patch = (p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch)) ? p.patch : null
    // D6 P2 (2026-09-21) + wave-A + bus-stamps (2026-09-22): future-stamp clamp — legit clock
    // skew is minutes, not years; anything beyond the skew window can only be forgery. Applies
    // to the manifest age field AND deletedAt, at BOTH the top level and inside a nested
    // .patch (tomato.updateById shape), and on every door including preserveStamp callers
    // (preserveStamp means "never MINT a fresh stamp", not "may carry an arbitrary future age").
    const clamped = {}
    if (p[f] != null && Number(p[f]) > limit) clamped[f] = Date.now()
    if (p.deletedAt != null && Number(p.deletedAt) > limit) clamped.deletedAt = Date.now()
    if (patch) {
      const pc = {}
      if (patch[f] != null && Number(patch[f]) > limit) pc[f] = Date.now()
      if (patch.deletedAt != null && Number(patch.deletedAt) > limit) pc.deletedAt = Date.now()
      if (Object.keys(pc).length) clamped.patch = Object.assign({}, patch, pc)
    }
    if (Object.keys(clamped).length) return Object.assign({}, p, clamped)
    if ((p[f] != null && Number(p[f]) > 0) || (patch && patch[f] != null && Number(patch[f]) > 0)) return p
    if (opts.preserveStamp) return p
    return Object.assign({}, p, { [f]: Date.now() })
  }

  /** Machine-local key classification for the row (meta/settings local-key filter). */
  function isLocalKey (row, key) {
    return !!(row && typeof row.localKeys === 'function' && row.localKeys(key))
  }

  /** Resolve + validate; unknown command throws USAGE (never a silent no-op). */
  function resolve (entity, verb) {
    const key = manifestMod.keyOf(entity, verb)
    const row = manifestMod.COMMANDS[key]
    if (!row) throw usageError('unknown command: ' + key)
    return row
  }

  /**
   * The one mutation API. Returns the db op's result (verbatim — the caller-facing contract
   * of each db op is unchanged).
   */
  function commit (entity, verb, payload, opts = {}) {
    const row = resolve(entity, verb)
    if (!row.op) throw usageError('command has no db op: ' + manifestMod.keyOf(entity, verb))
    const p = stampPayload(row, payload, opts)
    const result = dbCall(row.op, p) // oplog capture happens inside db.call — kept as-is
    runHooks({ entity: row.entity, verb: row.verb, row, op: row.op, payload: p, result, opts })
    return result
  }

  /** op-keyed route used by the dbCall alias and pending-queue replay paths. */
  function commitOp (op, payload, opts = {}) {
    const key = manifestMod.OP_TO_COMMAND[op]
    if (!key) throw usageError('op is not a manifest command: ' + String(op))
    const row = manifestMod.COMMANDS[key]
    return commit(row.entity, row.verb, payload, opts)
  }

  /** Non-throwing lookup for routing decisions (null when the op is not a manifest write). */
  function commandForOp (op) {
    return manifestMod.OP_TO_COMMAND[op] || null
  }

  return { commit, commitOp, commandForOp, resolve, stampPayload, isLocalKey, onCommit, offCommit, USAGE }
}

// Default instance: the real db layer. Late-required inside the call wrapper so test files
// that re-init db.js keep working through the same bus.
const bus = createBus((op, params) => require('./db').call(op, params))

module.exports = bus
module.exports.createBus = createBus
module.exports.USAGE = USAGE
module.exports.STAMP_SKEW_MS = STAMP_SKEW_MS // D6 P2 (2026-09-21): exported for tests/gates
