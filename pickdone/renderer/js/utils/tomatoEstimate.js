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

function load () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    if (d && typeof d === 'object' && !Array.isArray(d)) return d
  } catch (e) /* empty */ { }
  return {}
}

const state = reactive(load())

function persist () {
  const now = String(Date.now())
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state))
    localStorage.setItem(TS_KEY, now)
  } catch (e) { /* ignore quota exceeded */ }
  try {
    if (window.todoAPI && window.todoAPI.dbCall) {
      // 2026-09-12: silent .catch(() => {}) hid meta write failures — a failing setMeta meant the CLI/other
      // windows kept a stale estimate with no trace. Log it.
      window.todoAPI.dbCall('setMeta', [LS_KEY, JSON.stringify(state)]).catch(e => console.error('[tomatoEstimate] setMeta(%s) failed:', LS_KEY, e))
      window.todoAPI.dbCall('setMeta', [TS_KEY, now]).catch(e => console.error('[tomatoEstimate] setMeta(%s) failed:', TS_KEY, e))
    }
  } catch (e) { /* degraded debug host */ }
}

/** Startup backfill: if the meta-side timestamp is newer (= changed by CLI/another window while offline), let meta take over LS wholesale. Same pattern as habits/initFromDb */
export async function initFromDb () {
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return
    const [metaRaw, metaAt, lsAt] = await Promise.all([
      window.todoAPI.dbCall('getMeta', LS_KEY),
      window.todoAPI.dbCall('getMeta', TS_KEY),
      Promise.resolve(Number(localStorage.getItem(TS_KEY)) || 0)
    ])
    const metaAtN = Number(metaAt) || 0
    const parsed = JSON.parse(metaRaw || 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    // D5 (2026-09-20): strict `<` — an exact tie between meta and LS stamps favors CLI/meta per the
    // "newer wins" contract (the CLI writes its timestamp synchronously; the LS write of the same
    // change lands in the same tick, and `<=` used to let the stale LS side win the tie).
    if (metaAtN < lsAt) return // LS is strictly newer; leave it alone (ties favor meta/CLI)
    for (const k of Object.keys(state)) delete state[k]
    for (const [k, v] of Object.entries(parsed)) {
      if (k === '_savedAt') continue
      state[k] = v
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state))
      localStorage.setItem(TS_KEY, String(metaAtN))
    } catch (e) { /* ignore */ }
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
}
