/* M2 fix 4 (2026-10-09): the relay adapter's timer registry was an append-only array — schedule()
 * (poll tick + every write-kick) pushed the setTimeout handle and nothing ever removed it, so a
 * long-lived process accumulated hundreds of DEAD handles per day. Fix: Set registry with
 * fire-time self-removal; the registry equals the LIVE pending timers at all times.
 * Red before the fix: fired timers stay in the array forever (size 3 / ~31 instead of 0 / 1).
 * Run: node --test tests/unit/main/m2-relay-timers.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRelayAdapter } = require('../../../src/main/relay-sync-adapter.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeAdapter () {
  return createRelayAdapter({
    nodeId: 'm2-test-node',
    settingsGet: () => null,
    settingsPut: () => {},
    loadStore: async () => { throw new Error('no store in this test') },
    importModules: async () => { throw new Error('no relay in this test') }, // rounds fail harmlessly into lastError
  })
}

test('M2 fix4: fired timers self-remove from the registry (pending-only invariant)', async () => {
  const a = makeAdapter()
  const { timers, schedule } = a.__test
  assert.equal(timers.size, 0)
  schedule(() => {}, 5)
  schedule(() => {}, 5)
  schedule(() => {}, 5)
  assert.equal(timers.size, 3, 'three live pending timers while unfired')
  await sleep(40)
  assert.equal(timers.size, 0,
    'RED before the fix: fired timers leaked in the array forever (size stayed 3)')
})

test('M2 fix4: a burst of write-kicks during polling leaves a bounded registry', async () => {
  const a = makeAdapter()
  a.start() // polling = true; the 5s start-delay tick is the one long-lived pending timer
  try {
    for (let i = 0; i < 30; i++) a.kick() // 30 debounced 250ms kick timers
    await sleep(400) // let every kick timer fire (each schedules one round; rounds fail harmlessly)
    assert.ok(a.__test.timers.size <= 2,
      `RED before the fix: the registry kept all 30 dead kick handles + the tick (got ${a.__test.timers.size}); ` +
      'now only live pending timers remain (the start-delay tick)')
  } finally {
    a.stop()
  }
  assert.equal(a.__test.timers.size, 0, 'stop() clears the registry completely')
})
