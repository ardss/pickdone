/**
 * Perpetual conflict-loop regression tests (2026-09-18 live incident: ~9 rows
 * conflict on EVERY round between two peers, each round materializing a fresh
 * `-conflict-` recycle-bin copy until the recycle bins ballooned).
 *
 * Root cause being pinned here: the todo payload carries `data.userId`, and each
 * device re-stamps userId to its OWN local account on write. The content compares
 * (merge.mjs contentDiffers + sync-apply rowContentDiffers) only skipped userId at
 * the ROW level, not inside the `data` payload — so the two machines' copies of the
 * same row permanently "differ" in content. With the seq tie-break favoring the
 * inbound row (localRow carries no seq), every round produces a losing side and a
 * fresh conflict copy, whose re-captured winner bounces back the next round.
 *
 * Invariant under test: a conflict between two rows resolves PERMANENTLY in exactly
 * one round — after the winner is applied on both sides, the next round's comparison
 * is an identical-content no-op (zero new conflict copies).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')
const { createEngine } = require('../../../shared/sync-core/engine.mjs')
const syncApply = require('../../../src/main/sync-apply.js')
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const BASE_ID = 'tid_06Dzrjx_1789668518498'
const T = 1789668518000

/* ---------- level 1: apply-layer loop (no TCP) ---------- */

function mockState (tables = {}) {
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const db = {
    call (op, params) {
      if (tables[op]) return tables[op](params)
      return null
    },
  }
  const state = {
    db, pendingWrites, applyCache: null, engine: null, node: null, timers: [],
    peerWatermarks: new Map(), pendingToSeq: 0, getWindowSenders: () => [], deviceId: 'dev-b',
  }
  return { state, pendingWrites }
}

test('conflict loop: peer row differing ONLY in data.userId is an identical-content no-op on re-apply', () => {
  // Machine B holds the row with ITS own userId (222). Machine A's copy (userId 111)
  // arrives with the same updateTime (the winner both sides already converged on).
  const localTodo = { taskId: BASE_ID, userId: 222, taskContent: 'same', updateTime: T, delete: false, deletedAt: 0 }
  const { state, pendingWrites } = mockState({ getAll: () => [localTodo] })
  __test.setState(state)
  const inbound = { entity: 'todo', id: BASE_ID, seq: 5, ts: T, updatedAt: T, deleted: false, deletedAt: 0, data: { taskId: BASE_ID, userId: 111, taskContent: 'same', updateTime: T, delete: false, deletedAt: 0 } }

  // A userId-only difference is not content: the very first apply is already an
  // identical-content no-op (the winner would be normalized to the local account anyway).
  const first = __test.applyRow(inbound)
  assert.equal(first, false, 'userId-only difference must be an identical-content no-op')
  const second = __test.applyRow(inbound)
  assert.equal(second, false, 'and it stays a no-op on every re-push')
  assert.equal(pendingWrites.todos.length, 0,
    'no conflict copy may be materialized for a userId-only difference')
})

/* ---------- level 2: full two-node TCP loop ---------- */

function fakeDiscovery () {
  return { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] }
}

/** In-memory stand-in for one machine's DB: todo table + captured oplog pointers. */
function makeStore (deviceId, userId, todos) {
  const map = new Map(todos.map(t => [String(t.taskId), { ...t }]))
  let seq = 0
  const oplog = []
  // Seed rows are oplog-captured like seedSyncOplog does (bare pointers): without this the
  // first round would ship nothing and the loop scenario would pass vacuously.
  for (const t of todos) { seq += 1; oplog.push({ seq, entity: 'todo', entityId: String(t.taskId), ts: t.updateTime }) }
  const call = (op, p) => {
    if (op === 'getAll') return [...map.values()]
    if (op === 'upsertMany') {
      for (const row of p || []) {
        const id = String(row.taskId)
        map.set(id, { ...map.get(id), ...row })
        seq += 1
        oplog.push({ seq, entity: 'todo', entityId: id, ts: row.updateTime || Date.now() })
      }
      return (p || []).length
    }
    if (op === 'settingsRowsAll' || op === 'tomatoAll' || op === 'getAllCategories' || op === 'planAll' || op === 'filterList') return []
    return null
  }
  const state = {
    db: { call }, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applyCache: null, engine: null, node: null, timers: [], peerWatermarks: new Map(),
    pendingToSeq: 0, getWindowSenders: () => [], deviceId, localUserId: userId,
  }
  const engine = createEngine({
    deviceId,
    localStore: {
      getRowsSince (since) {
        const cache = syncApply.createHydrationCache(state)
        return oplog.filter(x => x.seq > since).map(ptr => syncApply.hydrateRow(state, ptr, cache)).filter(Boolean)
      },
      getCursor: () => 0,
      setCursor () {},
      applyRow: row => __test.applyRow(row),
      allRows: () => [...map.values()].map(t => ({ entity: 'todo', id: String(t.taskId), updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t })),
      replaceAll () {},
    },
  })
  const countConflictCopies = () => [...map.keys()].filter(k => k.includes('-conflict-')).length
  return { map, state, engine, countConflictCopies }
}

test('conflict loop: two real TCP nodes converge in one round — zero new copies after round 1', async () => {
  const seed = taskContent => ({ taskId: BASE_ID, userId: 0, taskContent, updateTime: T, delete: false, deletedAt: 0 })
  const A = makeStore('node-a', 111, [{ ...seed('same'), userId: 111 }])
  const B = makeStore('node-b', 222, [{ ...seed('same'), userId: 222 }])

  const mkNode = (label, store, port) => createLanSyncNode({
    deviceId: label, name: label, pairingSecret: 'glue-secret-1', port, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: seg => {
      __test.setState(store.state)
      const r = store.engine.ingestSegment(seg)
      __test.flushPendingWrites()
      return r
    },
    ingestSnapshot: () => ({}),
    ingestSnapshotChunk: () => ({}),
    buildSegments: since => {
      __test.setState(store.state)
      return store.engine.buildSegments(Number(since) || 0).segments
    },
  })

  const nodeA = mkNode('node-a', A, 0)
  const nodeB = mkNode('node-b', B, 0)
  nodeA.start()
  nodeB.start()
  const [portA, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB })
  nodeB.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: portA })

  try {
    await nodeA.startSyncRound() // round 1: A -> B
    await nodeB.startSyncRound() // round 2: B -> A (the re-captured winner bounces back)
    await nodeA.startSyncRound() // round 3: whatever round 2 captured goes back

    const copiesA = A.countConflictCopies()
    const copiesB = B.countConflictCopies()
    assert.equal(copiesA + copiesB, 0,
      `a content-identical (modulo userId) row must NEVER conflict-copy; got A=${copiesA} B=${copiesB}`)
  } finally {
    await nodeA.stop()
    await nodeB.stop()
  }
})

test('conflict loop: conflict copies are terminal — an inbound copy id never spawns another copy', () => {
  // The peer's copy arrives under its own (suffixed) id. Locally a row with that id exists
  // and is OLDER with different content: the inbound copy wins, and its losing local version
  // must be DROPPED, never conflict-copied again (copies are terminal).
  const copyId = `${BASE_ID}-conflict-abc`
  const localCopy = { taskId: copyId, userId: 222, taskContent: 'older copy content', updateTime: T, delete: false, deletedAt: 0 }
  const { state, pendingWrites } = mockState({ getAll: () => [localCopy] })
  __test.setState(state)
  const inboundCopy = { entity: 'todo', id: copyId, seq: 9, ts: T + 9000, updatedAt: T + 9000, deleted: false, deletedAt: 0, data: { taskId: copyId, userId: 111, taskContent: 'newer copy content', updateTime: T + 9000, delete: false, deletedAt: 0 } }
  const ok = __test.applyRow(inboundCopy)
  assert.equal(ok, true, 'the newer inbound copy legitimately lands')
  assert.equal(pendingWrites.todos.length, 1, 'only the winner is written')
  const landing = pendingWrites.todos[0]
  assert.equal(landing.taskId, copyId, 'the winner keeps its own id — no copy of the copy is minted')
  // And an older inbound copy simply loses LWW and is dropped.
  const { state: s2, pendingWrites: pw2 } = mockState({ getAll: () => [{ ...localCopy, updateTime: T + 9000, taskContent: 'newer copy content' }] })
  __test.setState(s2)
  const ok2 = __test.applyRow({ ...inboundCopy, seq: 3, ts: T, updatedAt: T, data: { ...inboundCopy.data, updateTime: T } })
  assert.equal(ok2, false, 'older inbound copy loses LWW and is dropped')
  assert.equal(pw2.todos.length, 0, 'losing a copy must not materialize a copy of the copy')
})

test('conflict loop: copy materialization is idempotent — no second copy for the same base id + content', () => {
  const localTodo = { taskId: BASE_ID, userId: 222, taskContent: 'local edit', updateTime: T, delete: false, deletedAt: 0 }
  const existingCopy = { taskId: `${BASE_ID}-conflict-old`, userId: 222, taskContent: 'local edit', updateTime: 1, delete: 1, deletedAt: 2 }
  const { state, pendingWrites } = mockState({ getAll: () => [localTodo] })
  __test.setState(state)
  // Newer inbound edit with different content legitimately conflicts once...
  const inbound = { entity: 'todo', id: BASE_ID, seq: 5, ts: T + 9000, updatedAt: T + 9000, deleted: false, deletedAt: 0, data: { taskId: BASE_ID, userId: 111, taskContent: 'remote edit', updateTime: T + 9000, delete: false, deletedAt: 0 } }
  const ok = __test.applyRow(inbound)
  assert.equal(ok, true)
  const copies = pendingWrites.todos.filter(r => String(r.taskId).includes('-conflict-'))
  assert.equal(copies.length, 1, 'exactly one copy for this losing content')  // ...but re-deriving the SAME losing content (e.g. the loser bounces back and loses
  // again) must not mint an equivalent second copy.
  const { state: s2, pendingWrites: pw2 } = mockState({ getAll: () => [localTodo, existingCopy] })
  __test.setState(s2)
  __test.applyRow(inbound)
  const copies2 = pw2.todos.filter(r => String(r.taskId).includes('-conflict-'))
  assert.equal(copies2.length, 0, 'an equivalent copy of the same base row already in the bin must suppress re-materialization')
})
