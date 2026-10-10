import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { createRevisionStore, commitLocal } from '../../../shared/sync-core/causality/merge.mjs'
import { Hlc } from '../../../shared/sync-core/clock/hlc.mjs'
import { generateAccountRootKey } from '../../../shared/sync-crypto/e2e.mjs'
const require = createRequire(import.meta.url)
const { createRelayAdapter, isLoopbackBaseUrl, REMOTE_GATE_ENV } = require('../../../src/main/relay-sync-adapter')

/** In-memory settings door with the adapter's raw string semantics. */
function memSettings () {
  const m = new Map()
  return {
    get: k => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)) },
    dump: () => Object.fromEntries(m),
  }
}

async function withRelay (t) {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  return { relay, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

/** Adapter over a synthetic revision store (no app db — unit scope). */
function makeAdapter (t, { settings, baseUrl, store, nodeId = 'unit-node', ...rest } = {}) {
  const st = settings || memSettings()
  const localStore = store || createRevisionStore(nodeId)
  const a = createRelayAdapter({
    nodeId,
    settingsGet: st.get,
    settingsPut: st.put,
    loadStore: async () => localStore,
    fetchImpl: global.fetch,
    env: {},
    sleep: async () => {},
    ...rest,
  })
  t.after(() => a.stop())
  return { adapter: a, settings: st, store: localStore }
}

const fakeHlc = (nodeId = 'unit-node') => new Hlc(nodeId)

test('adapter: default OFF — round skipped, nothing stored, nothing sent', async t => {
  const { adapter, settings } = makeAdapter(t, {})
  const s = adapter.status()
  assert.equal(s.enabled, false)
  const r = await adapter.round()
  assert.equal(r.skipped, 'disabled')
  assert.equal(Object.keys(settings.dump()).length, 0, 'default-off persists nothing')
})

test('adapter: enable generates + persists an E2E root key; re-enable reuses it', async t => {
  const { baseUrl } = await withRelay(t)
  const { adapter, settings } = makeAdapter(t, { baseUrl })
  const s1 = await adapter.enable({ account: 'acc-1', baseUrl })
  assert.equal(s1.enabled, true)
  const k1 = settings.get('rootKey')
  assert.match(k1, /^[0-9a-f]{64}$/, 'generated root key is 64-hex')
  assert.equal(s1.hasDeviceSecret, true, 'registered during enable')
  await adapter.disable()
  await adapter.enable({ account: 'acc-1', baseUrl })
  assert.equal(settings.get('rootKey'), k1, 'root key survives disable/re-enable')
})

test('adapter: enable accepts an injected rootKey (simulated cross-device pairing) and validates it', async t => {
  const { baseUrl } = await withRelay(t)
  const shared = generateAccountRootKey()
  const { adapter, settings } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl, rootKey: shared })
  assert.equal(settings.get('rootKey'), shared)
  await assert.rejects(() => adapter.enable({ account: 'acc', baseUrl, rootKey: 'nothex' }), /64 hex/)
})

test('adapter: enable input validation — account shape, baseUrl scheme, credentials in URL', async t => {
  const { adapter } = makeAdapter(t, {})
  await assert.rejects(() => adapter.enable({ account: 'bad account!', baseUrl: 'http://127.0.0.1:1' }), /account/)
  await assert.rejects(() => adapter.enable({ account: 'a', baseUrl: 'not-a-url' }), /URL/)
  await assert.rejects(() => adapter.enable({ account: 'a', baseUrl: 'ftp://127.0.0.1:1' }), /http/)
  await assert.rejects(() => adapter.enable({ account: 'a', baseUrl: 'http://u:p@127.0.0.1:1' }), /bare origin/)
})

test('adapter: remote relay refused unless the env gate is set (production gate)', async t => {
  const { adapter, settings } = makeAdapter(t, {})
  await assert.rejects(
    () => adapter.enable({ account: 'acc', baseUrl: 'https://relay.example.com' }),
    new RegExp(REMOTE_GATE_ENV),
  )
  assert.equal(adapter.status().enabled, false, 'refused enable persists nothing')
  assert.equal(settings.get('enabled'), null)
  // gate unlock: enable proceeds on user intent even though the remote host is unreachable —
  // the flag is the user's word; status.lastError carries the truth (register retried per round).
  const { adapter: gated } = makeAdapter(t, { env: { [REMOTE_GATE_ENV]: '1' } })
  const s = await gated.enable({ account: 'acc', baseUrl: 'https://relay.example.com' })
  assert.equal(s.enabled, true)
  assert.equal(gated.status().remoteAllowed, true)
})

test('adapter: E2E mandatory — a torn/missing root key fails the round, never degrades to plaintext', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const { adapter, settings } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl })
  settings.put('rootKey', '') // simulate a torn secret store
  const r = await adapter.round()
  assert.equal(r.ok, false)
  assert.match(r.error, /refusing to sync without encryption/)
  assert.equal(relay.store.__dump().envelopes.length, 0, 'nothing was pushed')
})

test('adapter: durable restart — cursor + pushed-set resume, device secret attached (no re-register)', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const { adapter, settings, store } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl })
  const secret1 = settings.get('deviceSecret')
  assert.ok(secret1)

  commitLocal(store, { entity: 'todo', entityId: 'r1', clock: fakeHlc(), payload: { title: 'a' } })
  const r1 = await adapter.round()
  assert.equal(r1.ok, true, r1.error || '')
  assert.ok(r1.pushed >= 1)
  const state1 = JSON.parse(settings.get('state'))
  assert.ok(state1.cursor > 0, 'cursor persisted after a successful round')
  assert.ok(state1.pushed.length >= 1, 'pushed-set persisted')
  const dump1 = relay.store.__dump()

  // "restart": a fresh adapter instance over the SAME durable settings
  const { adapter: a2 } = makeAdapter(t, { baseUrl, settings, store })
  const r2 = await a2.round()
  assert.equal(r2.ok, true)
  assert.equal(r2.pushed, 0, 'nothing re-pushed: durable pushed-set suppresses it')
  const dump2 = relay.store.__dump()
  assert.equal(dump2.envelopes.length, dump1.envelopes.length, 'no duplicate envelopes on the relay')
  assert.equal(dump2.devices.length, 1, 'no re-register: the persisted secret was attached')
  assert.equal(settings.get('deviceSecret'), secret1, 'secret unchanged across restart rounds')
})

test('adapter: retry idempotency — network blips and 5xx retry with backoff, no duplicate envelopes', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const realFetch = global.fetch
  let failures = 0
  const flaky = async (url, opts) => {
    failures++
    if (failures <= 2) throw new Error('ECONNRESET (simulated)') // network throws: retryable
    if (failures === 3) return new Response(JSON.stringify({ error: 'boom' }), { status: 503 }) // 5xx: retryable
    return realFetch(url, opts)
  }
  const { adapter, store } = makeAdapter(t, { baseUrl, fetchImpl: flaky, retryMax: 4 })
  await adapter.enable({ account: 'acc', baseUrl })
  commitLocal(store, { entity: 'todo', entityId: 'f1', clock: fakeHlc(), payload: { title: 'flaky' } })
  const r = await adapter.round()
  assert.equal(r.ok, true, `round survived blips: ${r.error || ''}`)
  assert.ok(failures >= 4, 'retries actually happened')
  const opIds = relay.store.__dump().envelopes.map(e => e.opId)
  assert.equal(new Set(opIds).size, opIds.length, 'relay saw no duplicate opIds despite retries')
})

test('adapter: permanent failure class fails the round without retry storms', async t => {
  let posts = 0
  const realFetch = global.fetch
  const counting = (url, opts) => { posts++; return realFetch(url, opts) }
  const { adapter } = makeAdapter(t, { baseUrl: 'http://127.0.0.1:1', fetchImpl: counting, retryMax: 3 })
  await adapter.enable({ account: 'acc', baseUrl: 'http://127.0.0.1:1' })
  const r = await adapter.round()
  assert.equal(r.ok, false)
  // dead origin = network throw = retryable: enable's round + this round each burn at most
  // retryMax attempts — bounded (no storm), and NOT retried across rounds within a step.
  assert.ok(posts >= 4 && posts <= 6, `bounded retries only (posts=${posts})`)
})

test('adapter: 401 recovery — rebooted relay (fresh store) re-registers, persists the ROTATED secret, resets durable state, replays everything', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const { adapter, settings, store } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl })
  const secret1 = settings.get('deviceSecret')
  commitLocal(store, { entity: 'todo', entityId: 'q1', clock: fakeHlc(), payload: { title: 'q' } })
  await adapter.round()
  assert.ok(JSON.parse(settings.get('state')).cursor > 0)

  // the relay loses its whole store (torn-state reboot drill, D25): a NEW relay instance on a
  // new port — the device row, seq space and ack floor are all gone; the client reconnects to
  // it with its STALE credential and STALE durable cursor.
  const { relay: relay2, baseUrl: url2 } = await withRelay(t)
  settings.put('baseUrl', url2)
  void relay
  const r1 = await adapter.round() // 401 -> re-register (secret rotated + persisted) -> headSeq<cursor regression reset
  assert.equal(r1.ok, true, r1.error || '')
  const r2 = await adapter.round() // durable state now reset -> full re-push onto the new store
  assert.equal(r2.ok, true)
  assert.ok(r2.pushed >= 1, 'revisions re-pushed after the registry loss')
  const secret2 = settings.get('deviceSecret')
  assert.notEqual(secret2, secret1, 'rotated secret persisted through the onDeviceSecret hook')
  const dump = relay2.store.__dump()
  assert.equal(dump.devices.length, 1)
  assert.ok(dump.envelopes.length >= 1, 'full re-push after the registry loss')
  const state2 = JSON.parse(settings.get('state'))
  assert.ok(state2.cursor > 0, 'cursor re-advanced on the new store')
  assert.deepEqual(new Set(state2.pushed), new Set(dump.envelopes.map(e => e.opId)),
    'durable pushed-set matches exactly what the new relay store holds')
})

test('adapter: oversize chunking — a tiny per-POST budget splits pushes across requests', async t => {
  const { baseUrl, relay } = await withRelay(t)
  const { adapter, store } = makeAdapter(t, { baseUrl, pushChunkBytes: 64 })
  await adapter.enable({ account: 'acc', baseUrl })
  const clock = fakeHlc()
  for (let i = 0; i < 5; i++) commitLocal(store, { entity: 'todo', entityId: 'c' + i, clock, payload: { title: 'chunked item number ' + i } })
  const r = await adapter.round()
  assert.equal(r.ok, true, r.error || '')
  assert.equal(relay.store.__dump().envelopes.length, 5, 'all revisions landed despite per-chunk splits')
  assert.ok(adapter.status().cursor > 0)
})

test('adapter: disable stops rounds; forget wipes config + secrets + durable state', async t => {
  const { baseUrl } = await withRelay(t)
  const { adapter, settings } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl })
  await adapter.disable()
  assert.equal(adapter.status().enabled, false)
  assert.ok(settings.get('deviceSecret'), 'disable retains the credential for re-enable')
  const r = await adapter.round()
  assert.equal(r.skipped, 'disabled')
  await adapter.forget()
  const dump = settings.dump()
  for (const k of Object.keys(dump)) assert.ok(dump[k] === '', `key ${k} cleared on forget`)
  assert.equal(adapter.status().hasDeviceSecret, false)
})

test('adapter: pushed-set persistence cap trims oldest entries (dedupe-safe re-push)', t => {
  const { adapter } = makeAdapter(t, {})
  const { persistState, loadPersistedState, MAX_PERSISTED_PUSHED } = adapter.__test
  const pushed = Array.from({ length: MAX_PERSISTED_PUSHED + 10 }, (_, i) => 'rev-' + i)
  persistState({ cursor: 99, pushed })
  const restored = loadPersistedState()
  assert.equal(restored.pushed.length, MAX_PERSISTED_PUSHED)
  assert.equal(restored.pushed[0], 'rev-10', 'oldest entries dropped')
  assert.equal(restored.cursor, 99)
})

test('adapter: state persistence is change-gated (no-op rounds do not rewrite the mega-row)', async t => {
  const { baseUrl } = await withRelay(t)
  const { adapter, settings } = makeAdapter(t, { baseUrl })
  await adapter.enable({ account: 'acc', baseUrl })
  const afterEnable = settings.get('state')
  const r1 = await adapter.round()
  const r2 = await adapter.round()
  assert.equal(r1.ok && r2.ok, true)
  assert.equal(settings.get('state'), afterEnable, 'unchanged cursor/pushed -> byte-identical, no rewrite')
})

test('adapter: round coalescing — concurrent round() calls share one execution', async t => {
  const { baseUrl } = await withRelay(t)
  let loads = 0
  const store2 = createRevisionStore('unit-node')
  const { adapter } = makeAdapter(t, { baseUrl, loadStore: async () => { loads++; return store2 } })
  await adapter.enable({ account: 'acc', baseUrl })
  loads = 0
  const [x, y] = await Promise.all([adapter.round(), adapter.round()])
  assert.equal(x.ok && y.ok, true)
  assert.equal(loads, 1, 'coalesced into one loadStore/round execution')
})

test('adapter: loadStore failure lands in lastError, durable state untouched', async t => {
  const { baseUrl } = await withRelay(t)
  const { adapter, settings } = makeAdapter(t, { baseUrl, loadStore: async () => { throw new Error('db closed') } })
  await adapter.enable({ account: 'acc', baseUrl })
  const r = await adapter.round()
  assert.equal(r.ok, false)
  assert.match(r.error, /db closed/)
  assert.equal(settings.get('state'), null, 'no durable state written for a failed round')
})

test('adapter: isLoopbackBaseUrl classifies hosts', () => {
  assert.equal(isLoopbackBaseUrl('http://127.0.0.1:58480'), true)
  assert.equal(isLoopbackBaseUrl('http://localhost:1'), true)
  assert.equal(isLoopbackBaseUrl('http://[::1]:1'), true)
  assert.equal(isLoopbackBaseUrl('https://relay.example.com'), false)
  assert.equal(isLoopbackBaseUrl('http://0.0.0.0/'), false, '0.0.0.0 is not a loopback dial target')
  assert.equal(isLoopbackBaseUrl('not a url'), false)
})
