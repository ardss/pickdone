/** Tomato estimate — task-level "estimated tomato rounds" storage (dual write to localStorage + main DB meta, same pattern as habits).
 *  Actual rounds are not stored here (attributed from tomatoRecordList by focusTaskId).
 *  reactive: after EditPanel changes the estimate, the inline pill on TodoItem rows updates in the same frame.
 *  Cross-end consistency (2026-09-03 root fix): CLI setEstimate writes meta but not LS — the old version read LS only at startup, so the CLI's meta write would be
 *  overwritten by this module's next persist using stale LS (CLI-estimated tomatoes silently lost on desktop). Now a separate timestamp key decides the winner:
 *  initFromDb backfills at startup, whoever is newer wins; the CLI side (lib.setEstimate) writes the timestamp synchronously. */
// This architecture has no bundler: under Electron (app://) the bare module name 'vue' can't be resolved (once blanked the whole page), so the UMD global is used uniformly.
// When window.Vue is missing (e.g. node unit tests importing this module through the store chain), degrade to a plain object — the store only reads getEstimate, no reactivity needed
const { reactive } = (typeof window !== 'undefined' && window.Vue) || { reactive: o => o }

const LS_KEY = 'tomatoEstimateState'
const TS_KEY = 'tomatoEstimateStateAt'
const MIN = 0
const MAX = 20
// Y (sync-coverage-2): per-task meta keys `tomatoEstimateState:<taskId>` — the whole-map blob meta was
// whole-key LWW, so two devices editing different tasks' estimates clobbered each other. Per-task
// keys sync field-granular via the meta entity. The LS blob stays as the reactive cache; the DB
// blob meta is legacy (lazy-migrated to per-task keys, then deleted; fallback read remains).

function load () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    if (d && typeof d === 'object' && !Array.isArray(d)) return d
  } catch (e) /* empty */ { }
  return {}
}

const state = reactive(load())

const PER_TASK_PREFIX = 'tomatoEstimateState:'
const keyOf = taskId => PER_TASK_PREFIX + taskId

function persist () {
  const now = String(Date.now())
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
    localStorage.setItem(TS_KEY, now)
  } catch (e) { /* ignore quota exceeded */ }
}

/** Y: per-task meta write (the syncable unit). n <= 0 removes the key.
 *  U-3 (2026-09-20): returns a promise resolving true/false so the lazy migration can tell whether the
 *  fan-out actually landed (the old fire-and-forget let a failed write still delete the legacy blob). */
function persistTask (taskId, n) {
  const done = async () => {
    if (!window.todoAPI || !window.todoAPI.dbCall) return false
    try {
      if (n > 0) {
        // 2026-09-12: silent .catch(() => {}) hid meta write failures — log them (same as before).
        await window.todoAPI.dbCall('setMeta', [keyOf(taskId), String(n)])
      } else {
        await window.todoAPI.dbCall('deleteMeta', keyOf(taskId))
      }
      return true
    } catch (e) {
      console.error('[tomatoEstimate] persistTask(%s) failed:', keyOf(taskId), e)
      return false
    }
  }
  const p = done()
  p.catch(() => {}) // never a floating rejection; callers await the resolved boolean
  return p
}

/** Startup backfill (Y rework / U8 lazy rework): only the legacy-blob pass (timestamped whole-map
 *  meta, timestamp decides the winner) still runs at boot. Per-task keys `tomatoEstimateState:<taskId>`
 *  are NO LONGER scanned for every known id (that was O(N) sequential getMeta per boot and per
 *  inbound meta round) — they are read on demand via ensureEstimate() (memoized; invalidated by
 *  meta rounds). Also performs the one-time lazy migration: blob entries are emitted as per-task
 *  keys and the legacy DB blob is deleted (the LS blob stays as the reactive cache). */
export async function initFromDb (taskIds) {
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return
    const lsAt = Number(localStorage.getItem(TS_KEY)) || 0
    const [metaRaw, metaAt] = await Promise.all([
      window.todoAPI.dbCall('getMeta', LS_KEY),
      window.todoAPI.dbCall('getMeta', TS_KEY)
    ])
    const metaAtN = Number(metaAt) || 0
    const parsed = JSON.parse(metaRaw || 'null')
    // D5 (2026-09-20): strict `<` — an exact tie between meta and LS stamps favors CLI/meta per the
    // "newer wins" contract (the CLI writes its timestamp synchronously; the LS write of the same
    // change lands in the same tick, and `<=` used to let the stale LS side win the tie).
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && metaAtN >= lsAt) {
      for (const k of Object.keys(state)) delete state[k]
      for (const [k, v] of Object.entries(parsed)) {
        if (k === '_savedAt') continue
        state[k] = v
      }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state))
        localStorage.setItem(TS_KEY, String(metaAtN))
      } catch (e) { /* ignore */ }
      // Lazy migration: emit per-task keys for every blob entry (NEVER overwriting a per-task key
      // that already exists — the field-granular unit is authoritative once present), then delete
      // the legacy DB blob. U-3 (2026-09-20): the delete is now gated on EVERY fan-out write
      // succeeding — a failed setMeta used to still delete the blob, silently losing that task's
      // estimate (the per-task key never landed). On any failure the blob is kept and migration
      // retries on the next boot.
      try {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const results = []
          for (const [k, v] of Object.entries(parsed)) {
            if (k === '_savedAt') continue
            try {
              const existing = await window.todoAPI.dbCall('getMeta', keyOf(k))
              if (existing !== null && existing !== undefined && existing !== '') { results.push(true); continue }
            } catch (e) { /* treat as absent */ }
            results.push(await persistTask(k, Number(v) || 0))
          }
          if (results.length && results.every(Boolean)) {
            await window.todoAPI.dbCall('deleteMeta', LS_KEY)
            await window.todoAPI.dbCall('deleteMeta', TS_KEY)
          } else {
            console.warn('[tomatoEstimate] lazy migration incomplete — legacy blob kept for next-boot retry')
          }
        }
      } catch (e) { /* best-effort: legacy fallback read still works */ }
    }
    // U8 (2026-09-20): the per-task union used to getMeta EVERY known task id at boot and again on
    // every inbound meta round (O(N) sequential reads per round). That scan is gone — per-task keys
    // are read lazily via ensureEstimate() (memoized read-through) when a UI surface actually needs
    // a value. Only the legacy blob fallback below still runs at init.
    invalidateEstimateCache()
  } catch (e) { /* No DB host (5175 shim): degrade silently */ }
}

/** U8 lazy read-through cache: per-task meta keys are fetched on demand (first UI read of an id),
 *  memoized in `fetched`, and invalidated in bulk when inbound meta rounds land (next read
 *  re-fetches once). Keeps boot O(1) meta reads instead of O(N) per known task id. */
const fetched = new Set()
let fetchInflight = new Map()
export function invalidateEstimateCache () { fetched.clear(); fetchInflight = new Map() }

/** U-6 (2026-09-20): listeners notified when a lazy ensureEstimate fetch lands a value. The todoBox
 *  difficulty sort reads getEstimate during computeViews; a value arriving AFTER the sort ran used to
 *  leave the order stale until some unrelated rebuild. main.js registers a callback that dispatches
 *  todo/computeViews so the order corrects once the async fetch lands. */
const fetchedListeners = new Set()
export function onEstimateFetched (fn) {
  if (typeof fn === 'function') fetchedListeners.add(fn)
  return () => fetchedListeners.delete(fn)
}
export function ensureEstimate (taskId) {
  if (!taskId || fetched.has(taskId)) return
  if (!window.todoAPI || !window.todoAPI.dbCall) return
  if (fetchInflight.has(taskId)) return fetchInflight.get(taskId)
  const p = (async () => {
    fetched.add(taskId) // memoized even on failure: a flaky read must not turn into an infinite retry loop
    try {
      const raw = await window.todoAPI.dbCall('getMeta', keyOf(taskId))
      if (raw === null || raw === undefined || raw === '') return
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      const clamped = Math.max(MIN, Math.min(MAX, Math.round(n)))
      if (clamped > 0) state[taskId] = clamped
      else delete state[taskId]
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch (e) { /* ignore */ }
      // U-6: a value landed asynchronously — views sorted by difficulty may be stale; notify listeners
      for (const fn of fetchedListeners) { try { fn(taskId, clamped) } catch (e) { /* listener must not break the fetch */ } }
    } catch (e) { /* absent is fine */ }
  })()
  fetchInflight.set(taskId, p)
  p.finally(() => fetchInflight.delete(taskId))
  return p
}

export function getEstimate (taskId) { return state[taskId] || 0 }

/** Test seam: the reactive map is module-private; behavior tests seed/inspect it through here. */
export const _testInternals = { state, get MAX_KEYS () { return MAX_KEYS } }

/** Capacity bound for the estimate map (H2 2026-09-16): the map used to grow forever — tasks purged
 *  via the recycle bin left their keys behind and a recycled numeric id could resurrect a stale
 *  estimate. Main-process MetaGC (src/main/index.js) owns the DB-meta cleanup; this module bounds
 *  its own state. Callers that know the live id set should use pruneEstimates. */
const MAX_KEYS = 5000

/** Drop every estimate whose taskId is not in `aliveIds` (task purge/merge callers). Returns true
 *  when anything was removed (state changed). */
export function pruneEstimates (aliveIds) {
  const alive = new Set(aliveIds || [])
  let removed = 0
  for (const k of Object.keys(state)) {
    if (!alive.has(k)) { delete state[k]; removed++ }
  }
  if (removed) persist()
  return removed > 0
}

/** Keep the map bounded: drop the oldest entries (insertion order) once over capacity.
 *  U-7 (2026-09-20): evicted ids also get their per-task meta key deleted — the mirror was trimmed but
 *  the DB keys stayed behind, so a recycled id could resurrect a stale estimate from meta. */
function trimToCapacity () {
  const keys = Object.keys(state)
  for (let i = 0; i < keys.length - MAX_KEYS; i++) {
    const evicted = keys[i]
    delete state[evicted]
    try { persistTask(evicted, 0) } catch (e) { /* best-effort: MetaGC covers the DB side */ }
  }
}

export function setEstimate (taskId, n) {
  if (!taskId) return
  n = Math.max(MIN, Math.min(MAX, Math.round(n || 0)))
  if (n > 0) state[taskId] = n
  else delete state[taskId]
  fetched.add(taskId) // U8: the local write is authoritative — no re-fetch needed for this id
  trimToCapacity()
  persist()
  persistTask(taskId, n) // Y: per-task meta key — the field-granular syncable unit
}
