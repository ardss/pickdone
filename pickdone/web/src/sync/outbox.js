// Offline outbox — pure queue semantics for local mutations made while offline or
// before a flush succeeds. Durability lives in storage.js (IndexedDB 'outbox' store,
// written in the SAME transaction as the row so a reload never loses a change).
// The queue is only drained after a real push+pull convergence cycle succeeds —
// "queued" never silently pretends to be "synced" (mission §09[J5]).

export const QUEUE_STORES = Object.freeze(['tasks', 'projects', 'episodes'])

/** Append one durable mutation. Pure: returns a NEW array. */
export function enqueueMutation(queue, { store, rowId, kind = 'upsert', ts = Date.now(), id }) {
  if (!QUEUE_STORES.includes(store)) throw new Error('Unknown collection: ' + store)
  if (rowId == null || rowId === '') throw new Error('rowId required')
  if (kind !== 'upsert' && kind !== 'delete') throw new Error('Unknown kind: ' + kind)
  return [...(queue || []), { id: id || (crypto.randomUUID?.() || String(ts) + ':' + store + ':' + rowId), store, rowId: String(rowId), kind, ts }]
}

/**
 * Collapse the queue to what actually still needs to reach the desktop:
 * the LATEST op per (store, rowId) wins, surviving ops in chronological order.
 */
export function coalesced(queue) {
  const latest = new Map()
  for (const op of queue || []) {
    latest.set(op.store + ':' + op.rowId, op) // array order == append order == ts order for equal ts
  }
  return [...latest.values()].sort((a, b) => a.ts - b.ts)
}

/** UI badge: pending changes per store after coalescing. */
export function outboxSummary(queue) {
  const byStore = {}
  let total = 0
  for (const op of coalesced(queue)) {
    byStore[op.store] = (byStore[op.store] || 0) + 1
    total += 1
  }
  return { total, byStore }
}
