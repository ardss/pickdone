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
 *  main build that doesn't stamp op) we reload conservatively — both refreshes are cheap.
 *
 *  COORDINATION NOTE (D15-B13): main.js still gates the parsed kinds on the lan-sync-apply flag
 *  (`kinds: _todosChangedSyncApply ? _todosChangedKinds : null`), so for a plain setMeta broadcast
 *  the reloader receives kinds=null and keeps the conservative reload. Once main.js passes
 *  `_todosChangedKinds` unconditionally (safe: kindsFromChangedEvent returns null for kind-less
 *  events), the normalizeRoundKinds gate below engages and aux windows stop paying the full
 *  todo/init per debounced meta write. Owner of renderer/js/main.js to apply that one line. */

/** D15-B13 (2026-10-03): main-process op → round-kind normalization. The main handler broadcasts
 *  setMeta writes with reason/op 'setMeta' (handlers/todo.js:230) — a META-table-only write. The
 *  renderer's cheap-kind gate below only knows the round kinds ('meta' | 'filter' | 'category'),
 *  so an unnormalized 'setMeta' read as an unknown = data kind and every receiving window paid a
 *  FULL todo/init (getAll + computeViews + critical backup + historyClear) per ~2s-debounced
 *  settings/habits mirror write — exactly the reload storm the main-process comment at
 *  handlers/todo.js:224 deliberately killed on its side. Mapping the op to its cheap kind HERE is
 *  the renderer half of that same root fix. */
const OP_KIND_MAP = { setMeta: 'meta', setMetaMany: 'meta', deleteMeta: 'meta' }
export function normalizeRoundKinds (kinds) {
  if (!kinds) return null
  const out = kinds.map(k => OP_KIND_MAP[k] || k)
  return out.length ? out : null
}

/** Parse the op field of a todos-changed event into a kind list (null when absent/empty).
 *  D15-B13: the op-stamp fallback is the event's `reason` — the setMeta early-return broadcast
 *  carries reason='setMeta' WITHOUT an op field, so parsing op only made every meta round look
 *  kind-less (kinds=null) and forced the conservative full reload. Unknown reasons
 *  ('external-db-write', 'purgeRecycleBin', …) stay unknown data kinds = conservative reload. */
export function kindsFromChangedEvent (evt) {
  const op = evt && typeof evt.op === 'string' && evt.op.trim() !== '' ? evt.op : (evt && typeof evt.reason === 'string' ? evt.reason : '')
  const kinds = op.split(',').map(s => s.trim()).filter(Boolean)
  return kinds.length ? kinds : null
}

/** D15-B10 (2026-10-03): the sidebar's placeholder tags ('userTags' DB meta key) had NO inbound
 *  refresh path — the only reader seeded them once at mounted time, so a CLI/peer tag edit never
 *  reached a running app. This default reloader mirrors how estimates re-load on meta rounds: one
 *  read + one commit at the single dispatch site (the meta-round branch below), not a per-consumer
 *  patch. Injectable for tests like reloadEstimates. */
function defaultReloadUserTags (store) {
  if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return Promise.resolve()
  return Promise.resolve(window.todoAPI.dbCall('getMeta', 'userTags')).then(v => {
    let list = null
    try { list = JSON.parse(v || 'null') } catch (e) { list = null }
    if (Array.isArray(list)) store.commit('ui/setUserTags', list)
  }).catch(() => {})
}

/** Build the debounced reload function used by main.js's todos-changed handler.
 *  store: Vuex store (dispatch); reloadEstimates: async fn re-running tomatoEstimate.initFromDb
 *  (injected so tests can stub it); reloadUserTags: async fn re-reading the 'userTags' meta key
 *  (defaults to defaultReloadUserTags above); now: clock injection for the throttle. */
export function createExternalReloader ({ store, reloadEstimates = () => Promise.resolve(), reloadUserTags = null, now = () => Date.now() } = {}) {
  let lastEstimateRefreshAt = 0
  return function reloadExternal ({ preserveHistory = false, kinds = null } = {}) {
    kinds = normalizeRoundKinds(kinds)
    // P1-2 (2026-09-19): LAN-sync-applied rounds reload via the non-clearing variant so the
    // user's own undo stack survives; CLI/watcher external writes keep the clearing behavior.
    // Perf kind-gating: todo/init is the full-table getAll + computeViews + critical backup,
    // so rounds whose kinds are all in the non-todo set (meta / filter / category) must not
    // pay for it. Unknown kinds stay conservative (full reload); null kinds (CLI external
    // write, older main build, non-sync events) keep the full conservative reload.
    const hasDataKind = !kinds || kinds.some(k => k !== 'meta' && k !== 'filter' && k !== 'category')
    if (hasDataKind) store.dispatch('todo/init', preserveHistory ? { preserveHistory: true } : undefined).catch(() => {})
    // CLI can write categories too — keep them appearing without a restart (category rounds only).
    if (!kinds || kinds.includes('category')) store.dispatch('category/init').catch(() => {})
    // F1a: inbound filter rounds previously needed an app restart for new smart lists to show.
    // Absent kinds → reload (cheap, conservative).
    if (!kinds || kinds.includes('filter')) store.dispatch('filters/load').catch(() => {})
    // F1b: peer-written tomato estimates live in the DB meta ledger — refresh on meta rounds.
    // D15-B10: the 'userTags' placeholder-tag ledger rides the SAME meta rounds + throttle.
    if (!kinds || kinds.includes('meta')) {
      const t = now()
      if (t - lastEstimateRefreshAt >= 1000) {
        lastEstimateRefreshAt = t
        Promise.resolve().then(reloadEstimates).catch(() => {})
        Promise.resolve().then(() => (reloadUserTags || defaultReloadUserTags)(store)).catch(() => {})
      }
    }
  }
}
