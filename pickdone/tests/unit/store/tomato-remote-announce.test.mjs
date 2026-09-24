/** Remote running-tomato store (feature regression tests):
 *  - the renderer store keeps a per-device `remote` map, drops stale entries, prunes;
 *  - 'tomato-announce' syncEvents land via init; the snapshot reload fills on startup;
 *  - announceLocal composes the payload from the live tomato state (running vs idle);
 *  - CONTRACT MIRROR: the renderer shared helpers produce IDENTICAL results to the
 *    main-process tomato-announce.js on the same fixtures (two copies kept in lockstep).
 * Run: node --test tests/unit/store/tomato-remote-announce.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import mod from '../../../renderer/js/store/tomatoAnnounce.js'
import { buildAnnounceValue, isStaleAnnounce, remainSecOfAnnounce } from '../../../renderer/js/store/helpers/tomatoAnnounceShared.js'

const require = createRequire(import.meta.url)
const taMain = require('../../../src/main/tomato-announce.js')

/** Minimal Vuex-like module harness (mutations/actions/getters run against a real state object). */
function makeStore ({ tomatoState = {}, announceList = [] } = {}) {
  const state = { remote: {}, inited: false }
  const rootState = { tomato: { status: 'default', startedAt: 0, tomatoTime: 25, attachTodo: null, ...tomatoState }, settings: {} }
  const dispatched = []
  const calls = []
  const w = globalThis.window = globalThis.window || {}
  w.todoAPI = {
    ...(globalThis.window && globalThis.window.todoAPI),
    onSyncEvent (fn) { calls.push(['onSyncEvent', fn]); return () => {} },
    tomatoRunAnnounces: async () => announceList,
    tomatoRunAnnounce: p => { calls.push(['announce', p]); return true },
  }
  const g = {}
  g.remoteRunning = () => mod.getters.remoteRunning(state)
  g.primaryRunning = () => mod.getters.primaryRunning(state, { remoteRunning: g.remoteRunning() })
  const store = {
    state, rootState,
    commit (m, p) { mod.mutations[m](state, p) },
    dispatch (a, p) {
      dispatched.push([a, p])
      const fn = mod.actions[a.replace('tomatoAnnounce/', '')]
      return fn ? fn({ state, commit: store.commit, dispatch: store.dispatch, rootState }, p) : undefined
    },
    getters: g, calls, dispatched,
  }
  return store
}

const RUNNING = { deviceId: 'dev-a', deviceName: 'Desk', status: 'running', startedAt: Date.now() - 60000, plannedSec: 1500, at: Date.now() - 60000, attachTodoId: 't1', attachTodoTitle: 'Report' }

test('remote store: applyRemote keeps live announces and drops stale ones; prune evicts expired', () => {
  const store = makeStore()
  store.commit('applyRemote', { ...RUNNING })
  assert.equal(store.state.remote['dev-a'].deviceName, 'Desk')
  assert.equal(store.getters['primaryRunning']().deviceId, 'dev-a')
  // ran out: startedAt+plannedSec in the past -> dropped on land
  store.commit('applyRemote', { ...RUNNING, startedAt: Date.now() - 2000000 })
  assert.ok(!store.state.remote['dev-a'], 'expired announce must not land')
  // crash TTL: aged past 2x planned -> evicted by prune
  store.commit('applyRemote', { ...RUNNING, startedAt: Date.now() - 3200000, at: Date.now() - 3200000 })
  store.commit('prune')
  assert.ok(!store.state.remote['dev-a'], 'prune evicts TTL-expired entries')
})

test('remote store: init subscribes to syncEvents and loads the startup snapshot', async () => {
  const store = makeStore({ announceList: [{ ...RUNNING }, { deviceId: 'dev-b', deviceName: 'B', status: 'idle', startedAt: 0, plannedSec: 0, at: Date.now() }] })
  await store.dispatch('init')
  assert.equal(store.state.remote['dev-a'].deviceId, 'dev-a')
  assert.ok(!store.state.remote['dev-b'], 'idle snapshot entries are filtered')
  // a later syncEvent lands and replaces the entry
  const handler = store.calls.find(c => c[0] === 'onSyncEvent')[1]
  handler({ type: 'tomato-announce', ...RUNNING, status: 'idle', startedAt: 0, plannedSec: 0, attachTodoId: undefined })
  store.commit('applyRemote', { deviceId: 'dev-a', deviceName: 'Desk', status: 'idle', startedAt: 0, plannedSec: 0, at: Date.now() })
  assert.equal(store.getters['primaryRunning'](), null, 'idle announce clears the chip')
})

test('remote store: announceLocal composes running/idle payloads from the live tomato state', () => {
  const running = makeStore({ tomatoState: { status: 'startTomatoTime', startedAt: 123456, tomatoTime: 25, attachTodo: { taskId: 't1', taskContent: 'Report' } } })
  running.dispatch('announceLocal', { status: 'running' })
  const payload = running.calls.find(c => c[0] === 'announce')[1]
  assert.equal(payload.status, 'running')
  assert.equal(payload.startedAt, 123456)
  assert.equal(payload.plannedSec, 1500)
  assert.equal(payload.attachTodoId, 't1')
  const idle = makeStore({ tomatoState: { status: 'default', startedAt: 0 } })
  idle.dispatch('announceLocal', { status: 'idle' })
  const p2 = idle.calls.find(c => c[0] === 'announce')[1]
  assert.equal(p2.status, 'idle')
  assert.equal(p2.attachTodoId, undefined)
})

test('contract mirror: renderer helpers match the main-process announce module exactly', () => {
  const now = 5_000_000
  const fixtures = [
    { deviceId: 'a', deviceName: 'A', status: 'running', startedAt: now - 600000, plannedSec: 1500, at: now - 600000, attachTodoId: 't1', attachTodoTitle: 'R' },
    { deviceId: 'a', deviceName: 'A', status: 'running', startedAt: now - 1600000, plannedSec: 1500, at: now - 1600000 },
    { deviceId: 'a', deviceName: 'A', status: 'running', startedAt: now - 3100000, plannedSec: 1500, at: now - 3100000 },
    { deviceId: 'a', deviceName: 'A', status: 'idle', startedAt: 0, plannedSec: 0, at: now },
    { deviceId: 'a', deviceName: 'A', status: 'weird', startedAt: 1, plannedSec: 10, at: now },
    null,
  ]
  for (const f of fixtures) {
    const rb = buildAnnounceValue(f || {})
    const mb = taMain.buildAnnounceValue(f || {})
    assert.deepEqual(rb, mb, 'buildAnnounceValue must match (status field compares equal)')
    const built = taMain.buildAnnounceValue(f || {})
    assert.equal(isStaleAnnounce(built, now), taMain.isStaleAnnounce(built, now), 'isStaleAnnounce must match')
    assert.equal(remainSecOfAnnounce(built, now), taMain.remainSecOfAnnounce(built, now), 'remainSecOfAnnounce must match')
  }
})
