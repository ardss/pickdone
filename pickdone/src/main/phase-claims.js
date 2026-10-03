'use strict'

/**
 * TQ-3 (2026-10-03) — main-process compare-and-set phase claims.
 *
 * Root removed: cross-window phase claiming was a non-atomic localStorage check-then-set
 * (claimPhase: getItem → compare → setItem on shared-origin LS) with an OWNERLESS claim value.
 * Two same-origin renderer processes (main window + float window) race the same completion
 * transition: both could pass the check and win, and worse, a contender's release-on-failure
 * path (releaseClaim deleted by VALUE equality) could delete the OWNER's live claim, reopening
 * the door to a double-completion of the same phase.
 *
 * The claim store now lives in the single-writer process: claim() is a Map.has → set CAS in the
 * main process (IPC is serialized per process, so the check-and-set is atomic), and every claim
 * carries a unique owner TOKEN — release() only deletes when the presented token matches, so a
 * contender can never release a claim it does not own. Invariant: at most one claimer per phase,
 * and only the claim owner can release. Class-complete: all three completion transitions funnel
 * through one claimPhase wrapper in the store, so one store serves every claim call site.
 *
 * Plain-node testable via the factory; handlers/tomato.js uses the module singleton.
 *
 * C1+C9 (2026-10-02) hardening, both rooted in the same unbounded-claims Map:
 *  - C1: a renderer crash between claim and release permanently blocked that completion
 *    phase (completeFocus/finishRest dead until restart). Root fix: every claim is a
 *    TIME-BOXED LEASE — the whole point of the claim is to serialize side effects that
 *    happen within one tick (snow gain + notification + DB write), so a short lease
 *    (CLAIM_TTL_MS) auto-expires a claim whose owner died before releasing. A live owner
 *    never observes the expiry: its release path runs inside the tick, and a re-claim after
 *    expiry carries a fresh startedAt anyway (Date.now() never repeats).
 *  - C9: arbitrary phase strings grew the Map without limit. Root fix: whitelist the exact
 *    claim shapes the single funnel (renderer claimPhase: status + ':' + startedAt) produces —
 *    'startTomatoTime:<ms>' and 'startRestTime:<ms>' — everything else is rejected {won:false}
 *    and never enters the Map. One gate, class-complete.
 */

// Lease TTL: completion side effects (release included) happen synchronously within one tick
// of the claim; 30s is orders of magnitude beyond any legitimate hold. Injectable for tests.
const CLAIM_TTL_MS = 30 * 1000
// The only legitimate phase prefixes (see renderer/js/store/tomato.js claimPhase).
const CLAIM_PHASE_RE = /^(startTomatoTime|startRestTime):\d+$/

function createPhaseClaims ({ tokenGen, ttlMs = CLAIM_TTL_MS, now = Date.now } = {}) {
  const claims = new Map() // phase -> { token, expiresAt }
  const nextToken = tokenGen || (() => Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10))
  /** Lazily drop an expired lease so claim/isClaimed/release all see the same truth. */
  const live = (phase) => {
    const entry = claims.get(phase)
    if (!entry) return false
    if (now() >= entry.expiresAt) { claims.delete(phase); return false }
    return true
  }
  return {
    /** Compare-and-set: exactly one caller per phase wins; the winner receives its owner token.
     *  The claim is a lease — it expires after ttlMs even if the owner never releases (crash). */
    claim (phase) {
      if (typeof phase !== 'string' || !CLAIM_PHASE_RE.test(phase)) return { won: false, token: null }
      if (live(phase)) return { won: false, token: null }
      const token = nextToken()
      claims.set(phase, { token, expiresAt: now() + ttlMs })
      return { won: true, token }
    },
    /** Owner-checked release: a non-owner (wrong/absent token) can NEVER delete a live claim.
     *  An expired lease reads as already-released (false) — the owner's side effects are long gone. */
    release (phase, token) {
      if (!live(phase)) return false
      if (claims.get(phase).token !== token) return false
      claims.delete(phase)
      return true
    },
    /** Test/inspection seam (expiry-aware). */
    isClaimed (phase) { return live(phase) }
  }
}

// Process-lifetime singleton: the main process is the single writer for every renderer window.
const claims = createPhaseClaims()

module.exports = { createPhaseClaims, claims, CLAIM_TTL_MS }
