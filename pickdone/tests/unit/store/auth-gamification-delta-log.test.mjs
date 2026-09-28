/** Gamification delta-log contract tests (renderer/js/store/auth.js).
 *  The module header is the spec: own deltas are already inside the LS total (U1) so init folds
 *  ONLY peer keys; base-migration deltas fold as per-field max (idempotent); the folded-guard
 *  makes each peer delta fold exactly once (U2: only after a successful non-null read); peer
 *  subtotals fold per-generation (U9b: contribution = total − accounted − individually folded
 *  covered keys); the device compacts its own ≥7d deltas into a generation-growing subtotal;
 *  saveSnowGain dedups retries by dedupKey (maint-d7).
 * Run: node --test tests/unit/store/auth-gamification-delta-log.test.mjs */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import mod from '../../../renderer/js/store/auth.js'

const INDEX_KEY = 'gamification.delta.index'
const BASE_EMITTED_KEY = 'gamification.baseEmitted'
const P = 'gamification.delta.'

/** In-memory meta store + todoAPI bridge + Vuex-like harness. */
function makeHarness ({ snow = 10, tomatoGain = 2 } = {}) {
  const meta = new Map()
  const ls = globalThis.localStorage
  const w = globalThis.window
  w.todoAPI = {
    ...(w.todoAPI || {}),
    dbCall: async (op, params) => {
      if (op === 'getMeta') return meta.has(params) ? meta.get(params) : null
      if (op === 'setMeta') { meta.set(params[0], params[1]); return { accepted: 1 } }
      if (op === 'deleteMeta') { meta.delete(params); return { accepted: 1 } }
      return null
    },
    getMetaMany: async list => list.map(k => ({ key: k, value: meta.has(k) ? meta.get(k) : null })),
  }
  const state = { user: { snow, tomatoGain }, loggedIn: true }
  const patches = []
  const store = {
    state,
    commit (m, p) { patches.push([m, p]); mod.mutations[m](state, p) },
  }
  return { meta, ls, state, patches, store }
}

const peer = (s, t, extra = {}) => JSON.stringify({ snow: s, tomatoGain: t, ts: Date.now(), ...extra })

beforeEach(() => {
  // fresh per-device view + fresh meta bridge for every test
  for (const k of ['gamification.deviceId', 'gamification.folded', 'gamification.ownKeys', 'gamification.lastDeltaKey', 'gamification.gainDedup', 'gamification.seq']) {
    try { globalThis.localStorage.removeItem(k) } catch { /* ignore */ }
  }
})

test('initGamification folds PEER deltas exactly once; a second init is a no-op (folded guard)', async () => {
  const h = makeHarness()
  h.meta.set(INDEX_KEY, JSON.stringify([P + 'peerA:1', P + 'peerA:2']))
  h.meta.set(P + 'peerA:1', peer(5, 1))
  h.meta.set(P + 'peerA:2', peer(7, 2))
  await mod.actions.initGamification(h.store)
  assert.deepEqual(
    { snow: h.state.user.snow, tomatoGain: h.state.user.tomatoGain },
    { snow: 10 + 5 + 7, tomatoGain: 2 + 1 + 2 })
  // folded guard persisted
  const folded = JSON.parse(h.ls.getItem('gamification.folded'))
  assert.equal(folded[P + 'peerA:1'].s, 5)
  // second init: nothing new folds (guard hit), no additional patch
  const before = h.patches.length
  await mod.actions.initGamification(h.store)
  assert.equal(h.patches.length, before)
  assert.equal(h.state.user.snow, 22)
})

test('U1: OWN delta keys are skipped at init (their value is already in the LS total)', async () => {
  const h = makeHarness()
  // discover the generated device id, then plant an OWN delta in the shared index
  await mod.actions.initGamification(h.store) // also emits the one-time base migration
  assert.equal(h.meta.get(BASE_EMITTED_KEY), '1')
  const me = h.ls.getItem('gamification.deviceId')
  const ownKey = P + me + ':z1'
  const keys = JSON.parse(h.meta.get(INDEX_KEY))
  keys.push(ownKey)
  h.meta.set(INDEX_KEY, JSON.stringify(keys))
  h.meta.set(ownKey, peer(999, 999)) // would explode the total if folded
  const s0 = h.state.user.snow
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, s0, 'own delta not folded twice')
})

test('U2: a null (not-yet-synced) peer delta is retried on the next init, never marked folded', async () => {
  const h = makeHarness()
  h.meta.set(INDEX_KEY, JSON.stringify([P + 'peerC:1']))
  // peerC:1 deliberately absent from meta → null read
  await mod.actions.initGamification(h.store)
  const folded = JSON.parse(h.ls.getItem('gamification.folded') || '{}')
  assert.equal(folded[P + 'peerC:1'], undefined, 'null read must not join the guard')
  // the delta arrives; the next init folds it
  h.meta.set(P + 'peerC:1', peer(3, 0))
  const s0 = h.state.user.snow
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, s0 + 3)
})

test('base-migration deltas fold as per-field MAX (idempotent), not summed', async () => {
  const h = makeHarness({ snow: 10, tomatoGain: 2 })
  h.meta.set(BASE_EMITTED_KEY, '1') // suppress our own migration emission
  h.meta.set(INDEX_KEY, JSON.stringify([P + 'peerBase:1', P + 'peerBase:2']))
  h.meta.set(P + 'peerBase:1', peer(100, 0, { base: true }))
  h.meta.set(P + 'peerBase:2', peer(50, 9, { base: true }))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, Math.max(10, 100, 50))
  assert.equal(h.state.user.tomatoGain, Math.max(2, 0, 9))
})

test('U9b peer subtotal: folds only the not-yet-accounted generation (guard subtraction)', async () => {
  const h = makeHarness()
  // device already folded gen1's contribution (30) and an individually-covered key (20)
  h.ls.setItem('gamification.folded', JSON.stringify({
    [P + 'peerB:c']: { s: 30, t: 3, gen: 1 },
    [P + 'peerB:1']: { s: 20, t: 2 },
  }))
  const sk = P + 'peerB:c'
  h.meta.set(INDEX_KEY, JSON.stringify([sk]))
  // cumulative subtotal gen2 = 80; accounted = 30 (guard) + 20 (covered key individually folded) → +30
  h.meta.set(sk, JSON.stringify({ snow: 80, tomatoGain: 8, ts: Date.now(), gen: 2, compacted: [P + 'peerB:1'] }))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 10 + 30)
  const folded = JSON.parse(h.ls.getItem('gamification.folded'))
  assert.equal(folded[sk].gen, 2)
  assert.equal(folded[sk].s, 30)
})

test('U9b compaction: own ≥7d increment deltas fold into a generation-growing subtotal', async () => {
  const h = makeHarness()
  await mod.actions.initGamification(h.store) // emit base migration + seed device id
  const me = h.ls.getItem('gamification.deviceId')
  const oldKey = P + me + ':old1'
  const keys = JSON.parse(h.meta.get(INDEX_KEY) || '[]')
  keys.push(oldKey)
  h.meta.set(INDEX_KEY, JSON.stringify(keys))
  h.meta.set(oldKey, JSON.stringify({ snow: 4, tomatoGain: 1, ts: Date.now() - 8 * 86400000 }))
  h.ls.setItem('gamification.ownKeys', JSON.stringify([oldKey]))
  await mod.actions.initGamification(h.store)
  const sk = P + me + ':c'
  const subtotal = JSON.parse(h.meta.get(sk))
  assert.equal(subtotal.snow, 4)
  assert.equal(subtotal.gen, 1)
  assert.ok(subtotal.compacted.includes(oldKey))
  assert.equal(h.meta.has(oldKey), false, 'folded own key meta deleted')
  const nextKeys = JSON.parse(h.meta.get(INDEX_KEY))
  assert.ok(!nextKeys.includes(oldKey), 'folded key pruned from the shared index')
  assert.ok(nextKeys.includes(sk), 'subtotal key registered in the shared index')
  // OWN_KEYS_LS pruned so the self-heal does not resurrect dead keys
  assert.deepEqual(JSON.parse(h.ls.getItem('gamification.ownKeys')), [])
})

test('saveSnowGain: same dedupKey applied exactly once; bare-number legacy payload still works', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }) // the batch flush is a real 60s timer — mock + tick so no real timer leaks into later tests
  const h = makeHarness()
  await mod.actions.saveSnowGain(h.store, { gain: 5, dedupKey: 'focus-k1' })
  assert.equal(h.state.user.snow, 15)
  await mod.actions.saveSnowGain(h.store, { gain: 5, dedupKey: 'focus-k1' }) // completeFocus retry
  assert.equal(h.state.user.snow, 15, 'duplicate dedupKey must not double-apply')
  await mod.actions.saveSnowGain(h.store, 3) // legacy bare-number payload
  assert.equal(h.state.user.snow, 18)
  t.mock.timers.tick(60000) // flush the pending batch (5+3) and clear the module-level pending/timer
  assert.ok([...h.meta.keys()].some(k => k.startsWith('gamification.delta.')), 'batched delta emitted')
  // dedup guard is restart-stable (persisted to LS)
  assert.ok(JSON.parse(h.ls.getItem('gamification.gainDedup'))['focus-k1'])
  t.mock.timers.reset()
})

test('saveSnowGain batches increments into ≤1 delta per minute window (flush emits one delta)', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = makeHarness()
  await mod.actions.saveSnowGain(h.store, { gain: 2, dedupKey: 'b1' })
  await mod.actions.saveSnowGain(h.store, { gain: 3, dedupKey: 'b2' })
  assert.equal(h.state.user.snow, 15)
  t.mock.timers.tick(60000) // batch window elapses → the pending flush emits ONE combined delta
  const deltaKeys = [...h.meta.keys()].filter(k => k.startsWith(P) && !k.endsWith(':c') && k !== BASE_EMITTED_KEY)
  assert.equal(deltaKeys.length, 1, 'two gains inside the window batch into ONE delta')
  const payload = JSON.parse(h.meta.get(deltaKeys[0]))
  assert.deepEqual({ snow: payload.snow, tomatoGain: payload.tomatoGain }, { snow: 5, tomatoGain: 5 })
  t.mock.timers.reset()
})
