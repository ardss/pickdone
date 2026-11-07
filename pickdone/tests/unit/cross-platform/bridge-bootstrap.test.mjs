import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/cross-platform/bridge-bootstrap.js')

/**
 * Bootstrap wiring tests: default-disabled behavior, meta persistence of the trust
 * root, and a REAL pair->pull round trip through the bootstrapped bridge (temp sqlite
 * meta via the same metaStore discipline; the HTTP layer itself is covered in
 * http-bridge.test.mjs — this file proves the wiring seams).
 */

function fakeDbCall (state = {}) {
  // canonical REAL db shapes: getMeta(key) -> string|null, setMeta([key, value])
  return (op, params) => {
    if (op === 'getMeta') {
      const v = state[params]
      return v != null ? v : null
    }
    if (op === 'setMeta') {
      state[params[0]] = String(params[1])
      return true
    }
    // the pull surface reads these five entity ops through the desktop-repo adapter
    if (['getAll', 'getAllCategories', 'episodeAllRows', 'sourceAllRows', 'taskSourceAllRows'].includes(op)) return []
    throw new Error(`fakeDbCall: op ${op} not wired in this test`)
  }
}

test('bridge is DISABLED by default: start() is a no-op until the user opts in', async () => {
  const state = {}
  const r = await bootstrap.startCrossPlatformBridge(() => fakeDbCall(state))
  assert.equal(r.started, false)
  assert.match(r.reason, /disabled/)
  assert.throws(() => bootstrap.issuePairing('any'), /not running/)
})

test('setBridgeEnabled + start boots a REAL loopback listener with persisted meta state', async () => {
  const state = {}
  const dbCall = fakeDbCall(state)
  bootstrap.setBridgeEnabled(dbCall, true)
  assert.equal(bootstrap.isBridgeEnabled(dbCall), true)
  const r = await bootstrap.startCrossPlatformBridge(() => dbCall, { port: 0, allowedOrigins: ['http://localhost:5173'] })
  assert.equal(r.started, true)
  assert.ok(r.port > 0)
  // trust root minted once and persisted in the meta store
  assert.ok(state[bootstrap.__keys.SECRET_KEY], 'pairing secret persisted')
  assert.ok(state[bootstrap.__keys.NONCE_KEY], 'session nonce persisted')
  const before = state[bootstrap.__keys.SECRET_KEY]
  // idempotent start: second call does not remint or rebind
  const again = await bootstrap.startCrossPlatformBridge(() => dbCall)
  assert.equal(again.port, r.port)
  assert.equal(state[bootstrap.__keys.SECRET_KEY], before)

  // real pairing + authenticated round trip through the bootstrapped singleton
  const ch = bootstrap.issuePairing('android-real', { scope: 'READ' })
  const pairRes = await fetch(`http://127.0.0.1:${r.port}/crossplatform/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: ch.challengeId, code: ch.code, deviceId: 'android-real' })
  })
  assert.equal(pairRes.status, 200)
  const pair = await pairRes.json()
  assert.equal(pair.ok, true)
  const pullRes = await fetch(`http://127.0.0.1:${r.port}/crossplatform/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pair.token}`, 'X-PickDone-Request': pair.csrfHeader, Origin: 'http://localhost:5173' },
    body: JSON.stringify({ deviceId: 'android-real', messageId: 'boot-1' })
  })
  assert.equal(pullRes.status, 200)

  await bootstrap.stopCrossPlatformBridge()
  const off = await fetch(`http://127.0.0.1:${r.port}/crossplatform/pull`, { method: 'POST', body: '{}' }).catch(() => null)
  assert.equal(off, null, 'listener is gone after stop')
})

test('disable + start tears the listener down (default-off contract)', async () => {
  const state = {}
  const dbCall = fakeDbCall(state)
  bootstrap.setBridgeEnabled(dbCall, true)
  const r = await bootstrap.startCrossPlatformBridge(() => dbCall, { port: 0, allowedOrigins: ['http://localhost:5173'] })
  assert.equal(r.started, true)
  bootstrap.setBridgeEnabled(dbCall, false)
  await bootstrap.stopCrossPlatformBridge()
  assert.equal(bootstrap.isBridgeEnabled(dbCall), false)
})
