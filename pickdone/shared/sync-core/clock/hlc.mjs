/**
 * PickDone sync-core v2: Hybrid Logical Clock (sync-v2 spec §6, design doc step 4).
 *
 * A wall clock cannot be a sync version: it can roll back, jump, or freeze, and two
 * devices can never agree on "now". The HLC gives every revision a timestamp that is
 * (a) monotone per device regardless of wall-clock behavior, (b) advanced by every
 * received remote timestamp so causality flows through sync, and (c) totally ordered
 * via (physical, logical, nodeId) with a stable tie-break.
 *
 * Rules (all enforced here, tested in tests/unit/sync/hlc.test.mjs):
 *   1. local event:  now > physical -> physical = now, logical = 0; else logical++
 *   2. receive R:    physical' = max(now, physical, R.physical); logical resets to 0
 *                    iff physical advanced, else max(logical, R.logical) + 1
 *   3. wall-clock rollback can never lower the HLC (follows from 1 and 2)
 *   4. total order: (physical, logical, nodeId) — nodeId is the deviceId, stable
 *   5. persistence: the caller persists `snapshot()` and restores via `restore()`;
 *      restoring a state whose physical is in the future (crash lost counter bumps)
 *      adopts the stored physical with logical+1, never goes backwards
 *   6. Date.now() is called ONLY here — nowhere else in sync code
 */

/** Comparison key of an HLC stamp: {physical, logical, nodeId}. */
export function cmpHlc(a, b) {
  if (a.physical !== b.physical) return a.physical < b.physical ? -1 : 1
  if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1
  return 0
}

export function hlcEq(a, b) {
  return cmpHlc(a, b) === 0
}

/** Deterministic "later wins" — the only LWW primitive allowed in v2 merge. */
export function hlcMax(a, b) {
  return cmpHlc(a, b) >= 0 ? a : b
}

/**
 * A Hybrid Logical Clock bound to one device.
 * @param {string} nodeId stable device identity (tie-break, never empty)
 * @param {object} [opts]
 * @param {() => number} [opts.now] wall clock injection (tests); default Date.now
 */
export class Hlc {
  constructor(nodeId, opts = {}) {
    if (!nodeId || typeof nodeId !== 'string') throw new Error('hlc: nodeId required')
    this.nodeId = nodeId
    this._now = opts.now || Date.now
    // Initialize at zero, NOT at the wall clock: reading Date.now() here would burn
    // the first event's logical=0 slot and (worse) give restore() a wrong baseline.
    // The wall clock is only sampled inside tick()/receive() — real events.
    this.physical = 0
    this.logical = 0
  }

  /** Restore persisted state (rule 5). Safe against future-dated saves and
   *  against corrupted/non-positive snapshots (a negative physical would break
   *  revisionId sorting — ignore instead of adopting). */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return this
    const p = Number(snapshot.physical) || 0
    const l = Math.max(0, Number(snapshot.logical) || 0)
    if (!(p > 0)) return this
    if (p > this.physical) {
      this.physical = p
      this.logical = l + 1 // adopt future physical, guarantee forward progress
    } else if (p === this.physical && l >= this.logical) {
      this.logical = l + 1
    }
    return this
  }

  /** Local event: strictly newer than every stamp this clock ever produced. */
  tick() {
    const now = this._now()
    if (now > this.physical) {
      this.physical = now
      this.logical = 0
    } else {
      this.logical += 1
    }
    this._fence()
    return this.stamp()
  }

  /** Receive a remote stamp: result is strictly newer than BOTH this clock's last
   *  output and the remote stamp (rule 2) — this is how causality crosses devices. */
  receive(remote) {
    if (!remote || typeof remote.physical !== 'number') throw new Error('hlc: remote stamp required')
    const now = this._now()
    const maxPhys = Math.max(now, this.physical, remote.physical)
    if (maxPhys > this.physical && maxPhys > remote.physical) {
      this.physical = maxPhys
      this.logical = 0
    } else if (maxPhys === this.physical && maxPhys === remote.physical) {
      this.logical = Math.max(this.logical, remote.logical) + 1
    } else if (maxPhys === remote.physical) {
      this.physical = maxPhys
      this.logical = remote.logical + 1
    } else {
      // remote is older than our current physical and the wall clock has not advanced:
      // bump logical so the result is still strictly newer than our own last stamp
      this.physical = maxPhys
      this.logical = this.logical + 1
    }
    this._fence()
    return this.stamp()
  }

  /** revisionId encodes logical in 6 digits: overflow would silently break the sort
   *  order, so instead roll the physical forward (monotonicity preserved, ordering
   *  stays lexicographic). A device doing a million same-ms events is pathological
   *  but must not corrupt the id space. */
  _fence() {
    if (this.logical >= 1000000) {
      this.physical += 1
      this.logical = 0
    }
  }

  stamp() {
    return { physical: this.physical, logical: this.logical, nodeId: this.nodeId }
  }

  snapshot() {
    return { physical: this.physical, logical: this.logical }
  }
}

/**
 * Revision identity: encode an HLC stamp into a sortable string id.
 * Zero-padded physical (ms until year 2286) + logical + nodeId — lexicographic
 * order equals cmpHlc order for the same nodeId space, and the id doubles as the
 * store key (spec §3.1 revisionId).
 */
export function revisionIdFrom(hlc) {
  const phys = String(hlc.physical).padStart(14, '0')
  const log = String(hlc.logical).padStart(6, '0')
  return `r${phys}${log}${hlc.nodeId}`
}
