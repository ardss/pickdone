/**
 * S5 regression (2026-10-03): the fail-closed 'sync enabled ⇒ node listening' contract is owned
 * by ONE restart path (bootstrap restartSync) instead of a single caller (syncSetEnabledOp).
 *
 * Pre-fix root: four pairing/rename restart sites (syncUnpairPeerOp, syncPairWithCode,
 * syncPairRequest, syncSetName) used fire-and-forget startSync().catch(log.error). A bind
 * failure after the pairing mutations left K_ENABLED=true with state.node=null — the
 * enabled-without-listening dead-toggle state the D2-c contract exists to prevent — reachable
 * via ordinary pairing/rename/unpair UI flows, with the rejection swallowed into log.error.
 *
 * Invariant: after ANY restart path whose startSync rejects, K_ENABLED must be false and the
 * IPC op must reject (never enabled-with-node-null). All tests here force the bind failure
 * deterministically with a port squatter + the test-only syncBindOverride hook.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
    srv.on('error', reject)
  })
}

function mockDb () {
  const rows = [] // {key, value, deleted}
  return {
    rows,
    call (op, p) {
      if (op === 'settingsRowsAll') return rows.map(r => ({ ...r }))
      if (op === 'settingsRowPut') {
        const hit = rows.find(r => r.key === p.key)
        if (hit) { hit.value = p.value; hit.deleted = false } else rows.push({ key: p.key, value: p.value, deleted: false })
        return true
      }
      return null
    },
  }
}

function fakeNode () {
  return {
    getStatus: () => ({ peers: [{ deviceId: 'peer-1', host: '127.0.0.1', port: 58471, name: 'Peer 1' }] }),
    removePeer () {},
    notifyUnpaired () { return false },
    async pairWith () { return { secret: 'pair-secret-1', peer: { deviceId: 'peer-1', name: 'Peer 1', host: '127.0.0.1', port: 58471 } } },
  }
}

async function withSquattedPort (fn) {
  const port = await freePort()
  const squatter = net.createServer()
  await new Promise(r => squatter.listen(port, '127.0.0.1', r))
  try {
    return await fn(port)
  } finally {
    await new Promise(r => squatter.close(r))
  }
}

test('S5: restartSync({preserveEnabled:true}) rolls sync OFF and rejects when the bind fails', async () => {
  await withSquattedPort(async (port) => {
    const db = mockDb()
    db.call('settingsRowPut', { key: 'sync.enabled', value: true })
    const state = {
      db, getWindowSenders: () => [], node: null, engine: null, timers: [],
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
      syncBindOverride: { port, host: '127.0.0.1' }, // deterministic bind collision
    }
    bootstrap.__test.setState(state)
    try {
      await assert.rejects(
        () => bootstrap.__test.restartSync({ preserveEnabled: true }),
        /bind|listening/,
        'the restart must reject on a failed bind'
      )
      assert.equal(db.rows.find(r => r.key === 'sync.enabled').value, false, 'K_ENABLED rolled back to false (fail closed)')
      assert.equal(state.node, null, 'never enabled-with-node-null')
    } finally {
      bootstrap.__test.setState(null)
    }
  })
})

test('S5: unpair (secret rotated) fails closed when the post-unpair restart cannot bind', async () => {
  await withSquattedPort(async (port) => {
    const db = mockDb()
    db.call('settingsRowPut', { key: 'sync.enabled', value: true })
    db.call('settingsRowPut', { key: 'sync.pairingSecret', value: 'old-secret' })
    const state = {
      db, getWindowSenders: () => [], node: fakeNode(), engine: null, timers: [],
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
      syncBindOverride: { port, host: '127.0.0.1' },
    }
    bootstrap.__test.setState(state)
    try {
      await assert.rejects(
        () => bootstrap.__test.unpairPeer({ deviceId: 'peer-1' }),
        /bind|listening/,
        'the unpair op must surface the failed restart (not swallow it into log.error)'
      )
      assert.equal(db.rows.find(r => r.key === 'sync.enabled').value, false, 'sync must be OFF after the failed restart')
      assert.equal(state.node, null, 'the dead node is torn down')
      assert.notEqual(db.rows.find(r => r.key === 'sync.pairingSecret').value, 'old-secret', 'the secret was rotated before the restart attempt')
    } finally {
      bootstrap.__test.setState(null)
    }
  })
})

test('S5: syncPairWithCode rejects and rolls sync OFF when the post-pairing restart cannot bind', async () => {
  await withSquattedPort(async (port) => {
    const db = mockDb()
    db.call('settingsRowPut', { key: 'sync.enabled', value: true })
    const state = {
      db, getWindowSenders: () => [], node: fakeNode(), engine: null, timers: [],
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
      pairingCode: null,
      syncBindOverride: { port, host: '127.0.0.1' },
    }
    bootstrap.__test.setState(state)
    try {
      await assert.rejects(
        () => bootstrap.__test.pairOps.syncPairWithCode({ deviceId: 'peer-1', code: '123456' }),
        /bind|listening/,
        'the pairing op must reject so the renderer sees the pairing failure'
      )
      assert.equal(db.rows.find(r => r.key === 'sync.enabled').value, false, 'sync must be OFF after the failed restart')
      assert.equal(state.node, null, 'never enabled-with-node-null after a pairing restart failure')
    } finally {
      bootstrap.__test.setState(null)
    }
  })
})

test('S5: syncSetName rejects and rolls sync OFF when the rename restart cannot bind', async () => {
  await withSquattedPort(async (port) => {
    const db = mockDb()
    db.call('settingsRowPut', { key: 'sync.enabled', value: true })
    const state = {
      db, getWindowSenders: () => [], node: fakeNode(), engine: null, timers: [],
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
      syncBindOverride: { port, host: '127.0.0.1' },
    }
    bootstrap.__test.setState(state)
    try {
      await assert.rejects(
        () => bootstrap.__test.pairOps.syncSetName({ name: 'Renamed Device' }),
        /bind|listening/,
        'the rename op must reject on a failed restart'
      )
      assert.equal(db.rows.find(r => r.key === 'sync.enabled').value, false, 'sync must be OFF after the failed restart')
    } finally {
      bootstrap.__test.setState(null)
    }
  })
})

test('S5: restartSync({preserveEnabled:false}) is a no-op restart (sync disabled — nothing to restart)', async () => {
  const db = mockDb()
  db.call('settingsRowPut', { key: 'sync.enabled', value: false })
  const state = {
    db, getWindowSenders: () => [], node: null, engine: null, timers: [],
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
  }
  bootstrap.__test.setState(state)
  try {
    await bootstrap.__test.restartSync({ preserveEnabled: false })
    assert.equal(state.node, null, 'no node started while sync is disabled')
    assert.equal(db.rows.find(r => r.key === 'sync.enabled').value, false, 'K_ENABLED untouched')
  } finally {
    bootstrap.__test.setState(null)
  }
})
