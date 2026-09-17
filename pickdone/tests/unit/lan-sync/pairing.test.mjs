/**
 * Pairing code flow tests: derivation is deterministic, verification is
 * device-bound and secret-bound, and tampered codes fail. Pure logic, no
 * sockets.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { deriveAuthCode, verifyAuthCode, isValidPairingSecret, assertSyncCorePairingParity } = require('../../../src/main/lan-sync/pairing.js')

test('pairing: adapter derivation matches shared/sync-core/pairing.mjs', async () => {
  await assertSyncCorePairingParity()
})

test('pairing: derive -> verify round-trips for a paired device', () => {
  const code = deriveAuthCode('secret-123', 'device-a')
  assert.match(code, /^[0-9]{6}$/)
  assert.ok(verifyAuthCode('secret-123', 'device-a', code))
})

test('pairing: derivation is deterministic and device-bound', () => {
  assert.equal(deriveAuthCode('secret-123', 'device-a'), deriveAuthCode('secret-123', 'device-a'))
  assert.notEqual(deriveAuthCode('secret-123', 'device-a'), deriveAuthCode('secret-123', 'device-b'))
})

test('pairing: wrong secret or tampered code fails verification', () => {
  const code = deriveAuthCode('secret-123', 'device-a')
  assert.ok(!verifyAuthCode('secret-999', 'device-a', code))
  const chars = code.split('')
  chars[0] = chars[0] === '0' ? '1' : '0'
  assert.ok(!verifyAuthCode('secret-123', 'device-a', chars.join('')))
})

test('pairing: invalid inputs are rejected without throwing', () => {
  assert.ok(!verifyAuthCode('', 'device-a', 'x'))
  assert.ok(!verifyAuthCode('secret', '', 'x'))
  assert.ok(!verifyAuthCode('secret', 'device-a', ''))
  assert.ok(!verifyAuthCode('secret', 'device-a', null))
  assert.throws(() => deriveAuthCode('', 'device-a'))
  assert.throws(() => deriveAuthCode('secret', ''))
})

test('pairing: pairing secret shape validation', () => {
  assert.ok(isValidPairingSecret('ABC123'))
  assert.ok(isValidPairingSecret('pick-done-2026'))
  assert.ok(!isValidPairingSecret('abc'))
  assert.ok(!isValidPairingSecret('bad space'))
  assert.ok(!isValidPairingSecret(42))
})
