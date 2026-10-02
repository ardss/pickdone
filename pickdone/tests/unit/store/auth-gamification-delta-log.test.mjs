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

test('subtotal payload: compacted list ages out past the retention window (bounded payload, leak-gamification-subtotal-compacted-array)', async () => {
  const h = makeHarness()
  await mod.actions.initGamification(h.store) // seed device id + base migration
  const me = h.ls.getItem('gamification.deviceId')
  const sk = P + me + ':c'
  const DAY = 86400000
  const now = Date.now()
  // gen 1: compact one ≥7d own delta — the payload lists it with its cover time
  const k1 = P + me + ':g1'
  h.meta.set(INDEX_KEY, JSON.stringify([k1]))
  h.meta.set(k1, JSON.stringify({ snow: 4, tomatoGain: 1, ts: now - 8 * DAY }))
  h.ls.setItem('gamification.ownKeys', JSON.stringify([k1]))
  await mod.actions.initGamification(h.store)
  let subtotal = JSON.parse(h.meta.get(sk))
  assert.deepEqual(subtotal.compacted, [k1])
  assert.ok(subtotal.compactedTs && subtotal.compactedTs[k1] > now - 60000, 'cover time recorded')
  // gen 2 (cover time of k1 aged past the 30d retention window): compact another delta
  const k2 = P + me + ':g2'
  const keys = JSON.parse(h.meta.get(INDEX_KEY)); keys.push(k2); h.meta.set(INDEX_KEY, JSON.stringify(keys))
  h.meta.set(k2, JSON.stringify({ snow: 2, tomatoGain: 0, ts: now - 8 * DAY }))
  h.ls.setItem('gamification.ownKeys', JSON.stringify([k2]))
  const st = JSON.parse(h.meta.get(sk)); st.compactedTs[k1] = now - 31 * DAY
  h.meta.set(sk, JSON.stringify(st))
  await mod.actions.initGamification(h.store)
  subtotal = JSON.parse(h.meta.get(sk))
  assert.equal(subtotal.gen, 2)
  assert.equal(subtotal.snow, 6)
  assert.deepEqual(subtotal.compacted, [k2], 'aged compacted entry dropped from the payload')
  assert.equal(subtotal.compactedTs[k1], undefined, 'aged cover-time entry dropped too')
})

test('peer subtotal: cumulative absorbed accounting is drift-free across generations even when the payload ages out entries (leak-gamification-subtotal-compacted-array)', async () => {
  const h = makeHarness()
  const sk = P + 'pX:c'
  const k1 = P + 'pX:1'
  const k2 = P + 'pX:2'
  const k3 = P + 'pX:3'
  // gen1: total 50 (k1=20 covered); this device folded k1 individually before the subtotal existed
  h.ls.setItem('gamification.folded', JSON.stringify({ [k1]: { s: 20, t: 2 } }))
  h.meta.set(INDEX_KEY, JSON.stringify([sk]))
  h.meta.set(sk, JSON.stringify({ snow: 50, tomatoGain: 5, ts: Date.now(), gen: 1, compacted: [k1] }))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 10 + 30, 'gen1 contributes only the un-accounted 30')
  // gen2: k2(10) covered too, total 60 — but this device already folded k2 individually → +0
  const folded1 = JSON.parse(h.ls.getItem('gamification.folded'))
  folded1[k2] = { s: 10, t: 1 }
  h.ls.setItem('gamification.folded', JSON.stringify(folded1))
  h.meta.set(sk, JSON.stringify({ snow: 60, tomatoGain: 6, ts: Date.now(), gen: 2, compacted: [k1, k2] }))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 40, 'gen2 adds nothing (everything already accounted)')
  // gen3: k3(5) covered, total 65; the payload has aged k1/k2 out (compacted = [k3] only) —
  // the guard's cumulative absorbed total must keep the accounting drift-free. This device
  // folded k3 individually too, so everything is pre-accounted.
  const folded2 = JSON.parse(h.ls.getItem('gamification.folded'))
  folded2[k3] = { s: 5, t: 0 }
  h.ls.setItem('gamification.folded', JSON.stringify(folded2))
  h.meta.set(sk, JSON.stringify({ snow: 65, tomatoGain: 6, ts: Date.now(), gen: 3, compacted: [k3] }))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 40, 'gen3 adds nothing (k3 5 is inside the absorbed total, not a new gain)')
  const folded3 = JSON.parse(h.ls.getItem('gamification.folded'))
  assert.equal(folded3[sk].absorbed, 65, 'guard carries the cumulative accounted amount')
})

test('folded guard: guards absorbed into a subtotal generation are pruned once their meta rows are gone; live-meta guards are kept (leak-gamification-folded-ls-never-pruned)', async () => {
  const h = makeHarness()
  const sk = P + 'pY:c'
  const k1 = P + 'pY:1' // meta deleted by the owner's compaction → guard becomes prunable
  const k2 = P + 'pY:2' // meta still live (lost owner-side delete) → guard must be kept
  h.ls.setItem('gamification.folded', JSON.stringify({ [k1]: { s: 20, t: 2 }, [k2]: { s: 10, t: 1 } }))
  h.meta.set(INDEX_KEY, JSON.stringify([sk, k2]))
  h.meta.set(sk, JSON.stringify({ snow: 50, tomatoGain: 5, ts: Date.now(), gen: 2, compacted: [k1, k2] }))
  h.meta.set(k2, peer(10, 1))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 10 + 20, 'contribution = 50 − 20 (k1) − 10 (k2, folded individually)')
  const folded = JSON.parse(h.ls.getItem('gamification.folded'))
  assert.equal(folded[k1], undefined, 'absorbed guard with dead meta pruned from FOLDED_LS')
  assert.ok(folded[k2], 'live-meta guard kept — refold safety if the owner retries the delete')
  assert.equal(folded[sk].absorbed, 50, 'both amounts now live inside the subtotal guard')
  // second init: gen unchanged → no new fold, and the live-meta key is still guard-protected
  const s0 = h.state.user.snow
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, s0)
})

test('shared index: entries whose meta stays null past the grace window are pruned; readable entries never are (leak-gamification-index-dead-peers)', async () => {
  const h = makeHarness()
  const DAY = 86400000
  const deadKey = P + 'gone:1' // retired device — meta row never arrives
  const liveKey = P + 'live:1'
  h.meta.set(INDEX_KEY, JSON.stringify([deadKey, liveKey]))
  h.meta.set(liveKey, peer(3, 0))
  await mod.actions.initGamification(h.store)
  assert.equal(h.state.user.snow, 13)
  const index0 = JSON.parse(h.meta.get(INDEX_KEY))
  assert.ok(index0.includes(deadKey) && index0.includes(liveKey), 'first null read stays inside the grace window (U2 retry preserved)')
  assert.ok(JSON.parse(h.ls.getItem('gamification.indexNullSeen'))[deadKey], 'null read tracked with a timestamp')
  // age the dead entry past the 30d grace window, then re-init
  const seen = JSON.parse(h.ls.getItem('gamification.indexNullSeen'))
  seen[deadKey] = Date.now() - 31 * DAY
  h.ls.setItem('gamification.indexNullSeen', JSON.stringify(seen))
  await mod.actions.initGamification(h.store)
  const keys = JSON.parse(h.meta.get(INDEX_KEY))
  assert.ok(!keys.includes(deadKey), 'dead index entry pruned from the shared index')
  assert.ok(keys.includes(liveKey), 'readable entry never pruned')
  assert.equal(JSON.parse(h.ls.getItem('gamification.indexNullSeen'))[deadKey], undefined, 'tracking entry dropped too')
  // the live delta is not re-folded by the rewrites
  assert.equal(h.state.user.snow, 13)
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
