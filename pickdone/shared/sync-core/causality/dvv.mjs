/**
 * Dotted version vectors for opt-in causal reconciliation.
 * This is an envelope-level causal context, not a wall-clock ordering.
 * Legacy envelopes without DVV deliberately return 'unknown'.
 */
function expand(envelope) {
  const dvv = envelope?.dvv
  const dot = dvv?.dot
  if (!dot || typeof dot.deviceId !== 'string' || !dot.deviceId || !Number.isSafeInteger(dot.counter) || dot.counter < 1) return null
  const context = dvv.context
  if (!context || Array.isArray(context) || typeof context !== 'object') return null
  const vector = new Map()
  for (const [device, counter] of Object.entries(context)) {
    if (!device || !Number.isSafeInteger(counter) || counter < 0) return null
    vector.set(device, counter)
  }
  // A valid dot advances beyond the author's previous observed sequence.
  if ((vector.get(dot.deviceId) || 0) >= dot.counter) return null
  vector.set(dot.deviceId, dot.counter)
  return vector
}
function covers(a, b) {
  for (const [device, counter] of b) {
    if ((a.get(device) || 0) < counter) return false
  }
  return true
}
/** Candidate relative to current: descendant, ancestor, concurrent, equal or unknown. */
export function dvvRelation(candidate, current) {
  const a = expand(candidate)
  const b = expand(current)
  if (!a || !b) return 'unknown'
  const ab = covers(a, b)
  const ba = covers(b, a)
  if (ab && !ba) return 'descendant'
  if (ba && !ab) return 'ancestor'
  return ab && ba ? 'equal' : 'concurrent'
}
/** Mint a local context covering all known parent dots (conflict heads included). */
export function localDvv(store, parentIds) {
  const context = Object.create(null)
  for (const id of parentIds) {
    const v = expand(store.revisions.get(id))
    if (!v) continue
    for (const [device, counter] of v) context[device] = Math.max(context[device] || 0, counter)
  }
  const count = Math.max(store.localDvvCounter || 0, context[store.nodeId] || 0) + 1
  store.localDvvCounter = count
  return { dot: { deviceId: store.nodeId, counter: count }, context: { ...context } }
}
/** Never reuse a dot already observed for this device after importing snapshots. */
export function observeDvv(store, envelope) {
  const vector = expand(envelope)
  if (vector) store.localDvvCounter = Math.max(store.localDvvCounter || 0, vector.get(store.nodeId) || 0)
}
