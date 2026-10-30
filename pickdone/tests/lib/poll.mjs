/**
 * expect.poll-style predicate polling (2026-10-25, mainstream-alignment goal).
 *
 * One shared polling primitive for every "wait until observable" case in the suite —
 * replaces the per-file hand-rolled `for (;;) { if (pred) break; sleep(ms) }` loops
 * (d9-drill-helpers.waitFor, the load-budget predicate polls, e2e boot waits). The
 * shape mirrors vitest's expect.poll / jest's wait-for-expect contract: a value-returning
 * (or throwing) probe, a budget, an interval, a label for the timeout message.
 *
 * Semantics: `probe` is invoked immediately, then every `intervalMs` until it returns a
 * truthy value or the budget expires. A probe THROW counts as "not yet" (its message is
 * kept for the timeout error); a probe returning a value ends the poll with that value.
 * This is NOT a fake-timer abstraction — probes run on the real event loop, which is what
 * the suite's live IPC/process/socket probes need (fake timers are for pure-timer tests).
 *
 * @template T
 * @param {() => T} probe value-returning or throwing probe
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [o]
 * @returns {Promise<T>} the probe's truthy result
 */
export async function pollUntil (probe, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  for (;;) {
    let v
    try {
      v = await probe()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    if (Date.now() > deadline) {
      const tail = lastErr ? ' — last probe error: ' + (lastErr && lastErr.message || lastErr) : ''
      throw new Error(`pollUntil timeout after ${timeoutMs}ms waiting for: ${label}${tail}`)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
}
