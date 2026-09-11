/** Quit-flush ack handshake state (extracted 2026-09-11 so the handshake is unit-testable — the
 *  wiring in index.js runs inside Electron where no plain-node test can reach it). Pure state
 *  machine: one round per quit attempt, token-guarded so acks from an aborted previous round can
 *  never satisfy the current one, sender-deduped, and "zero live windows" takes the fast path. */
function createQuitAckTracker () {
  let token = 0
  const acked = new Set()
  let expected = 0
  return {
    /** Open a new round; returns the token to broadcast. liveWindows = count of windows we sent to. */
    beginRound (liveWindows, roundToken) {
      token = roundToken
      acked.clear()
      expected = liveWindows
      return token
    },
    /** Record an ack; false when stale-token, sender-less, or a duplicate from the same sender. */
    ack (t, senderId) {
      if (t !== token || senderId == null || acked.has(senderId)) return false
      acked.add(senderId)
      return true
    },
    /** True when nobody was expected (fast path) or every live window has acked. */
    allAcked () { return expected === 0 || acked.size >= expected },
    progress () { return acked.size + '/' + expected }
  }
}

module.exports = { createQuitAckTracker }
