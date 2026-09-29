import test from 'node:test'
import assert from 'node:assert/strict'
import { Hlc } from '../../../shared/sync-core/clock/hlc.mjs'
import { createRevisionStore, commitLocal, applyEnvelope } from '../../../shared/sync-core/causality/merge.mjs'

// Regressions from the 2026-09-30 four-way adversarial review — each test pins a
// finding that had an executed repro.

test('review P1: restart-without-restore + rolled-back clock cannot mint colliding revisionIds', () => {
  const a = createRevisionStore('devA')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const r1 = commitLocal(a, { entity: 'todo', entityId: 't1', clock: clockA, payload: { title: 'before crash' } })
  // crash: brand-new clock, same rolled-back wall time, NO restore() — the old id
  // scheme keyed only on (hlc, nodeId) and collided across entities
  const clock2 = new Hlc('devA', { now: () => 1000 })
  const r2 = commitLocal(createRevisionStore('devA'), { entity: 'todo', entityId: 't2', clock: clock2, payload: { title: 'after crash' } })
  assert.notEqual(r1.revisionId, r2.revisionId, 'distinct content must never share a revisionId')
  // the genuine t2 revision arriving from a peer is not shadowed as duplicate
  const peer = createRevisionStore('devB')
  assert.equal(applyEnvelope(peer, r2).status, 'applied')
})

test('review P2: nested id fields participate in content identity (hash-collision)', () => {
  const a = createRevisionStore('devA')
  const ra = { revisionId: 'rx1', entityId: 't1', authorDeviceId: 'a', hlc: { physical: 100, logical: 0, nodeId: 'a' }, parents: [], payloadHash: 'p1', payload: { title: 'same', subtasks: [{ id: 1, name: 'a' }] } }
  const rb = { revisionId: 'rx2', entityId: 't1', authorDeviceId: 'b', hlc: { physical: 100, logical: 1, nodeId: 'b' }, parents: [], payloadHash: 'p2', payload: { title: 'same', subtasks: [{ id: 2, name: 'a' }] } }
  applyEnvelope(a, ra)
  const res = applyEnvelope(a, rb)
  assert.equal(res.action, 'concurrent')
  assert.ok(res.loser, 'distinct nested content must produce a preserved loser (was: hash collision, no copy)')
})

test('review P2: heads pruned when superseded by descendants; conflict copies cleaned once resolved', () => {
  const a = createRevisionStore('devA')
  const ra = { revisionId: 'ra', entityId: 't1', authorDeviceId: 'a', hlc: { physical: 100, logical: 0, nodeId: 'a' }, parents: [], payloadHash: 'pa', payload: { title: 'a' } }
  const rb = { revisionId: 'rb', entityId: 't1', authorDeviceId: 'b', hlc: { physical: 100, logical: 0, nodeId: 'b' }, parents: [], payloadHash: 'pb', payload: { title: 'b' } }
  applyEnvelope(a, ra)
  applyEnvelope(a, rb) // concurrent: one current, one head + conflict copy
  const headsBefore = a.headsByEntity.get('t1').size
  assert.equal(a.conflictsByEntity.get('t1').size, 1)
  // a merge revision superseding BOTH causally must clear heads AND the stale conflict
  const rm = commitLocal(a, { entity: 'todo', entityId: 't1', clock: new Hlc('a', { now: () => 9000 }), payload: { title: 'merged' } })
  assert.equal(rm.parents.length, 2)
  assert.equal(a.headsByEntity.get('t1').size, 0, 'heads cleaned after supersession')
  assert.equal(a.conflictsByEntity.get('t1').size, 0, 'resolved conflict copy removed')
  assert.ok(headsBefore >= 1)
})

test('review P1: duplicate status advances the cursor — idle rounds make progress', async t => {
  const { createRelay, startRelayServer } = await import('../../../server/sync-relay.mjs')
  const { memoryStore } = await import('../../../server/sync-relay.mjs')
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const { createRelayClient } = await import('../../../shared/sync-transport/https/relay-client.mjs')
  const a = createRelayClient({ nodeId: 'devA', account: 'acc-x', baseUrl })
  await a.register()
  await a.commit('t1', { title: 'x' })
  await a.round()
  const r2 = await a.round() // idle: own frame returns as duplicate
  assert.ok(r2.cursor > 0, 'cursor advanced past duplicate own frame (was: pinned at 0, GC dead)')
})

test('review P1: one poisoned frame quarantined, cursor advances, later frames still apply', async t => {
  const { createRelay, startRelayServer, memoryStore } = await import('../../../server/sync-relay.mjs')
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const { createRelayClient } = await import('../../../shared/sync-transport/https/relay-client.mjs')
  const a = createRelayClient({ nodeId: 'devA', account: 'acc-q', baseUrl })
  await a.register()
  await a.commit('t1', { title: 'good-one' })
  await a.round()
  relay.push('acc-q', 'injector', [{ opId: 'poison', envelope: '{not json' }])
  await a.commit('t2', { title: 'good-two' })
  const r = await a.round()
  assert.equal(r.quarantined, 1)
  assert.ok(r.cursor > 0)
  assert.ok(a.materialized()['t2'], 'frames behind the poison still applied')
})

test('review P1: transient push failure does not orphan pending revisions', async t => {
  const { createRelay, startRelayServer, memoryStore } = await import('../../../server/sync-relay.mjs')
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const { createRelayClient } = await import('../../../shared/sync-transport/https/relay-client.mjs')
  let failPush = false
  const realFetch = globalThis.fetch
  globalThis.fetch = (url, opts) => {
    if (failPush && String(url).includes('/sync/push')) return Promise.reject(new Error('blip'))
    return realFetch(url, opts)
  }
  t.after(() => { globalThis.fetch = realFetch })
  const a = createRelayClient({ nodeId: 'devA', account: 'acc-b', baseUrl })
  await a.register()
  await a.commit('t1', { title: 'survives' })
  failPush = true
  await assert.rejects(() => a.round())
  failPush = false
  const r = await a.round()
  assert.equal(r.pushed, 1, 'revision retried after the blip (was: orphaned forever)')
  const b = createRelayClient({ nodeId: 'devB', account: 'acc-b', baseUrl })
  await b.register(); await b.round()
  assert.deepEqual(b.materialized(), a.materialized())
})
