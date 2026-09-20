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
// Y (sync-coverage-2): per-task meta keys `tomatoEstimate:<taskId>` — the whole-map blob meta was
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

const PER_TASK_PREFIX = 'tomatoEstimate:'
const keyOf = taskId => PER_TASK_PREFIX + taskId

function persist () {
  const now = String(Date.now())
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
    localStorage.setItem(TS_KEY, now)
  } catch (e) { /* ignore quota exceeded */ }
}

/** Y: per-task meta write (the syncable unit). n <= 0 removes the key. */
function persistTask (taskId, n) {
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return
    if (n > 0) {
      // 2026-09-12: silent .catch(() => {}) hid meta write failures — log them (same as before).
      window.todoAPI.dbCall('setMeta', [keyOf(taskId), String(n)]).catch(e => console.error('[tomatoEstimate] setMeta(%s) failed:', keyOf(taskId), e))
    } else {
      window.todoAPI.dbCall('deleteMeta', keyOf(taskId)).catch(e => console.error('[tomatoEstimate] deleteMeta(%s) failed:', keyOf(taskId), e))
    }
  } catch (e) { /* degraded debug host */ }
}

/** Startup backfill (Y rework): legacy-blob pass (timestamped whole-map meta, as before) UNION
 *  per-task keys `tomatoEstimate:<taskId>` for every known task id (caller passes the live id set;
 *  per-task values win — they are the syncable unit now). Also performs the one-time lazy
 *  migration: blob entries are emitted as per-task keys and the legacy DB blob is deleted
 *  (the LS blob stays as the reactive cache). */
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
      // the legacy DB blob.
      try {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (k === '_savedAt') continue
            try {
              const existing = await window.todoAPI.dbCall('getMeta', keyOf(k))
              if (existing !== null && existing !== undefined && existing !== '') continue
            } catch (e) { /* treat as absent */ }
            persistTask(k, Number(v) || 0)
          }
          window.todoAPI.dbCall('deleteMeta', LS_KEY).catch(() => {})
          window.todoAPI.dbCall('deleteMeta', TS_KEY).catch(() => {})
        }
      } catch (e) { /* best-effort: legacy fallback read still works */ }
    }
    // Per-task union: known ids only (meta keys cannot be enumerated over this IPC bridge).
    for (const id of (taskIds || [])) {
      try {
        const raw = await window.todoAPI.dbCall('getMeta', keyOf(id))
        if (raw === null || raw === undefined || raw === '') continue
        const n = Number(raw)
        if (!Number.isFinite(n)) continue
        const clamped = Math.max(MIN, Math.min(MAX, Math.round(n)))
        if (clamped > 0) state[id] = clamped
        else delete state[id]
      } catch (e) { /* absent is fine */ }
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)) } catch (e) { /* ignore */ }
  } catch (e) { /* No DB host (5175 shim): degrade silently */ }
}

export function getEstimate (taskId) { return state[taskId] || 0 }

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

/** Keep the map bounded: drop the oldest entries (insertion order) once over capacity. */
function trimToCapacity () {
  const keys = Object.keys(state)
  for (let i = 0; i < keys.length - MAX_KEYS; i++) delete state[keys[i]]
}

export function setEstimate (taskId, n) {
  if (!taskId) return
  n = Math.max(MIN, Math.min(MAX, Math.round(n || 0)))
  if (n > 0) state[taskId] = n
  else delete state[taskId]
  trimToCapacity()
  persist()
  persistTask(taskId, n) // Y: per-task meta key — the field-granular syncable unit
}
