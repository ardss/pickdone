'use strict'

// Only the live app's relay-sync command response proves what THIS sync round
// quarantined. A newly launched CLI's in-memory status counter can be zero.
function createRoundEvidence () {
  const rounds = { a: [], b: [] }
  return {
    record (which, envelope) {
      if (!Object.hasOwn(rounds, which)) throw new Error('unknown relay device: ' + which)
      const r = envelope && (envelope.data || envelope.result || envelope)
      if (!r || r.ok !== true) throw new Error('device ' + which + ' sync round not successful')
      if (!Number.isSafeInteger(r.quarantined) || r.quarantined < 0) {
        throw new Error('device ' + which + ' missing numeric quarantined in same-round result')
      }
      rounds[which].push({ quarantined: r.quarantined, cursor: r.cursor })
      if (r.quarantined !== 0) throw new Error('device ' + which + ' quarantined=' + r.quarantined + ' in actual sync round')
      return r
    },
    assertClean () {
      for (const which of ['a', 'b']) {
        if (!rounds[which].length) throw new Error('device ' + which + ' has no observed sync round')
        const bad = rounds[which].find(r => r.quarantined !== 0)
        if (bad) throw new Error('device ' + which + ' quarantined=' + bad.quarantined + ' in observed round')
      }
      return { a: rounds.a.length, b: rounds.b.length }
    },
  }
}
function assertDistinctDeviceIds (a, b) {
  const x = a && a.nodeId
  const y = b && b.nodeId
  if (typeof x !== 'string' || !x || typeof y !== 'string' || !y) {
    throw new Error('missing nodeId for one or both relay devices')
  }
  if (x === y) throw new Error('relay devices must have distinct nodeId values')
}
module.exports = { createRoundEvidence, assertDistinctDeviceIds }
