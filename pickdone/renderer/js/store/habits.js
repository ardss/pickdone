/** Habit check-ins + countdown/memorial dates — localStorage (instantly available on first paint) + main DB meta table (durable source of truth, covered by auto backup)
 *  habit: { id, name, color, createdAt, records: { 'YYYY-MM-DD': true },
 *           frequency: { type: 'daily'|'weekdays'|'interval', weekdays: [1,3,5], intervalN: 2 } }
 *  moment: { id, name, date(YYYY-MM-DD), kind: 'countdown' | 'memorial' } */
import { FMT } from '../utils/core.js'

const LS_KEY = 'habitsState'
const META_KEY = 'habitsState'
/** Persistence blob format version: readers treat old unstamped data as v1 (behavior unchanged) */
const SCHEMA_V = 1
const PALETTE = ['#0f9d8f', '#f76e6e', '#f2a63b', '#7ac74f', '#5aa9e6', '#9d8df1', '#eb96c3']

function readLs () {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY))
    // Format-version tolerance: old unstamped data treated as v1 (behavior unchanged)
    if (d && Array.isArray(d.habits) && (d.schemaV || 1) <= SCHEMA_V) return d
  } catch {}
  return null
}

/** First-paint state: localStorage takes precedence (synchronously available); newer values from the main DB are merged by initFromDb at startup */
function load () {
  const d = readLs()
  if (d) return { habits: d.habits, moments: d.moments || [], savedAt: d.savedAt || 0 }
  return { habits: [], moments: [], savedAt: 0 }
}

/** Dual write: localStorage (synchronous fallback) + main DB meta table (source of truth, included in auto backup) */
function persist (state) {
  const blob = { schemaV: SCHEMA_V, habits: state.habits, moments: state.moments || [], savedAt: Date.now() }
  state.savedAt = blob.savedAt
  try { localStorage.setItem(LS_KEY, JSON.stringify(blob)) } catch {}
  try { window.todoAPI && window.todoAPI.dbCall && window.todoAPI.dbCall('setMeta', [META_KEY, JSON.stringify(blob)]).catch(() => {}) } catch {}
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
      if (!h.records[todayKey()]) d.setDate(d.getDate() - 1)
      for (;;) {
        const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        if (h.records[k]) { streak++; d.setDate(d.getDate() - 1) } else break
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
      s.habits = blob.habits
      s.moments = blob.moments || []
      s.savedAt = blob.savedAt || 0
      try { localStorage.setItem(LS_KEY, JSON.stringify(blob)) } catch {}
    },
    addHabit (s, { name, frequency }) {
      s.habits.push({
        id: Date.now(),
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
      s.moments.push({ id: Date.now(), name, date, kind })
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
        const raw = await window.todoAPI.dbCall('getMeta', META_KEY)
        if (raw) commit('replaceAll', JSON.parse(raw))
      } catch { /* empty environment */ }
    }
  }
}
