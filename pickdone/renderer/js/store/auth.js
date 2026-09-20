/** Auth module (offline local profile; API signature aligned with the project baseline)
 *  Y10 (sync-coverage-2): gamification counters (user.snow / user.tomatoGain) historically lived
 *  only in the per-device localStorage blob, so two paired devices drifted apart forever.
 *  Delta-log contract (meta entity, which already syncs; append-only keys make LWW safe):
 *    meta key  `gamification.delta.<deviceId>:<seq36>` = JSON {snow, tomatoGain, ts, base?}
 *    meta key  `gamification.delta.index`              = JSON array of known delta keys
 *  - Each increment appends one delta (batched: flushed at most once per minute).
 *  - On init the index is folded: increment deltas are summed into the LS base and then compacted
 *    (deleted + dropped from the index); `base` deltas are migrations of a device's existing LS
 *    totals and fold as per-field max (never summed).
 *  - The shared index is read-modify-write merged by every writer: keys are append-only, so a
 *    lost index update only delays discovery of a peer's deltas until that peer's next write.
 *  - deviceId here is a GENERATED localStorage id (`gamification.deviceId`), NOT user.deviceId
 *    (which is the constant 'OFFLINE-DEVICE' for every install) and NOT the LAN-sync device id
 *    (which rotates on re-pairing and would orphan old delta keys). */
import { loadLocalUser, safeSet } from '../utils/core.js'

const DELTA_PREFIX = 'gamification.delta.'
const INDEX_KEY = 'gamification.delta.index'
const BASE_EMITTED_KEY = 'gamification.baseEmitted'
const DEVICE_LS = 'gamification.deviceId'
const FLUSH_MIN_MS = 60000 // batch: at most one delta write per minute

function db (op, params) {
  try {
    if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return null
    const p = window.todoAPI.dbCall(op, params)
    if (p && typeof p.catch === 'function') p.catch(e => console.error('[auth] gamification dbCall(%s) failed:', op, e))
    return p
  } catch (e) { return null }
}

function deviceId () {
  try {
    let id = localStorage.getItem(DEVICE_LS)
    if (!id) { id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(DEVICE_LS, id) }
    return id
  } catch (e) { return 'danon' }
}
function nextSeq () {
  try { const n = Number(localStorage.getItem('gamification.seq')) || 0; localStorage.setItem('gamification.seq', String(n + 1)); return (n + 1).toString(36) } catch (e) { return Date.now().toString(36) }
}
function deltaKey () { return DELTA_PREFIX + deviceId() + ':' + nextSeq() }

/** Emit one delta now (increments or a base migration) and union it into the shared index. */
function emitDelta (entry) {
  const key = deltaKey()
  db('setMeta', [key, JSON.stringify(entry)])
  // Index union (best-effort): read → merge → write; races only delay discovery (append-only keys).
  Promise.resolve(db('getMeta', INDEX_KEY)).then(raw => {
    let list = []
    try { list = JSON.parse(raw || '[]') } catch (e) { list = [] }
    if (!Array.isArray(list)) list = []
    if (!list.includes(key)) { list.push(key); db('setMeta', [INDEX_KEY, JSON.stringify(list)]) }
  }).catch(e => console.error('[auth] gamification index update failed:', e))
}

let lastFlushAt = 0
let pending = null // {snow, tomatoGain} increments awaiting the batch window
let flushTimer = null
function scheduleFlush () {
  if (flushTimer) return
  const wait = Math.max(0, lastFlushAt + FLUSH_MIN_MS - Date.now())
  flushTimer = setTimeout(() => {
    flushTimer = null
    if (!pending) return
    emitDelta({ snow: pending.snow, tomatoGain: pending.tomatoGain, ts: Date.now() })
    pending = null
    lastFlushAt = Date.now()
  }, Math.min(wait, FLUSH_MIN_MS))
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

export default {
  namespaced: true,
  state: () => ({ user: loadLocalUser(), loggedIn: true, lastLoginRecord: { method: 1, value: 'offline@local' } }),
  mutations: {
    setUser (state, u) { state.user = u; safeSet('user', JSON.stringify(u)) },
    patchUser (state, patch) {
      state.user = { ...state.user, ...patch }
      safeSet('user', JSON.stringify(state.user))
    },
    setLastLoginRecord (state, r) { state.lastLoginRecord = r; safeSet('lastLoginRecord', JSON.stringify(r)) },
    logout (state) { state.loggedIn = false }
  },
  actions: {
    // When cloud is wired up later: replace with real calls like api.loginByAccount(...)
    async loginByAccount (_, { account }) {
      return new Promise(res => setTimeout(() => res({ ok: true, account }), 200))
    },
    async saveSnowGain ({ commit, state }, gain) {
      const snow = (state.user.snow || 0) + gain
      const tomatoGain = (state.user.tomatoGain || 0) + Math.max(0, gain)
      commit('patchUser', { snow, tomatoGain })
      // Y10: append the increments to the synced delta-log (batched ≤1/min; display unchanged).
      pending = pending || { snow: 0, tomatoGain: 0 }
      pending.snow += gain
      pending.tomatoGain += Math.max(0, gain)
      scheduleFlush()
    },
    /** Y10 startup fold: LS base + sum of all readable deltas. Dedupe = a local folded-guard
     *  (LS 'gamification.folded', per-device view): each delta is folded exactly once per device;
     *  the meta deltas stay in place for peers that have not folded them yet. `base` deltas
     *  (migrations) fold as per-field max instead of summing. Never blocks init and never runs
     *  when the DB bridge is absent (browser/stub hosts keep LS-only totals). */
    async initGamification ({ commit, state }) {
      try {
        if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
        // One-time migration: emit the current LS totals as a base delta so peers can adopt them
        // (per-field max). The factory-default 888 snow is NOT user progress — skip it.
        if (!(await window.todoAPI.dbCall('getMeta', BASE_EMITTED_KEY))) {
          const u0 = state.user || {}
          if ((u0.snow || 0) !== 888 || (u0.tomatoGain || 0) !== 0) {
            emitDelta({ snow: u0.snow || 0, tomatoGain: u0.tomatoGain || 0, ts: Date.now(), base: true })
          }
          db('setMeta', [BASE_EMITTED_KEY, '1'])
        }
        const raw = await window.todoAPI.dbCall('getMeta', INDEX_KEY)
        let keys = []
        try { keys = JSON.parse(raw || '[]') } catch (e) { keys = [] }
        if (!Array.isArray(keys) || !keys.length) return
        let folded = {}
        try { folded = JSON.parse(localStorage.getItem('gamification.folded') || '{}') } catch (e) { folded = {} }
        let addSnow = 0
        let addTomato = 0
        const baseMax = { snow: 0, tomatoGain: 0 }
        let changed = false
        for (const k of keys) {
          if (folded[k]) continue
          folded[k] = 1
          changed = true
          try {
            const d = JSON.parse((await window.todoAPI.dbCall('getMeta', k)) || 'null')
            if (!d || typeof d !== 'object') continue
            if (d.base) {
              baseMax.snow = Math.max(baseMax.snow, Number(d.snow) || 0)
              baseMax.tomatoGain = Math.max(baseMax.tomatoGain, Number(d.tomatoGain) || 0)
            } else {
              addSnow += Number(d.snow) || 0
              addTomato += Number(d.tomatoGain) || 0
            }
          } catch (e) { /* corrupt delta entry: mark folded, skip */ }
        }
        if (changed) { try { localStorage.setItem('gamification.folded', JSON.stringify(folded)) } catch (e) { /* empty */ } }
        const u = state.user || {}
        const next = {
          snow: Math.max(u.snow || 0, baseMax.snow) + addSnow,
          tomatoGain: Math.max(u.tomatoGain || 0, baseMax.tomatoGain) + addTomato
        }
        if (next.snow !== (u.snow || 0) || next.tomatoGain !== (u.tomatoGain || 0)) commit('patchUser', next)
      } catch (e) { console.warn('[auth] gamification fold skipped:', e) }
    }
  }
}
