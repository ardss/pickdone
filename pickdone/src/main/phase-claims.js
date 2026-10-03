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
 */

function createPhaseClaims ({ tokenGen } = {}) {
  const claims = new Map() // phase -> token
  const nextToken = tokenGen || (() => Date.now().toString(36) + ':' + Math.random().toString(36).slice(2, 10))
  return {
    /** Compare-and-set: exactly one caller per phase wins; the winner receives its owner token. */
    claim (phase) {
      if (typeof phase !== 'string' || !phase) return { won: false, token: null }
      if (claims.has(phase)) return { won: false, token: null }
      const token = nextToken()
      claims.set(phase, token)
      return { won: true, token }
    },
    /** Owner-checked release: a non-owner (wrong/absent token) can NEVER delete a live claim. */
    release (phase, token) {
      if (!claims.has(phase)) return false
      if (claims.get(phase) !== token) return false
      claims.delete(phase)
      return true
    },
    /** Test/inspection seam. */
    isClaimed (phase) { return claims.has(phase) }
  }
}

// Process-lifetime singleton: the main process is the single writer for every renderer window.
const claims = createPhaseClaims()

module.exports = { createPhaseClaims, claims }
