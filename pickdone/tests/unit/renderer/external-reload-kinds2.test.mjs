/**
 * externalReload.js — the meta / filter / category kind gate (round 2).
 * Complements d15-external-reload-kinds.test.mjs: exhaustive per-kind routing, the shared
 * 1s meta throttle, preserveHistory pass-through, and mixed/unknown kind behavior.
 * Run: node --test tests/unit/renderer/external-reload-kinds2.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const { createExternalReloader, normalizeRoundKinds, kindsFromChangedEvent } =
  await import('../../../renderer/js/utils/externalReload.js')

const flush = () => new Promise(r => setTimeout(r, 0))
const count = (arr, m) => arr.filter(x => x === m).length

/** Stub store recording dispatches; injected reload fns just increment counters. */
function harness (now) {
  const dispatched = []
  const calls = { estimates: 0, userTags: 0 }
  const reload = createExternalReloader({
    store: { dispatch: m => { dispatched.push(m); return Promise.resolve() } },
    reloadEstimates: () => { calls.estimates++; return Promise.resolve() },
    reloadUserTags: () => { calls.userTags++; return Promise.resolve() },
    now: now || (() => Date.now())
  })
  return { reload, dispatched, calls }
}

test('empty round kinds (plain CLI external write) keep the full conservative reload', async () => {
  const { reload, dispatched, calls } = harness()
  reload({}) // no kinds at all
  await flush()
  assert.equal(count(dispatched, 'todo/init'), 1, 'full todo/init for kind-less events')
  assert.equal(count(dispatched, 'category/init'), 1)
  assert.equal(count(dispatched, 'filters/load'), 1)
  assert.equal(calls.estimates, 1, 'meta ledgers refreshed conservatively too')
  assert.equal(calls.userTags, 1)
})

test('a pure filter round dispatches only filters/load', async () => {
  const { reload, dispatched, calls } = harness()
  reload({ kinds: ['filter'] })
  await flush()
  assert.deepEqual(dispatched, ['filters/load'])
  assert.equal(calls.estimates, 0, 'filter rounds must not refresh meta ledgers')
})

test('a pure category round dispatches only category/init', async () => {
  const { reload, dispatched, calls } = harness()
  reload({ kinds: ['category'] })
  await flush()
  assert.deepEqual(dispatched, ['category/init'])
  assert.equal(count(dispatched, 'todo/init'), 0)
  assert.equal(calls.estimates, 0)
})

test('a pure meta round dispatches nothing via store.dispatch — only the ledger reloads', async () => {
  const { reload, dispatched, calls } = harness()
  reload({ kinds: ['meta'] })
  await flush()
  assert.deepEqual(dispatched, [], 'meta rounds are the cheapest kind: no store dispatches')
  assert.equal(calls.estimates, 1)
  assert.equal(calls.userTags, 1, 'userTags rides the same meta round + throttle')
})

test('mixed cheap kinds (filter + category) refresh both without the full todo/init', async () => {
  const { reload, dispatched } = harness()
  reload({ kinds: ['category', 'filter'] })
  await flush()
  assert.deepEqual(dispatched.sort(), ['category/init', 'filters/load'])
  assert.equal(count(dispatched, 'todo/init'), 0)
})

test('one data kind in the mix forces the full todo/init but skips the cheap-only extras', async () => {
  const { reload, dispatched } = harness()
  reload({ kinds: ['todo', 'meta'] })
  await flush()
  assert.equal(count(dispatched, 'todo/init'), 1, 'todo kind → full reload is required')
  assert.equal(count(dispatched, 'category/init'), 0, 'category not in kinds → skipped')
  assert.equal(count(dispatched, 'filters/load'), 0, 'filter not in kinds → skipped')
})

test('unknown kinds are conservative: full todo/init, and only unknown-unknown extras skipped', async () => {
  const { reload, dispatched } = harness()
  reload({ kinds: ['purgeRecycleBin'] })
  await flush()
  assert.equal(count(dispatched, 'todo/init'), 1)
  assert.equal(count(dispatched, 'category/init'), 0, 'unknown kind does not imply category')
  assert.equal(count(dispatched, 'filters/load'), 0)
})

test('normalizeRoundKinds maps meta-table ops and preserves other kinds in order', () => {
  assert.deepEqual(normalizeRoundKinds(['deleteMeta', 'filter', 'setMetaMany']), ['meta', 'filter', 'meta'])
  assert.deepEqual(normalizeRoundKinds([]), null, 'empty kind list normalizes to null (conservative)')
  assert.equal(normalizeRoundKinds(undefined), null)
})

test('kindsFromChangedEvent trims whitespace and drops empty segments', () => {
  assert.deepEqual(kindsFromChangedEvent({ op: ' setMeta , filter , ' }), ['setMeta', 'filter'])
  assert.deepEqual(kindsFromChangedEvent({ reason: '  ' }), null, 'blank reason → kind-less')
})

test('the meta-ledger refresh is throttled to one per second across bursts', async () => {
  let clock = 1000000
  const { reload, calls } = harness(() => clock)
  reload({ kinds: ['meta'] }); await flush()
  clock += 400
  reload({ kinds: ['meta'] }); await flush()
  clock += 400
  reload({ kinds: ['meta'] }); await flush()
  assert.equal(calls.estimates, 1, 'three bursts within 1s → a single estimate refresh')
  assert.equal(calls.userTags, 1)
  clock += 1000
  reload({ kinds: ['meta'] }); await flush()
  assert.equal(calls.estimates, 2, 'after the throttle window the next meta round refreshes again')
})

test('a throttled meta round still runs its store dispatches (only the ledger path is throttled)', async () => {
  let clock = 5000000
  const { reload, dispatched } = harness(() => clock)
  reload({ kinds: ['filter'] })
  clock += 100 // far below the throttle window
  reload({ kinds: ['filter'] })
  await flush()
  assert.equal(count(dispatched, 'filters/load'), 2, 'filters/load is never throttled')
})

test('preserveHistory is passed through to the todo/init payload', async () => {
  const payloads = []
  const reload = createExternalReloader({
    store: { dispatch: (m, p) => { payloads.push([m, p]); return Promise.resolve() } },
    reloadEstimates: () => Promise.resolve(),
    reloadUserTags: () => Promise.resolve()
  })
  reload({ kinds: ['todo'], preserveHistory: true })
  await flush()
  assert.deepEqual(payloads[0], ['todo/init', { preserveHistory: true }])
  payloads.length = 0
  reload({ preserveHistory: true }) // kind-less conservative path
  await flush()
  assert.deepEqual(payloads[0], ['todo/init', { preserveHistory: true }])
})
