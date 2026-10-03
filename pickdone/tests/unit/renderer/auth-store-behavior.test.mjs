/**
 * Auth store behavior (store/auth.js) — the gamification delta-log surface.
 * Covered:
 *   - saveSnowGain: legacy numeric payload, {gain, dedupKey} idempotency (completeFocus retry
 *     safety), negative gain never bumps tomatoGain, patch lands in state + LS mirror.
 *   - mutations: patchUser merges and persists; setUser replaces; setLastLoginRecord.
 *   - initGamification fold (with a stubbed dbCall meta map):
 *       U1  own-device delta keys are skipped (their value is already in the LS total)
 *       —   ordinary peer deltas fold exactly once (folded guard, restart-stable)
 *       —   base migration deltas fold as per-field max
 *       U2  a null (not-yet-synced) delta is retried next init, never marked folded
 *       U9a own emitted keys self-heal into the shared index
 * Run: node --test tests/unit/renderer/auth-store-behavior.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const auth = (await import('../../../renderer/js/store/auth.js')).default

// In-memory meta table standing in for the DB bridge (never touches a real user data dir).
let metaMap = null
let ops = null
function installBridge () {
  metaMap = new Map()
  ops = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      ops.push([op, params])
      if (op === 'getMeta') return metaMap.has(params) ? metaMap.get(params) : null
      if (op === 'setMeta') { metaMap.set(params[0], params[1]); return 'ok' }
      if (op === 'deleteMeta') { metaMap.delete(params); return 'ok' }
      return 'ok'
    }
  }
}
function uninstallBridge () {
  delete globalThis.window.todoAPI
}

// Minimal Vuex-style action context: delegates to the REAL mutations so the LS mirror
// (patchUser → safeSet) is exercised exactly as in the wired store.
function makeCtx (user) {
  const state = { user: { ...user } }
  return {
    state,
    commit (type, payload) { auth.mutations[type](state, payload) }
  }
}
const wipeLs = () => {
  for (const k of [...Array(globalThis.localStorage.length).keys()].map(i => globalThis.localStorage.key(i))) {
    if (k.startsWith('gamification.') || k === 'user' || k === 'lastLoginRecord') globalThis.localStorage.removeItem(k)
  }
}

beforeEach(() => {
  wipeLs()
  installBridge()
})

/* ===== mutations ===== */

test('patchUser merges the patch and mirrors the whole user to LS', () => {
  const ctx = makeCtx({ snow: 5, tomatoGain: 1, name: 'me' })
  auth.mutations.patchUser(ctx.state, { snow: 9 })
  assert.equal(ctx.state.user.snow, 9)
  assert.equal(ctx.state.user.tomatoGain, 1, 'unrelated fields preserved by the merge')
  assert.equal(ctx.state.user.name, 'me')
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('user')), ctx.state.user, 'LS mirror kept in sync')
})

test('setUser replaces and setLastLoginRecord persists', () => {
  const state = { user: { snow: 1 }, lastLoginRecord: null }
  auth.mutations.setUser(state, { snow: 2 })
  assert.equal(state.user.snow, 2)
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('user')), { snow: 2 })
  auth.mutations.setLastLoginRecord(state, { method: 2, value: 'x' })
  assert.deepEqual(state.lastLoginRecord, { method: 2, value: 'x' })
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('lastLoginRecord')), { method: 2, value: 'x' })
})

test('logout only flips the flag (offline profile keeps the user blob)', () => {
  const state = { loggedIn: true }
  auth.mutations.logout(state)
  assert.equal(state.loggedIn, false)
})

/* ===== saveSnowGain ===== */

test('saveSnowGain accepts the legacy bare-number payload and patches immediately', async () => {
  const ctx = makeCtx({ snow: 10, tomatoGain: 2 })
  await auth.actions.saveSnowGain(ctx, 3)
  assert.equal(ctx.state.user.snow, 13)
  assert.equal(ctx.state.user.tomatoGain, 5)
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('user')).snow, 13)
})

test('saveSnowGain with a dedupKey applies the SAME gain exactly once (retry safety)', async () => {
  const ctx = makeCtx({ snow: 0, tomatoGain: 0 })
  const payload = { gain: 4, dedupKey: 'focus-retry-1' }
  await auth.actions.saveSnowGain(ctx, payload)
  assert.equal(ctx.state.user.snow, 4)
  // completeFocus mid-way failure replays the whole completion with the same phase key
  await auth.actions.saveSnowGain(ctx, payload)
  await auth.actions.saveSnowGain(ctx, payload)
  assert.equal(ctx.state.user.snow, 4, 'retries with an already-applied dedupKey must be no-ops')
  assert.equal(ctx.state.user.tomatoGain, 4)

  // a different key applies again; an empty/absent key never dedups
  await auth.actions.saveSnowGain(ctx, { gain: 1, dedupKey: 'focus-retry-2' })
  assert.equal(ctx.state.user.snow, 5)
  await auth.actions.saveSnowGain(ctx, { gain: 7 }) // no dedupKey → always applies
  assert.equal(ctx.state.user.snow, 12)
})

test('saveSnowGain clamps a negative gain out of tomatoGain (snow may decrease)', async () => {
  const ctx = makeCtx({ snow: 10, tomatoGain: 6 })
  await auth.actions.saveSnowGain(ctx, { gain: -3, dedupKey: 'neg-1' })
  assert.equal(ctx.state.user.snow, 7, 'snow delta applied verbatim')
  assert.equal(ctx.state.user.tomatoGain, 6, 'tomatoGain only counts max(0, gain)')
})

/* ===== initGamification fold ===== */

const DELTA = 'gamification.delta.'
const INDEX = 'gamification.delta.index'

test('U1: OWN delta keys are skipped — the LS total already contains them', async () => {
  globalThis.localStorage.setItem('gamification.deviceId', 'devme')
  globalThis.localStorage.setItem('user', JSON.stringify({ snow: 100, tomatoGain: 10 }))
  metaMap.set(INDEX, JSON.stringify([DELTA + 'devme:1', DELTA + 'peerA:1']))
  metaMap.set(DELTA + 'devme:1', JSON.stringify({ snow: 50, tomatoGain: 5, ts: 1 }))
  metaMap.set(DELTA + 'peerA:1', JSON.stringify({ snow: 7, tomatoGain: 2, ts: 1 }))

  const ctx = makeCtx(JSON.parse(globalThis.localStorage.getItem('user')))
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 107, 'only the PEER delta folds; folding own 50 would double-count')
  assert.equal(ctx.state.user.tomatoGain, 12)

  // idempotent across restarts: the folded guard stops a refold of the peer key
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 107)
  assert.equal(ctx.state.user.tomatoGain, 12)
})

test('ordinary peer deltas fold exactly once per device (folded guard)', async () => {
  globalThis.localStorage.setItem('gamification.deviceId', 'devme')
  globalThis.localStorage.setItem('user', JSON.stringify({ snow: 0, tomatoGain: 0 }))
  const keys = [DELTA + 'peerA:1', DELTA + 'peerA:2']
  metaMap.set(INDEX, JSON.stringify(keys))
  metaMap.set(keys[0], JSON.stringify({ snow: 3, tomatoGain: 1, ts: 1 }))
  metaMap.set(keys[1], JSON.stringify({ snow: 4, tomatoGain: 1, ts: 2 }))

  const ctx = makeCtx({ snow: 0, tomatoGain: 0 })
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 7)
  assert.equal(ctx.state.user.tomatoGain, 2)
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 7, 'second init must not refold the same peer keys')
  // guard is restart-stable in LS
  const guard = JSON.parse(globalThis.localStorage.getItem('gamification.folded'))
  assert.deepEqual(Object.keys(guard).sort(), keys.slice().sort())
})

test('base migration deltas fold as per-field max (idempotent), never summed', async () => {
  globalThis.localStorage.setItem('gamification.deviceId', 'devme')
  metaMap.set(INDEX, JSON.stringify([DELTA + 'peerA:b1', DELTA + 'peerA:b2']))
  metaMap.set(DELTA + 'peerA:b1', JSON.stringify({ snow: 20, tomatoGain: 0, ts: 1, base: true }))
  metaMap.set(DELTA + 'peerA:b2', JSON.stringify({ snow: 15, tomatoGain: 9, ts: 2, base: true }))

  const ctx = makeCtx({ snow: 5, tomatoGain: 1 })
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 20, 'max(LS, base fields), not LS + sum(bases)')
  assert.equal(ctx.state.user.tomatoGain, 9)
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 20, 'max fold is idempotent')
  assert.equal(ctx.state.user.tomatoGain, 9)
})

test('U2: a null (not yet synced) delta is retried next init, never marked folded', async () => {
  globalThis.localStorage.setItem('gamification.deviceId', 'devme')
  const k = DELTA + 'peerA:1'
  metaMap.set(INDEX, JSON.stringify([k]))
  metaMap.set(k, null) // delta written by the peer but not synced to this device yet

  const ctx = makeCtx({ snow: 0, tomatoGain: 0 })
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 0)
  assert.equal((JSON.parse(globalThis.localStorage.getItem('gamification.folded')) || {})[k], undefined,
    'a null read must not join the folded guard (would skip it forever)')

  metaMap.set(k, JSON.stringify({ snow: 6, tomatoGain: 0, ts: 3 })) // sync arrives
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 6, 'late-arriving delta folds on the next init')
})

test('U9a self-heal: own emitted keys missing from the shared index are re-added at init', async () => {
  globalThis.localStorage.setItem('gamification.deviceId', 'devme')
  globalThis.localStorage.setItem('gamification.lastDeltaKey', DELTA + 'devme:9')
  globalThis.localStorage.setItem('gamification.ownKeys', JSON.stringify([DELTA + 'devme:7', DELTA + 'devme:9']))
  metaMap.set(INDEX, JSON.stringify([])) // lost index race orphaned every own key

  const ctx = makeCtx({ snow: 0, tomatoGain: 0 })
  await auth.actions.initGamification(ctx)
  const idx = JSON.parse(metaMap.get(INDEX))
  assert.ok(idx.includes(DELTA + 'devme:9'), 'last-delta handle healed')
  assert.ok(idx.includes(DELTA + 'devme:7'), 'every own emitted key healed (round-1 P0), not just the last')
  // healed keys are own keys → skipped by the fold, totals untouched
  assert.equal(ctx.state.user.snow, 0)
  assert.equal(ctx.state.user.tomatoGain, 0)
})

test('initGamification is a no-op without the DB bridge (LS-only hosts keep their totals)', async () => {
  uninstallBridge()
  const ctx = makeCtx({ snow: 3, tomatoGain: 1 })
  await auth.actions.initGamification(ctx)
  assert.equal(ctx.state.user.snow, 3, 'nothing folded, nothing thrown')
  assert.equal(ctx.state.user.tomatoGain, 1)
})
