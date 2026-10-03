/**
 * tomatoEstimate.js — estimate clamping, lazy per-task fetch clamp, and prune semantics.
 * The estimate is stored in focus MINUTES, clamped to [0, 20] and rounded; n <= 0 removes the
 * entry (no negatives, no NaN, no fractional minutes ever reach state).
 * Run: node --test tests/unit/renderer/tomato-estimate2.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'

const flushMicro = () => new Promise(r => setTimeout(r, 5))
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const mod = await import('../../../renderer/js/utils/tomatoEstimate.js')
const { setEstimate, getEstimate, ensureEstimate, invalidateEstimateCache,
  pruneEstimates, pruneEstimatesForPurged, _testInternals } = mod
const state = _testInternals.state

// Capture the command-bus writes setEstimate fans out (meta put / meta delete per task).
let metaOps = null
let metaTable = null
function installBridge () {
  metaOps = []
  metaTable = new Map()
  globalThis.window.todoAPI = {
    dbCall: async (op, p) => {
      metaOps.push([op, p])
      if (op === 'getMeta') return metaTable.has(p) ? metaTable.get(p) : null
      if (op === 'setMeta') { metaTable.set(p[0], p[1]); return 'ok' }
      if (op === 'deleteMeta') { metaTable.delete(p); return 'ok' }
      return 'ok'
    }
  }
}
function uninstallBridge () { delete globalThis.window.todoAPI }
const wipe = () => {
  for (const k of Object.keys(state)) delete state[k]
  for (const k of [...Array(globalThis.localStorage.length).keys()].map(i => globalThis.localStorage.key(i))) {
    if (k.startsWith('tomatoEstimate')) globalThis.localStorage.removeItem(k)
  }
}

beforeEach(() => { wipe(); installBridge() })

/* ===== setEstimate clamping (bounds, rounding, no-negative, no-NaN) ===== */

test('setEstimate clamps to the 0..20 minute bound (high side)', () => {
  setEstimate('t-hi', 25)
  assert.equal(getEstimate('t-hi'), 20, 'over-cap estimate clamps to MAX=20')
  setEstimate('t-hi2', 20)
  assert.equal(getEstimate('t-hi2'), 20, 'MAX itself is kept')
})

test('setEstimate rounds fractional minutes and keeps small positive values', () => {
  setEstimate('t-frac', 1.4)
  assert.equal(getEstimate('t-frac'), 1, '1.4 rounds down to 1 (never a fraction)')
  setEstimate('t-frac2', 2.5)
  assert.equal(getEstimate('t-frac2'), 3, 'Math.round: .5 rounds up')
  setEstimate('t-one', 1)
  assert.equal(getEstimate('t-one'), 1)
})

test('setEstimate with n <= 0 removes the entry — no negative or zero values stored', () => {
  setEstimate('t-del', 5)
  assert.equal(getEstimate('t-del'), 5)
  setEstimate('t-del', 0)
  assert.equal(getEstimate('t-del'), 0, 'zeroed estimate reads as absent')
  assert.equal('t-del' in state, false, 'the mirror key is deleted, not set to 0')
  setEstimate('t-neg', 4)
  setEstimate('t-neg', -3)
  assert.equal('t-neg' in state, false, 'negative n must never land in state')
})

test('setEstimate treats NaN/undefined n as a removal (no NaN in the mirror)', () => {
  setEstimate('t-nan', 5)
  setEstimate('t-nan', NaN)
  assert.equal('t-nan' in state, false, 'NaN rounds/clamps through ||0 to a removal')
  setEstimate('t-undef', undefined)
  assert.equal('t-undef' in state, false)
  assert.equal(getEstimate('missing-id'), 0, 'absent ids read 0')
})

test('setEstimate dual-writes the per-task meta key: put for n>0, delete for n<=0', async () => {
  setEstimate('t-io', 12)
  await flushMicro()
  assert.ok(metaOps.some(([op, p]) => op === 'setMeta' && p[0] === 'tomatoEstimateState:t-io' && p[1] === '12'),
    'per-task key written via the command bus (meta.put)')
  setEstimate('t-io', 0)
  await flushMicro()
  assert.ok(metaOps.some(([op, p]) => op === 'deleteMeta' && p === 'tomatoEstimateState:t-io'),
    'n<=0 deletes the per-task meta key')
  // the LWW timestamp key is LS-only (persist writes it via localStorage, never meta)
  assert.ok(Number(globalThis.localStorage.getItem('tomatoEstimateStateAt')) > 0,
    'LS timestamp stamp written for the CLI LWW tie-break')
})

test('setEstimate without a taskId is a no-op', () => {
  setEstimate('', 5)
  setEstimate(null, 5)
  assert.deepEqual(Object.keys(state), [])
})

/* ===== lazy read-through fetch (flushCold clamps before landing values) ===== */


test('ensureEstimate clamps a peer-written raw meta value into [0,20] before it lands', async () => {
  metaTable.set('tomatoEstimateState:t-lazy', '44.7') // CLI/peer wrote an out-of-range value
  await ensureEstimate('t-lazy')
  assert.equal(getEstimate('t-lazy'), 20, 'raw meta value is rounded and clamped on landing')
  assert.equal(state['t-lazy'], 20, 'value is memoized in the reactive mirror')

  metaTable.set('tomatoEstimateState:t-lazy2', '3.2')
  await ensureEstimate('t-lazy2')
  assert.equal(getEstimate('t-lazy2'), 3)
})

test('ensureEstimate drops non-positive / non-numeric meta values (no negative, no NaN)', async () => {
  metaTable.set('tomatoEstimateState:t-bad', '-2')
  await ensureEstimate('t-bad')
  assert.equal('t-bad' in state, false, 'negative estimate never lands')

  metaTable.set('tomatoEstimateState:t-junk', 'not-a-number')
  await ensureEstimate('t-junk')
  assert.equal('t-junk' in state, false, 'unparseable value never lands')

  metaTable.set('tomatoEstimateState:t-zero', '0')
  await ensureEstimate('t-zero')
  assert.equal('t-zero' in state, false, 'a zero meta value is equivalent to no estimate')
})

test('ensureEstimate is memoized per id (no repeated IPC for the same id)', async () => {
  metaTable.set('tomatoEstimateState:t-memo', '5')
  await ensureEstimate('t-memo')
  const readsAfterFirst = metaOps.filter(([op]) => op === 'getMeta').length
  await ensureEstimate('t-memo')
  await ensureEstimate('t-memo')
  assert.equal(metaOps.filter(([op]) => op === 'getMeta').length, readsAfterFirst,
    'the fetched Set memoizes the id; later calls cost no IPC')
})

test('local setEstimate is authoritative — no re-fetch IPC for that id afterwards', async () => {
  setEstimate('t-auth', 9)
  const readsBefore = metaOps.filter(([op]) => op === 'getMeta').length
  await ensureEstimate('t-auth')
  assert.equal(metaOps.filter(([op]) => op === 'getMeta').length, readsBefore,
    'the epoch guard must short-circuit a locally written value')
  assert.equal(getEstimate('t-auth'), 9)
})

test('ensureEstimate is a no-op without the DB bridge', async () => {
  uninstallBridge()
  await ensureEstimate('t-nobridge')
  assert.equal(getEstimate('t-nobridge'), 0)
})

/* ===== pruning ===== */

test('pruneEstimates drops every id outside the alive set (string-keyed), reports change', async () => {
  setEstimate('a', 1); setEstimate('b', 2); setEstimate('c', 3)
  assert.equal(pruneEstimates(['a', 'b']), true, 'something was removed')
  assert.deepEqual(Object.keys(state).sort(), ['a', 'b'])
  assert.equal(pruneEstimates(['a', 'b']), false, 'second prune is a no-op → false')
})

test('pruneEstimatesForPurged normalizes both sides through String (numeric id domain)', async () => {
  state['12'] = 7 // e.g. a recycled numeric id resurrecting a stale estimate
  state['other'] = 4
  assert.equal(pruneEstimatesForPurged([12]), true, 'numeric 12 must match string key "12"')
  assert.equal('12' in state, false)
  assert.equal(state['other'], 4, 'unrelated keys survive')
  assert.equal(pruneEstimatesForPurged([]), false)
  assert.equal(pruneEstimatesForPurged(null), false, 'null purged list is a safe no-op')
})

/* ===== capacity bound ===== */

test('MAX_KEYS bound is 5000 (mirror stays bounded)', () => {
  assert.equal(_testInternals.MAX_KEYS, 5000)
})

test('invalidateEstimateCache clears the memoization so the next read re-fetches', async () => {
  metaTable.set('tomatoEstimateState:t-inv', '5')
  await ensureEstimate('t-inv')
  const reads1 = metaOps.filter(([op]) => op === 'getMeta').length
  await ensureEstimate('t-inv')
  assert.equal(metaOps.filter(([op]) => op === 'getMeta').length, reads1)
  invalidateEstimateCache()
  await ensureEstimate('t-inv') // cache epoch bumped → the id is cold again
  assert.ok(metaOps.filter(([op]) => op === 'getMeta').length > reads1, 'invalidated id re-fetched')
})
