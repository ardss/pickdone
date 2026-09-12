/** Quit-flush ack handshake state (extracted 2026-09-11 so the handshake is unit-testable — the
 *  wiring in index.js runs inside Electron where no plain-node test can reach it). Pure state
 *  machine: one round per quit attempt, token-guarded so acks from an aborted previous round can
 *  never satisfy the current one, sender-deduped, and "zero live windows" takes the fast path. */
function createQuitAckTracker () {
  let token = 0
  const acked = new Set()
  const abandoned = new Set()
  let expected = 0
  return {
    /** Open a new round; returns the token to broadcast. liveWindows = count of windows we sent to. */
    beginRound (liveWindows, roundToken) {
      token = roundToken
      acked.clear()
      abandoned.clear()
      expected = liveWindows
      return token
    },
    /** Strictly increasing token generator (P2 2026-09-12): Date.now() collides within the same
     *  millisecond, and a colliding stale ack from an aborted round would then pass the token guard
     *  and satisfy the current round prematurely. Max(prev+1, now) guarantees monotonicity. */
    nextToken () {
      token = Math.max(token + 1, Date.now())
      return token
    },
    /** Record an ack; false when stale-token, sender-less, or a duplicate from the same sender. */
    ack (t, senderId) {
      if (t !== token || senderId == null || acked.has(senderId)) return false
      acked.add(senderId)
      return true
    },
    /** P2 2026-09-12: a window destroyed between the send and its ack can never ack — without this
     *  the quit path waited out the full 2s cap every time the window closed mid-handshake. Drops the
     *  sender from the expected count (idempotent; a sender that already acked is a no-op, since its
     *  ack is what satisfies allAcked). Returns true when expected was actually decremented. */
    abandon (senderId) {
      if (senderId == null || abandoned.has(senderId)) return false
      abandoned.add(senderId)
      if (acked.has(senderId)) return false
      expected = Math.max(0, expected - 1)
      return true
    },
    /** True when nobody was expected (fast path) or every live window has acked. */
    allAcked () { return expected === 0 || acked.size >= expected },
    progress () { return acked.size + '/' + expected }
  }
}

module.exports = { createQuitAckTracker }
