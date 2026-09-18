/** Habit check-ins + countdown/memorial dates — localStorage (instantly available on first paint) + main DB meta table (durable source of truth, covered by auto backup)
 *  habit: { id, name, color, createdAt, records: { 'YYYY-MM-DD': true },
 *           frequency: { type: 'daily'|'weekdays'|'interval', weekdays: [1,3,5], intervalN: 2 } }
 *  moment: { id, name, date(YYYY-MM-DD), kind: 'countdown' | 'memorial' } */
import { FMT } from '../utils/core.js'

const LS_KEY = 'habitsState'
/** DB meta key MUST carry the `db.` prefix: the v6 sync-schema bridge (src/main/db-sync-schema.js
 *  SYNC_BLOB_KEYS) only mirrors `db.settingsState` / `db.habitsState` into settings_rows — the bare
 *  legacy `habitsState` row never synced. One-time migration: initFromDb reads `db.habitsState`
 *  falling back to the legacy key, and (on fallback) copies the blob to the new key; the legacy row
 *  is left in place during the transition (a later schema migration may sweep it). */
const META_KEY = 'db.habitsState'
const LEGACY_META_KEY = 'habitsState'
/** Aux→main relay ping: aux windows can't call setMeta (MAIN_WINDOW_ONLY_OP); they write LS + this ping,
 *  and the main window's storage listener below re-persists the blob to the DB on its behalf. */
const SYNC_KEY = 'habitsSyncPing'
/** Persistence blob format version: readers treat old unstamped data as v1 (behavior unchanged) */
const SCHEMA_V = 1
const PALETTE = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3']

/** Records-map normalization: habits restored from old backups may lack the records field entirely; the
 *  streakOf/last30/toggleCheck getters assume it exists (`h.records[k]` throws → render crash). Coerce every
 *  habit to a plain object map on load. */
export function normalizeHabitRecords (habits) {
  for (const h of (Array.isArray(habits) ? habits : [])) {
    if (!h || typeof h !== 'object') continue
    if (!h.records || typeof h.records !== 'object') h.records = {}
  }
  return habits
}

function readLs () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    // Format-version tolerance: old unstamped data treated as v1 (behavior unchanged)
    if (d && Array.isArray(d.habits) && (d.schemaV || 1) <= SCHEMA_V) { normalizeHabitRecords(d.habits); return d }
  } catch {}
  return null
}

/** First-paint state: localStorage takes precedence (synchronously available); newer values from the main DB are merged by initFromDb at startup */
function load () {
  const d = readLs()
  if (d) return { habits: d.habits, moments: d.moments || [], savedAt: d.savedAt || 0 }
  return { habits: [], moments: [], savedAt: 0 }
}

/** Aux-window detection: same judgment as dbMirror's writeNow (float / quick-add hashes).
 *  setMeta is a MAIN_WINDOW_ONLY_OP — an aux window's direct dbCall is rejected by the main process,
 *  which previously left the aux window's LS edit never reaching the durable DB copy. */
export function isAuxWindow () {
  try { return !!(typeof window !== 'undefined' && window.location && window.location.hash && /__tomato-float|__quick-add/.test(window.location.hash)) } catch (e) { return false }
}

/** Dual write: localStorage (synchronous fallback) + main DB meta table (source of truth, included in auto backup).
 *  Aux windows: LS write + relay ping only — the main window's storage listener persists to the DB on their behalf. */
function persist (state) {
  const blob = { schemaV: SCHEMA_V, habits: state.habits, moments: state.moments || [], savedAt: Date.now() }
  state.savedAt = blob.savedAt
  try { localStorage.setItem(LS_KEY, JSON.stringify(blob)) } catch {}
  try {
    if (!window.todoAPI || !window.todoAPI.dbCall) return
    if (isAuxWindow()) {
      try { localStorage.setItem(SYNC_KEY, String(Date.now()) + ':' + Math.random().toString(36).slice(2)) } catch (e) { /* empty */ }
      return
    }
    // 2026-09-12: silent .catch(() => {}) hid meta write failures (DB is the durable source of truth) — log them
    window.todoAPI.dbCall('setMeta', [META_KEY, JSON.stringify(blob)]).catch(e => console.error('[habits] setMeta failed:', e))
  } catch (e) { /* empty environment */ }
}

// Main window relay: an aux window's habits edit arrives via LS + ping; the main window re-reads the
// blob, feeds it into the main window's Vuex state (applyExternal — otherwise the next main-window
// persist would overwrite the aux edit with stale state) and writes the durable DB meta row on its
// behalf (storage events only fire in the OTHER windows, so the writer never relays itself).
let externalApplier = null
/** Hook for main.js: register a callback receiving every external (aux-window) habits blob so it can
 *  be applied to the main window's Vuex store, e.g. `onExternalHabitBlob(b => store.commit('habits/applyExternal', b))`. */
export function onExternalHabitBlob (fn) { externalApplier = typeof fn === 'function' ? fn : null }

function relayAuxBlob () {
  try {
    const d = readLs()
    if (!d) { try { localStorage.removeItem(SYNC_KEY) } catch (e) { /* empty */ } return }
    if (externalApplier) {
      try { externalApplier(d) } catch (e) { console.error('[habits] external blob apply failed:', e) }
    }
    // The ping is consumed only after the durable DB write settles: consuming it up front let one
    // failed IPC drop the aux edit from the retry channel entirely (the next main-window persist
    // would paper over it at best, or lose it on quit at worst).
    if (typeof window !== 'undefined' && window.todoAPI && window.todoAPI.dbCall) {
      window.todoAPI.dbCall('setMeta', [META_KEY, JSON.stringify(d)]).then(
        () => { try { localStorage.removeItem(SYNC_KEY) } catch (e) { /* empty */ } },
        err => console.error('[habits] relay setMeta failed — ping kept for retry:', err)
      )
    }
  } catch (err) { /* empty */ }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !isAuxWindow()) {
  window.addEventListener('storage', e => {
    if (!e || e.key !== SYNC_KEY) return
    relayAuxBlob()
  })
  // Residual delivery: a ping written while no main window was listening (main window was closed/
  // reloading when the aux window saved) is relayed once at registration, then cleared.
  try { if (localStorage.getItem(SYNC_KEY)) relayAuxBlob() } catch (e) { /* empty */ }
}

// Uses dayjs+FMT.date uniformly like the rest of the app (previously hand-rolled concatenation could disagree with HabitView's dayjs convention at day boundaries)
const todayKey = () => window.dayjs().format(FMT.date)

/** Whether a date is a check-in day for the habit (frequency filter) */
export function isDueOn (habit, dateKey) {
  const f = habit.frequency || { type: 'daily' }
  if (f.type === 'daily') return true
  const d = new Date(dateKey + 'T12:00:00')
  const dow = d.getDay() // 0=Sun
  const mon0 = (dow + 6) % 7 // 0=Mon
  if (f.type === 'weekdays') return (f.weekdays || []).includes(mon0)
  if (f.type === 'interval') {
    const created = new Date(habit.createdAt || Date.now())
    created.setHours(12, 0, 0, 0)
    const diff = Math.round((d.getTime() - created.getTime()) / 86400000)
    return diff >= 0 && diff % (f.intervalN || 1) === 0
  }
  return true
}

export default {
  namespaced: true,
  state: () => load(),
  getters: {
    streakOf: s => id => {
      const h = s.habits.find(x => x.id === id)
      if (!h) return 0
      let streak = 0
      const d = new Date()
      // Walk back day by day; non-due days (frequency filter) are skipped without breaking the streak.
      // P2 root fix: the loop used to ignore isDueOn, so a Mon/Wed/Fri habit "broke" on an idle Sunday.
      // Today being due-but-unchecked doesn't break either (same lenient semantics as before).
      const createdKey = h.createdAt ? window.dayjs(h.createdAt).format(FMT.date) : null
      // G1 hard cap: `frequency:{type:'weekdays',weekdays:[]}` with a missing createdAt used to make both
      // loop-exit conditions unreachable (no due day ever breaks, no createdKey guard) → infinite loop,
      // frozen renderer. Two years of look-back is far beyond any meaningful streak.
      for (let guard = 0; guard < 730; guard++) {
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        if (h.records[k]) { streak++ } else if (k !== todayKey() && isDueOn(h, k)) break
        if (createdKey && k < createdKey) break // walked back before the habit's creation: nothing earlier can be due (loop guard)
        d.setDate(d.getDate() - 1)
      }
      return streak
    },
    last30: s => id => {
      const h = s.habits.find(x => x.id === id)
      const out = []
      const d = new Date(); d.setDate(d.getDate() - 29)
      for (let i = 0; i < 30; i++) {
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        out.push({ key: k, on: !!(h && h.records[k]) })
        d.setDate(d.getDate() + 1)
      }
      return out
    },
    /** Whether a habit is due on a date (frequency filter) */
    isDue: s => (id, dateKey) => {
      const h = s.habits.find(x => x.id === id)
      if (!h) return false
      return isDueOn(h, dateKey)
    }
  },
  mutations: {
    /** On startup, a newer main DB value overwrites local (last-write-wins by savedAt) */
    replaceAll (s, blob) {
      if (!blob || !Array.isArray(blob.habits)) return
      if ((blob.savedAt || 0) < (s.savedAt || 0)) return
      normalizeHabitRecords(blob.habits) // DB archive is the restore path for old backups — same missing-records guard as readLs
      s.habits = blob.habits
      s.moments = blob.moments || []
      s.savedAt = blob.savedAt || 0
      try { localStorage.setItem(LS_KEY, JSON.stringify(blob)) } catch {}
    },
    /** G1: an aux window's habits edit relayed through the main window — update the main window's Vuex
     *  state so its next persist doesn't resurrect stale data and clobber the aux edit (LS already holds
     *  the blob; no persist here to avoid an echo loop). Same last-write-wins guard as replaceAll. */
    applyExternal (s, blob) {
      if (!blob || !Array.isArray(blob.habits)) return
      if ((blob.savedAt || 0) < (s.savedAt || 0)) return
      normalizeHabitRecords(blob.habits)
      s.habits = blob.habits
      s.moments = blob.moments || []
      s.savedAt = blob.savedAt || 0
    },
    addHabit (s, { name, frequency }) {
      // Millisecond-precision Date.now() alone can collide (rapid double-add), breaking delete/check-in by id
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      s.habits.push({
        id,
        name,
        color: PALETTE[s.habits.length % PALETTE.length],
        createdAt: Date.now(),
        frequency: frequency || { type: 'daily' },
        records: {}
      })
      persist(s)
    },
    renameHabit (s, { id, name }) {
      const h = s.habits.find(x => x.id === id); if (h) h.name = name
      persist(s)
    },
    delHabit (s, id) {
      s.habits = s.habits.filter(x => x.id !== id)
      persist(s)
    },
    toggleCheck (s, { id, day }) {
      const h = s.habits.find(x => x.id === id); if (!h) return
      if (h.records[day]) delete h.records[day]
      else h.records[day] = true
      persist(s)
    },
    addMoment (s, { name, date, kind }) {
      // Same collision guard as addHabit
      s.moments.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name, date, kind })
      persist(s)
    },
    delMoment (s, id) {
      s.moments = s.moments.filter(x => x.id !== id)
      persist(s)
    }
  },
  actions: {
    /** Restore from the main DB at startup: replaceAll already does last-write-wins by savedAt (the DB archive is the fallback when LS is cleared) */
    async initFromDb ({ commit }) {
      try {
        if (!window.todoAPI?.dbCall) return
        let raw = await window.todoAPI.dbCall('getMeta', META_KEY)
        let legacy = false
        if (!raw) {
          // One-time migration source: pre-rename installs persisted under the bare 'habitsState' key
          raw = await window.todoAPI.dbCall('getMeta', LEGACY_META_KEY)
          legacy = !!raw
        }
        if (raw) {
          commit('replaceAll', JSON.parse(raw))
          if (legacy) {
            // Copy the legacy blob to the db.-prefixed key so the sync bridge picks it up; the legacy
            // row is kept (read path no longer depends on it after this write succeeds)
            await window.todoAPI.dbCall('setMeta', [META_KEY, raw])
          }
        }
      } catch { /* empty environment */ }
    }
  }
}
