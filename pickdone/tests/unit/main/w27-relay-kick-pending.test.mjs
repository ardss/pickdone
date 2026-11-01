/* W27 maintenance round — fix 2 (P2): relay-sync-adapter kick() while a round is in flight.
 * The old `if (!polling || inFlight) return` silently DROPPED a write-kick that arrived while
 * a round was running — the local write it signals then waited up to roundIntervalMs (5min in
 * production) for the next poll tick. Now the kick is QUEUED (kickPending) and round()'s
 * finally schedules a 250ms catch-up round, honoring the contract the kick docblock always
 * claimed ("at most one queued round plus the running one").
 * Run: node --test tests/unit/main/w27-relay-kick-pending.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { createRevisionStore } from '../../../shared/sync-core/causality/merge.mjs'

const require = createRequire(import.meta.url)
const { createRelayAdapter } = require('../../../src/main/relay-sync-adapter')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function memSettings () {
  const m = new Map()
  return {
    get: k => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)) },
  }
}

async function withRelay (t) {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  return { baseUrl: `http://127.0.0.1:${server.address().port}` }
}

function makeAdapter (t, baseUrl, applyPulled) {
  const st = memSettings()
  const a = createRelayAdapter({
    nodeId: 'w27-node',
    settingsGet: st.get,
    settingsPut: st.put,
    loadStore: async () => createRevisionStore('w27-node'),
    fetchImpl: global.fetch,
    env: {},
    sleep: async () => {},
    applyPulled,
    // a poll interval far beyond the test window: the ONLY way a second round can appear is
    // the queued kick — the periodic tick must not be able to rescue the old dropped kick.
    roundIntervalMs: 10 * 60 * 1000,
  })
  t.after(() => a.stop())
  return a
}

test('W27 fix 2: a kick during an in-flight round schedules a catch-up round (not dropped)', async t => {
  const { baseUrl } = await withRelay(t)
  let applyCalls = 0
  const adapter = makeAdapter(t, baseUrl, async () => {
    applyCalls++
    if (applyCalls >= 2) await sleep(250) // only the observed round is slowed
    return { businessApplied: 0, businessSkipped: 0 }
  })
  const s1 = await adapter.enable({ account: 'acc-w27', baseUrl })
  assert.equal(s1.enabled, true)
  const roundsAfterEnable = s1.rounds

  // start a manual round and kick WHILE it is in flight
  const r = adapter.round()
  await sleep(50) // let the round enter the pull/ack phase (applyPulled)
  adapter.kick()
  const res = await r
  assert.equal(res.ok, true, JSON.stringify(res))
  const roundsAfterKick = adapter.status().rounds
  assert.equal(roundsAfterKick, roundsAfterEnable + 1)

  // the queued catch-up round must fire within the 250ms window + slack — with the old code
  // nothing would fire until roundIntervalMs (10min here).
  await sleep(900)
  assert.equal(adapter.status().rounds, roundsAfterKick + 1,
    'the kick that arrived mid-round must produce exactly one catch-up round')
})

test('W27 fix 2b: a kick while idle still schedules one round; bursts coalesce', async t => {
  const { baseUrl } = await withRelay(t)
  const adapter = makeAdapter(t, baseUrl, async () => ({ businessApplied: 0, businessSkipped: 0 }))
  await adapter.enable({ account: 'acc-w27b', baseUrl }, { deferStart: true })
  adapter.start() // deferStart skips start() — polling must be on for kick() to schedule
  const before = adapter.status().rounds
  adapter.kick()
  adapter.kick()
  adapter.kick() // burst: coalesces into the single already-scheduled round
  await sleep(900)
  assert.equal(adapter.status().rounds, before + 1, 'idle kicks coalesce into one 250ms round')
})

test('W27 fix 2c: kick() while polling=false is a no-op (stop() is respected)', async t => {
  const { baseUrl } = await withRelay(t)
  const adapter = makeAdapter(t, baseUrl, async () => ({ businessApplied: 0, businessSkipped: 0 }))
  await adapter.enable({ account: 'acc-w27c', baseUrl }, { deferStart: true })
  adapter.stop()
  const before = adapter.status().rounds
  adapter.kick()
  await sleep(600)
  assert.equal(adapter.status().rounds, before, 'kick on a stopped adapter schedules nothing')
})
