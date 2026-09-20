/** External-write reload pipeline (2026-09-20, sync UI visibility round).
 *
 *  Extracted from main.js so the inbound reload path is unit-testable. The old
 *  `_reloadExternal` only refreshed todo/init + category/init, which left two classes of
 *  inbound data invisible until restart:
 *    - saved filters (smart lists) synced via the 'filter' round kind
 *    - tomato estimates written by a peer into the meta ledger ('meta' kind)
 *  This helper re-dispatches filters/load when the round kind includes (or omits) 'filter',
 *  and re-runs utils/tomatoEstimate.js initFromDb on meta rounds (throttled to 1s — bursts of
 *  rounds must not spam the meta read; tomatoEstimate's state is reactive so the EditPanel and
 *  TodoItem estimate pills re-render as soon as initFromDb applies newer values).
 *
 *  Round kinds come from the main process 'todos-changed' broadcast (reason 'lan-sync-apply',
 *  op = comma-joined round.kinds). When kinds are absent (plain CLI external write, or an older
 *  main build that doesn't stamp op) we reload conservatively — both refreshes are cheap. */

/** Parse the op field of a todos-changed event into a kind list (null when absent/empty). */
export function kindsFromChangedEvent (evt) {
  const op = evt && typeof evt.op === 'string' ? evt.op : ''
  const kinds = op.split(',').map(s => s.trim()).filter(Boolean)
  return kinds.length ? kinds : null
}

/** Build the debounced reload function used by main.js's todos-changed handler.
 *  store: Vuex store (dispatch); reloadEstimates: async fn re-running tomatoEstimate.initFromDb
 *  (injected so tests can stub it); now: clock injection for the throttle. */
export function createExternalReloader ({ store, reloadEstimates = () => Promise.resolve(), now = () => Date.now() } = {}) {
  let lastEstimateRefreshAt = 0
  return function reloadExternal ({ preserveHistory = false, kinds = null } = {}) {
    // P1-2 (2026-09-19): LAN-sync-applied rounds reload via the non-clearing variant so the
    // user's own undo stack survives; CLI/watcher external writes keep the clearing behavior.
    store.dispatch('todo/init', preserveHistory ? { preserveHistory: true } : undefined).catch(() => {})
    // CLI can write categories too — keep them appearing without a restart.
    store.dispatch('category/init').catch(() => {})
    // F1a: inbound filter rounds previously needed an app restart for new smart lists to show.
    // Absent kinds → reload (cheap, conservative).
    if (!kinds || kinds.includes('filter')) store.dispatch('filters/load').catch(() => {})
    // F1b: peer-written tomato estimates live in the DB meta ledger — refresh on meta rounds.
    if (!kinds || kinds.includes('meta')) {
      const t = now()
      if (t - lastEstimateRefreshAt >= 1000) {
        lastEstimateRefreshAt = t
        Promise.resolve().then(reloadEstimates).catch(() => {})
      }
    }
  }
}
