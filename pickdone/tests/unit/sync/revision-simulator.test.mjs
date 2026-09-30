import test from 'node:test'
import assert from 'node:assert/strict'
import { Hlc } from '../../../shared/sync-core/clock/hlc.mjs'
import { createEnvelope, packEnvelope, unpackEnvelope, verifyEnvelope } from '../../../shared/sync-core/revision/envelope.mjs'
import { createRevisionStore, commitLocal, applyEnvelope, materialized, materializedAll } from '../../../shared/sync-core/causality/merge.mjs'

// ---------- deterministic RNG (mulberry32) so failures are reproducible ----------
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- scenario tests (spec §53 cases) ----------

test('sequential edits form a causal chain and never conflict', () => {
  const store = createRevisionStore('devA')
  const clock = new Hlc('devA', { now: () => 1000 })
  const r1 = commitLocal(store, { entity: 'todo', entityId: 't1', clock, payload: { title: 'one' } })
  const r2 = commitLocal(store, { entity: 'todo', entityId: 't1', clock, payload: { title: 'two' } })
  assert.deepEqual(r2.parents, [r1.revisionId])

  const peer = createRevisionStore('devB')
  assert.equal(applyEnvelope(peer, r1).action, 'descendant')
  // out-of-order delivery: r2 first would be impossible here, but a REPLAY of r1
  // after r2 must classify as ancestor, not mint a conflict
  assert.equal(applyEnvelope(peer, r2).action, 'descendant')
  assert.equal(applyEnvelope(peer, r1).status, 'duplicate')
  assert.equal(materialized(peer, 't1').current.payload.title, 'two')
  assert.equal(materialized(peer, 't1').conflicts.length, 0)
})

test('stale echo (same content replayed from another path) classifies as duplicate/ancestor, no copy', () => {
  // This is the v1 syncAuthor-heuristic scenario, now resolved causally.
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const clockB = new Hlc('devB', { now: () => 1000 })
  const ra = commitLocal(a, { entity: 'todo', entityId: 't1', clock: clockA, payload: { title: 'x' } })
  applyEnvelope(b, ra) // B learns A's edit
  // B edits on top (sequential), then a slow network delivers a DUPLICATE of ra again
  const rb = commitLocal(b, { entity: 'todo', entityId: 't1', clock: clockB, payload: { title: 'y' } })
  const again = applyEnvelope(b, unpackEnvelope(packEnvelope(ra)))
  assert.equal(again.status, 'duplicate')
  assert.equal(materialized(b, 't1').conflicts.length, 0)
  assert.equal(materialized(b, 't1').current.payload.title, 'y')
  assert.equal(rb.parents[0], ra.revisionId)
})

test('concurrent same-row edits: deterministic winner + loser materialized as conflict copy', () => {
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  const ra = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'from-A' } })
  const rb = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 0, nodeId: 'devB' }, payload: { title: 'from-B' } })
  // both apply in opposite orders — outcome must be identical (determinism)
  applyEnvelope(a, ra); const resA = applyEnvelope(a, rb)
  applyEnvelope(b, rb); const resB = applyEnvelope(b, ra)
  assert.equal(materialized(a, 't1').current.payload.title, 'from-B')
  assert.equal(materialized(b, 't1').current.payload.title, 'from-B')
  assert.equal(materialized(a, 't1').conflicts[0].payload.title, 'from-A')
  assert.equal(materialized(b, 't1').conflicts[0].payload.title, 'from-A')
  assert.equal(resA.loser.payload.title, 'from-A')
  assert.equal(resB.loser.payload.title, 'from-A')
})

test('delete vs update: tombstone wins by HLC; losing live edit preserved', () => {
  const a = createRevisionStore('devA')
  const live = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 200, logical: 0, nodeId: 'devA' }, payload: { title: 'edited' } })
  const tomb = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 300, logical: 0, nodeId: 'devB' }, payload: { deleted: true } })
  applyEnvelope(a, live)
  applyEnvelope(a, tomb)
  assert.equal(materialized(a, 't1').current.payload.deleted, true)
  assert.equal(materialized(a, 't1').conflicts.length, 1, 'losing live edit must be preserved')
  assert.equal(materialized(a, 't1').conflicts[0]?.payload.title, 'edited')
})

test('identical concurrent content (stamp-only difference) mints NO conflict copy', () => {
  const a = createRevisionStore('devA')
  const ra = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'same' } })
  const rb = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 1, nodeId: 'devB' }, payload: { title: 'same', updatedAt: 999 } })
  applyEnvelope(a, ra)
  const res = applyEnvelope(a, rb)
  assert.equal(res.action, 'concurrent')
  assert.equal(res.loser, null)
  assert.equal(materialized(a, 't1').conflicts.length, 0)
})

test('tampered envelope fails integrity verification', () => {
  const e = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 1, logical: 0, nodeId: 'a' }, payload: { title: 'x' } })
  assert.ok(verifyEnvelope(e))
  e.payload.title = 'tampered'
  assert.ok(!verifyEnvelope(e))
  assert.throws(() => unpackEnvelope(packEnvelope(e)))
})

test('merge revision supersedes unresolved concurrent heads (multi-parent)', () => {
  const a = createRevisionStore('devA')
  const ra = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'a' } })
  const rb = createEnvelope({ entity: 'todo', entityId: 't1', hlc: { physical: 100, logical: 0, nodeId: 'devB' }, payload: { title: 'b' } })
  applyEnvelope(a, ra)
  applyEnvelope(a, rb) // concurrent: one is current, the other sits in heads
  const clock = new Hlc('devA', { now: () => 500 })
  const rm = commitLocal(a, { entity: 'todo', entityId: 't1', clock, payload: { title: 'merged' } })
  assert.equal(rm.parents.length, 2, 'merge revision records BOTH concurrent parents')
  assert.ok(rm.parents.includes(ra.revisionId) && rm.parents.includes(rb.revisionId))
})

// ---------- randomized network simulator (spec §48/§50/§53: drop/dup/reorder/partition/skew) ----------

function runSimulation(seed, { devices = 4, ops = 200 } = {}) {
  const rand = rng(seed)
  const pick = arr => arr[Math.floor(rand() * arr.length)]
  const wallStart = 1000

  const sims = []
  for (let i = 0; i < devices; i++) {
    const nodeId = `dev${i}`
    sims.push({
      nodeId,
      // every device gets its own wall clock with skew AND a rollback event budget
      skew: Math.floor(rand() * 50) - 25,
      store: createRevisionStore(nodeId),
      clock: null,
      rollbacksLeft: 2,
      knownByPeer: new Map(), // peer -> Set<revisionId> advertised as known
    })
  }
  for (const s of sims) {
    let now = wallStart + s.skew
    s.clock = new Hlc(s.nodeId, {
      now: () => {
        if (s.rollbacksLeft > 0 && rand() < 0.01) { s.rollbacksLeft--; now = Math.max(0, now - 500) }
        now += rand() < 0.2 ? 0 : 1 // frozen-clock moments
        return now
      },
    })
  }

  const entityIds = Array.from({ length: 12 }, (_, i) => `t${i}`)
  // network: queue of {at, from, to, bytes}; partition matrix; drop/dup/reorder
  const queue = []
  const partitioned = new Set() // "i-j" pairs currently partitioned
  let simTime = 0
  const latencies = []
  const send = (from, to, envelope) => {
    if (partitioned.has(pairKey(from.nodeId, to.nodeId))) return false // dropped at sender
    const latency = 5 + Math.floor(rand() * 40)
    latencies.push(latency)
    let at = simTime + latency
    if (rand() < 0.15) at += Math.floor(rand() * 80) // reorder: burst delay
    queue.push({ at, from, to, envelope })
    if (rand() < 0.08) queue.push({ at, from, to, envelope }) // duplicate delivery
    return true
  }

  for (let op = 0; op < ops; op++) {
    simTime += 10
    // drain due network deliveries
    queue.sort((x, y) => x.at - y.at)
    while (queue.length && queue[0].at <= simTime) {
      const msg = queue.shift()
      applyEnvelope(msg.to.store, msg.envelope)
    }
    // toggle a partition occasionally
    if (rand() < 0.06) {
      const i = Math.floor(rand() * devices)
      const j = Math.floor(rand() * devices)
      if (i !== j) {
        const key = pairKey(sims[i].nodeId, sims[j].nodeId)
        if (partitioned.has(key)) partitioned.delete(key); else partitioned.add(key)
      }
    }
    const actor = pick(sims)
    if (rand() < 0.55) {
      // local edit
      const entityId = pick(entityIds)
      const deleted = rand() < 0.15
      commitLocal(actor.store, {
        entity: 'todo', entityId, clock: actor.clock,
        payload: deleted ? { deleted: true } : { title: `${actor.nodeId}-${op}` },
      })
    } else {
      // sync round with one reachable peer: gossip full missing-set both ways
      const peer = pick(sims)
      if (peer === actor) continue
      gossip(actor, peer, send)
      gossip(peer, actor, send)
    }
  }
  // quiesce: heal all partitions (real networks recover eventually — an endless
  // partition makes convergence impossible by definition), then gossip+drain
  // until no device has anything left to send
  partitioned.clear()
  for (;;) {
    for (let i = 0; i < devices; i++) {
      for (let j = 0; j < devices; j++) {
        if (i !== j) gossip(sims[i], sims[j], send)
      }
    }
    queue.sort((x, y) => x.at - y.at)
    if (!queue.length) break
    while (queue.length) {
      const msg = queue.shift()
      simTime = msg.at
      applyEnvelope(msg.to.store, msg.envelope)
    }
  }
  return { sims, entityIds }
}

const pairKey = (a, b) => [a, b].sort().join('~')

function gossip(from, to, send) {
  let known = from.knownByPeer.get(to.nodeId)
  if (!known) { known = new Set(); from.knownByPeer.set(to.nodeId, known) }
  for (const env of from.store.revisions.values()) {
    if (!known.has(env.revisionId)) {
      // only mark as delivered when the wire accepted it: a partition-dropped
      // envelope must be retried on a later round or the peer never learns it
      if (send(from, to, env)) known.add(env.revisionId)
    }
  }
}

test('convergence: randomized adversarial network, 4 devices, clock skew + rollbacks + partitions', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { sims } = runSimulation(seed, { devices: 4, ops: 200 })
    const reference = materializedAll(sims[0].store)
    for (const s of sims) {
      assert.deepEqual(materializedAll(s.store), reference, `seed ${seed}: ${s.nodeId} diverged`)
    }
  }
})

test('convergence: 8 devices under the same adversarial conditions', () => {
  for (const seed of [7, 11, 42]) {
    const { sims } = runSimulation(seed, { devices: 8, ops: 260 })
    const reference = materializedAll(sims[0].store)
    for (const s of sims) {
      assert.deepEqual(materializedAll(s.store), reference, `seed ${seed}: ${s.nodeId} diverged`)
    }
  }
})

test('preservation: no concurrent loser is silently dropped anywhere in the simulation', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { sims } = runSimulation(seed, { devices: 4, ops: 200 })
    // every envelope any device ever authored must be reconstructable from the fleet:
    // current on some device, or a conflict copy on some device, unless it was
    // superseded by a descendant (then its descendants cover it — check lineage).
    const fleet = sims.flatMap(s => [
      ...[...s.store.revisions.values()],
      ...[...new Set(sims.flatMap(x => [...x.store.conflictsByEntity.values()].flatMap(m => [...m.values()])))],
    ])
    const byId = new Map(fleet.map(e => [e.revisionId, e]))
    for (const s of sims) {
      for (const env of s.store.revisions.values()) {
        assert.ok(byId.has(env.revisionId), `seed ${seed}: ${s.nodeId} holds unknown revision`)
      }
    }
    // materialized current on every device must exist for every known entity
    for (const s of sims) {
      for (const entityId of s.store.currentByEntity.keys()) {
        const { current } = materialized(s.store, entityId)
        assert.ok(current, `seed ${seed}: ${s.nodeId} entity ${entityId} has no materialized current`)
      }
    }
  }
})

test('invariant: every revision is strictly newer than each of its parents (fleet-wide)', () => {
  const { sims } = runSimulation(3, { devices: 4, ops: 200 })
  const cmp = (a, b) => a.physical - b.physical || a.logical - b.logical || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  for (const s of sims) {
    for (const env of s.store.revisions.values()) {
      for (const pid of env.parents) {
        const parent = s.store.revisions.get(pid)
        if (!parent) continue
        assert.ok(cmp(env.hlc, parent.hlc) > 0, `${s.nodeId}: ${env.revisionId} not newer than parent ${pid}`)
      }
    }
  }
})
