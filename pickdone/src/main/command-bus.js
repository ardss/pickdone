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
 *      already-set field;
 *   3. dispatch to the existing tested db op — oplog capture stays where it is today
 *      (db.call appends it), so the wire/on-disk protocol is untouched;
 *   4. run post-commit fanout hooks in registration order. Subscribers (LS-mirror notice,
 *      undo-barrier notice) observe the commit — they are never second writers.
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
   * - row.lwwField set and payload is a plain object lacking the field (or opts.preserveStamp
   *   is falsy and the field is absent) → stamp Date.now() (the bus owns the age);
   * - the payload already carries an explicit age (sync-apply internal use) → preserved as-is,
   *   UNLESS it lies about the future: D6 P2 (2026-09-21) clamp — an explicit stamp more than
   *   STAMP_SKEW_MS ahead of local now is treated as forged (a compromised renderer could stick
   *   a year-2100 stamp on a row via the IPC door and win LWW forever). Clamped to local now.
   * - opts.preserveStamp = true → never touched.
   * NON-PLAIN payloads (arrays like setMeta ['k','v'] / tomatoAppendMany rows, bare string
   * keys, scalars) pass through VERBATIM — those ops derive their stamps inside the db layer
   * and reshaping them would corrupt the call contract.
   * Payload is never mutated in place — callers may hold reactive rows.
   */
  function stampPayload (row, payload, opts = {}) {
    if (!row.lwwField) return payload
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload
    const hasExplicit = payload[row.lwwField] != null && Number(payload[row.lwwField]) > 0
    if (hasExplicit) {
      // D6 P2 (2026-09-21): future-stamp clamp. Legit clock skew is minutes, not years; anything
      // beyond the skew window can only be forgery (preserveStamp callers are main-process and
      // carry peer ages <= their own now + skew by construction).
      if (Number(payload[row.lwwField]) > Date.now() + STAMP_CLAMP_MS) {
        return Object.assign({}, payload, { [row.lwwField]: Date.now() })
      }
      return payload
    }
    if (opts.preserveStamp) return payload
    return Object.assign({}, payload, { [row.lwwField]: Date.now() })
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
