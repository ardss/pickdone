/** Auth module (offline local profile; API signature aligned with the project baseline)
 *  Y10 (sync-coverage-2): gamification counters (user.snow / user.tomatoGain) historically lived
 *  only in the per-device localStorage blob, so two paired devices drifted apart forever.
 *
 *  Delta-log contract (meta entity, which already syncs; append-only keys make LWW safe):
 *    meta key  `gamification.delta.<deviceId>:<seq36>` = JSON {snow, tomatoGain, ts, base?}
 *    meta key  `gamification.delta.<deviceId>:c`       = JSON {snow, tomatoGain, ts, gen, compacted:[keys]}
 *                                                        (per-device compaction subtotal, U9b)
 *    meta key  `gamification.delta.index`              = JSON array of known delta keys
 *
 *  TOTAL MODEL (U1 fix, 2026-09-20) — "own deltas are included at flush time":
 *    saveSnowGain patches the LS total immediately AND queues the same delta. Therefore an OWN
 *    delta's value is by construction already inside this device's LS total, and the init fold
 *    MUST SKIP every own-device key (`<deviceId>:` prefix, subtotals included) — folding it would
 *    double-count once per restart (the old compounding inflation). Only PEER keys fold in
 *    (summed; `base:true` migration deltas fold as per-field max — max is idempotent, so own base
 *    deltas are still safe to fold). Own deltas exist to reach PEERS, and every device skips only
 *    its own keys, so the model is symmetric and restart-stable: earn 5 → flush → restart → fold
 *    lands on base+5 exactly, forever.
 *
 *  - Each increment appends one delta (batched: flushed at most once per minute).
 *  - Folded guard (LS `gamification.folded`, per-device view): folded[key] = {s,t,gen?} records
 *    what was folded so each peer delta folds exactly once per device; meta deltas stay in place
 *    for their owner. U2 fix: a key is marked folded ONLY after a successful non-null fold — a
 *    null read (delta not yet synced to this device) is retried on the next init, never
 *    permanently skipped.
 *  - U9a self-heal: the device's own last emitted delta key is re-added to the shared index at
 *    init when a lost index race orphaned it (peers could otherwise never discover it).
 *  - U9b compaction: at init, the device folds its OWN increment deltas older than 7 days into the
 *    per-device subtotal key (generation counter `gen` grows per run), deleteMeta's the folded keys
 *    and rewrites the index. A subtotal payload lists the keys it covers (`compacted`); when a peer
 *    folds a newer generation it applies (subtotal − what it already folded of that subtotal's
 *    previous generation − any covered keys it folded individually).
 *  - The shared index is read-modify-write merged by every writer: keys are append-only, so a
 *    lost index update only delays discovery of a peer's deltas until that peer's next write.
 *  - deviceId here is a GENERATED localStorage id (`gamification.deviceId`), NOT user.deviceId
 *    (which is the constant 'OFFLINE-DEVICE' for every install) and NOT the LAN-sync device id
 *    (which rotates on re-pairing and would orphan old delta keys). */
import { loadLocalUser, safeSet, getMetaManyWithFallback } from '../utils/core.js'

const DELTA_PREFIX = 'gamification.delta.'
const INDEX_KEY = 'gamification.delta.index'
const BASE_EMITTED_KEY = 'gamification.baseEmitted'
const DEVICE_LS = 'gamification.deviceId'
const LAST_DELTA_LS = 'gamification.lastDeltaKey' // U9a: self-heal handle
const FOLDED_LS = 'gamification.folded'
const FLUSH_MIN_MS = 60000 // batch: at most one delta write per minute
const COMPACT_AFTER_MS = 7 * 86400000 // U9b: deltas older than 7 days are compacted

function db (op, params) {
  try {
    if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return null
    const p = window.todoAPI.dbCall(op, params)
    if (p && typeof p.catch === 'function') p.catch(e => console.error('[auth] gamification dbCall(%s) failed:', op, e))
    return p
  } catch (e) { return null }
}

function deviceId () {
  try { let id = localStorage.getItem(DEVICE_LS)
    if (!id) { id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem(DEVICE_LS, id) }
    return id
  } catch (e) { return 'danon' }
}
function nextSeq () {
  try { const n = Number(localStorage.getItem('gamification.seq')) || 0; localStorage.setItem('gamification.seq', String(n + 1)); return (n + 1).toString(36) } catch (e) { return Date.now().toString(36) }
}
function deltaKey () { return DELTA_PREFIX + deviceId() + ':' + nextSeq() }
const subtotalKeyOf = id => DELTA_PREFIX + id + ':c'
const isOwnKey = (k, me) => k === subtotalKeyOf(me) || k.startsWith(DELTA_PREFIX + me + ':')

function readJson (raw, fallback) {
  try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : fallback } catch (e) { return fallback }
}

/** Emit one delta now (increments or a base migration) and union it into the shared index. */
function emitDelta (entry) {
  const key = deltaKey()
  try { localStorage.setItem(LAST_DELTA_LS, key) } catch (e) { /* empty */ }
  db('setMeta', [key, JSON.stringify(entry)])
  // Index union (best-effort): read → merge → write; races only delay discovery (append-only keys).
  Promise.resolve(db('getMeta', INDEX_KEY)).then(raw => {
    const list = Array.isArray(readJson(raw, [])) ? readJson(raw, []) : []
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

/** U9b: fold the device's own old (>=7d) increment deltas into the per-device subtotal, delete the
 *  folded keys, and rewrite the index. `entries` maps index keys to parsed entries; returns the
 *  pruned key list. Base-migration deltas and unreadable entries are never compacted. */
async function compactOwnOldDeltas (keys, entries) {
  const me = deviceId()
  const sk = subtotalKeyOf(me)
  const now = Date.now()
  const oldKeys = keys.filter(k => {
    if (k === sk || !k.startsWith(DELTA_PREFIX + me + ':')) return false
    const d = entries[k]
    return d && !d.base && typeof d.ts === 'number' && (now - d.ts) >= COMPACT_AFTER_MS
  })
  if (!oldKeys.length) return keys
  let addSnow = 0
  let addTomato = 0
  const covered = []
  for (const k of oldKeys) {
    addSnow += Number(entries[k].snow) || 0
    addTomato += Number(entries[k].tomatoGain) || 0
    covered.push(k)
  }
  // Grow the existing subtotal (generation counter tells peers how much they have already folded)
  const prev = readJson(await db('getMeta', sk), null)
  const next = {
    snow: (Number(prev && prev.snow) || 0) + addSnow,
    tomatoGain: (Number(prev && prev.tomatoGain) || 0) + addTomato,
    ts: now,
    gen: ((Number(prev && prev.gen) || 0) + 1),
    compacted: Array.from(new Set([...((prev && prev.compacted) || []), ...covered]))
  }
  await db('setMeta', [sk, JSON.stringify(next)])
  for (const k of covered) await db('deleteMeta', k)
  const nextKeys = keys.filter(k => !covered.includes(k))
  if (!nextKeys.includes(sk)) nextKeys.push(sk)
  await db('setMeta', [INDEX_KEY, JSON.stringify(nextKeys)])
  return nextKeys
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
    /** Y10: the increment lands in the LS total immediately (display) AND is appended to the
     *  synced delta-log (batched ≤1/min). U1: because the LS total already contains this gain,
     *  initGamification skips OWN delta keys when folding — see the module-header model note. */
    async saveSnowGain ({ commit, state }, gain) {
      const snow = (state.user.snow || 0) + gain
      const tomatoGain = (state.user.tomatoGain || 0) + Math.max(0, gain)
      commit('patchUser', { snow, tomatoGain })
      pending = pending || { snow: 0, tomatoGain: 0 }
      pending.snow += gain
      pending.tomatoGain += Math.max(0, gain)
      scheduleFlush()
    },
    /** Y10 startup fold: LS total + all not-yet-folded PEER deltas (own keys are skipped — their
     *  value is already in the LS total, U1). Dedupe = the folded-guard (per-key folded values,
     *  per-device view): each peer delta folds exactly once per device; meta deltas stay in place
     *  for their owner. `base` deltas (migrations) fold as per-field max instead of summing.
     *  U2: a key joins the guard only after a SUCCESSFUL non-null fold — a null read (delta not
     *  yet synced here) is retried next init. Never blocks init and never runs when the DB bridge
     *  is absent (browser/stub hosts keep LS-only totals). */
    async initGamification ({ commit, state }) {
      try {
        if (typeof window === 'undefined' || !window.todoAPI || !window.todoAPI.dbCall) return
        const me = deviceId()
        // U9a self-heal FIRST (before any new emission overwrites the lastDeltaKey handle): a lost
        // index race must not orphan the device's own last delta forever (peers could otherwise
        // never discover it).
        const rawIndex0 = await window.todoAPI.dbCall('getMeta', INDEX_KEY)
        let keys = []
        try { keys = JSON.parse(rawIndex0 || '[]') } catch (e) { keys = [] }
        if (!Array.isArray(keys)) keys = []
        try {
          const lastOwn = localStorage.getItem(LAST_DELTA_LS)
          if (lastOwn && !keys.includes(lastOwn)) { keys.push(lastOwn); db('setMeta', [INDEX_KEY, JSON.stringify(keys)]) }
        } catch (e) { /* empty */ }
        // One-time migration: emit the current LS totals as a base delta so peers can adopt them
        // (per-field max). The factory-default 888 snow is NOT user progress — skip it.
        if (!(await window.todoAPI.dbCall('getMeta', BASE_EMITTED_KEY))) {
          const u0 = state.user || {}
          if ((u0.snow || 0) !== 888 || (u0.tomatoGain || 0) !== 0) {
            emitDelta({ snow: u0.snow || 0, tomatoGain: u0.tomatoGain || 0, ts: Date.now(), base: true })
          }
          db('setMeta', [BASE_EMITTED_KEY, '1'])
        }
        if (!keys.length) return
        const folded = readJson(localStorage.getItem(FOLDED_LS), {})
        let addSnow = 0
        let addTomato = 0
        const baseMax = { snow: 0, tomatoGain: 0 }
        const entries = {}
        const markFolded = (k, s, t, gen) => { folded[k] = gen != null ? { s, t, gen } : { s, t } }
        // U-18: one batch read of the delta keys instead of an O(N) sequential getMeta loop
        // (getMetaManyWithFallback keeps the per-key loop when the batch op is absent)
        const deltaVals = await getMetaManyWithFallback(keys)
        for (let ki = 0; ki < keys.length; ki++) {
          const k = keys[ki]
          const d = readJson(deltaVals[ki], null)
          // U2: null (not yet synced) or unreadable → leave unfolded, retry next init.
          if (!d || typeof d !== 'object' || Array.isArray(d)) continue
          if (d.base) {
            // base migration deltas fold as per-field max (idempotent — own ones included).
            baseMax.snow = Math.max(baseMax.snow, Number(d.snow) || 0)
            baseMax.tomatoGain = Math.max(baseMax.tomatoGain, Number(d.tomatoGain) || 0)
            continue
          }
          // U1: own increment deltas (and own subtotals) are already inside the LS total — skip.
          if (isOwnKey(k, me)) { entries[k] = d; continue }
          entries[k] = d
          const f = folded[k]
          if (d.gen != null) {
            // U9b peer subtotal: fold only the not-yet-folded generation; subtract this device's
            // previously folded subtotal amount and any covered keys it folded individually.
            const fGen = (f && Number(f.gen)) || 0
            if (fGen >= (Number(d.gen) || 0)) continue
            let s = (Number(d.snow) || 0) - ((f && Number(f.s)) || 0)
            let t = (Number(d.tomatoGain) || 0) - ((f && Number(f.t)) || 0)
            for (const ck of (Array.isArray(d.compacted) ? d.compacted : [])) {
              const cf = folded[ck]
              if (cf && Number.isFinite(Number(cf.s))) { s -= Number(cf.s) || 0; t -= Number(cf.t) || 0 }
            }
            addSnow += Math.max(0, s)
            addTomato += Math.max(0, t)
            markFolded(k, Number(d.snow) || 0, Number(d.tomatoGain) || 0, Number(d.gen) || 0)
            continue
          }
          if (f) continue // ordinary peer delta already folded on this device
          addSnow += Number(d.snow) || 0
          addTomato += Number(d.tomatoGain) || 0
          markFolded(k, Number(d.snow) || 0, Number(d.tomatoGain) || 0)
        }
        // U9b: compact own old deltas into the per-device subtotal for peers (their values are
        // already represented in this device's LS total).
        await compactOwnOldDeltas(keys, entries)
        try { localStorage.setItem(FOLDED_LS, JSON.stringify(folded)) } catch (e) { /* empty */ }
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
