/**
 * Regression tests for audit finding D2-c/D3: sync enable was FAIL-OPEN on bind failure.
 *
 * Before the fix, startSync() returned right after node.start(); an EADDRINUSE on the fixed
 * sync port left the node half-alive with the UI toggle reporting 局域网同步已开启, the device
 * card showing a blank port with a green dot, and sync rounds running as 'confirmed 0/0'
 * no-ops. The contract pinned here:
 *   1. A node whose TCP server cannot bind emits 'server-error' and reports
 *      getStatus().listening === false (the observable the device card must render honestly).
 *   2. syncSetEnabledOp must REJECT when the server never reaches 'listening', roll
 *      sync.enabled back to false, and tear the dead node down (state.node === null) — so the
 *      renderer's toggle error path fires instead of a success toast.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
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

test('D2-c: a node that cannot bind its fixed port emits server-error and reports listening:false', async () => {
  const port = await freePort()
  const squatter = net.createServer()
  await new Promise(r => squatter.listen(port, '127.0.0.1', r))
  try {
    const node = createLanSyncNode({
      deviceId: 'dev-failclosed', name: 'failclosed', pairingSecret: 'secret-failclosed',
      port, host: '127.0.0.1', discoverFn: { startAdvertising: () => {}, discover: () => {}, stop: () => {}, getPeers: () => [] },
    })
    node.start()
    const outcome = await Promise.race([
      node.whenListening().then(() => 'listening'),
      new Promise(resolve => node.once('server-error', () => resolve('server-error'))),
    ])
    assert.equal(outcome, 'server-error', 'bind failure must surface as server-error, not silence')
    const st = node.getStatus()
    assert.equal(st.listening, false, 'getStatus must report listening:false when the port is occupied')
    assert.equal(st.port, null, 'getStatus must not advertise a port the server never bound')
    await node.stop?.()
  } finally {
    await new Promise(r => squatter.close(r))
  }
})

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

function mockState (db) {
  return {
    db, getWindowSenders: () => [], node: null, engine: null, timers: [],
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    peerWatermarks: new Map(), pendingToSeq: 0, applied: null, pendingPair: null, localUserId: null,
  }
}

test('D2-c: syncSetEnabled(true) on an occupied port REJECTS, rolls sync.enabled back to false, and tears the node down', async () => {
  const port = await freePort()
  const squatter = net.createServer()
  await new Promise(r => squatter.listen(port, '127.0.0.1', r))
  try {
    const db = mockDb()
    const state = mockState(db)
    state.syncBindOverride = { port, host: '127.0.0.1' } // test-only hook in startSync: force the collision deterministically
    // (Windows refuses a double bind only when both sockets share the same specific host)
    bootstrap.__test.setState(state)
    const result = await bootstrap.__test.syncSetEnabled({ enabled: true }).then(
      () => 'resolved',
      e => `rejected: ${e && e.message}`
    )
    assert.match(result, /^rejected/, 'the toggle must reject on bind failure (fail closed)')
    assert.match(result, /bind|listening/, 'the rejection must name the bind/listen failure')
    const enabledRow = db.rows.find(r => r.key === 'sync.enabled')
    assert.equal(enabledRow && enabledRow.value, false, 'sync.enabled must be rolled back to false on failed start')
    assert.equal(state.node, null, 'the dead node must be torn down (state.node null)')
    assert.equal(state.timers.length, 0, 'round timers must be cleared with the node')
  } finally {
    await new Promise(r => squatter.close(r))
  }
})
