/**
 * Pairing code tests: deterministic derivation, verify accept/reject paths,
 * constant-time compare helper. node:crypto is deterministic for HMAC, so
 * all assertions are fixed-value and repeatable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  generatePairingSecret,
  derivePairingCode,
  verifyPairingCode,
  constantTimeEqual,
} from '../../../shared/sync-core/pairing.mjs'

test('generatePairingSecret: 32 random bytes as 64 hex chars, unique', () => {
  const s1 = generatePairingSecret()
  const s2 = generatePairingSecret()
  assert.match(s1, /^[0-9a-f]{64}$/)
  assert.notEqual(s1, s2)
})

test('derivePairingCode: 6 digits, deterministic, device-scoped', () => {
  const secret = 'ab'.repeat(32)
  const c1 = derivePairingCode(secret, 'devA')
  const c2 = derivePairingCode(secret, 'devA')
  assert.match(c1, /^\d{6}$/)
  assert.equal(c1, c2)
  assert.notEqual(c1, derivePairingCode(secret, 'devB'), 'different device -> different code')
  assert.notEqual(c1, derivePairingCode('cd'.repeat(32), 'devA'), 'different secret -> different code')
})

test('derivePairingCode matches an independent HMAC reference implementation', () => {
  const secret = 'deadbeef'.repeat(8)
  const deviceId = 'device-42'
  const n = createHmac('sha256', secret).update(deviceId).digest().readUInt32BE(0) % 1000000
  assert.equal(derivePairingCode(secret, deviceId), String(n).padStart(6, '0'))
})

test('verifyPairingCode: right secret accepts, wrong secret/device/code rejects', () => {
  const secret = generatePairingSecret()
  const code = derivePairingCode(secret, 'devA')
  assert.equal(verifyPairingCode(secret, 'devA', code), true)
  assert.equal(verifyPairingCode(secret, 'devA', ` ${code} `), true, 'trailing whitespace tolerated')
  assert.equal(verifyPairingCode(secret, 'devA', String((Number(code) + 1) % 1000000).padStart(6, '0')), false)
  assert.equal(verifyPairingCode(generatePairingSecret(), 'devA', code), false, 'wrong secret')
  assert.equal(verifyPairingCode(secret, 'devB', code), false, 'wrong device')
  assert.equal(verifyPairingCode(secret, 'devA', ''), false)
  assert.equal(verifyPairingCode(secret, 'devA', 'abcdef'), false)
  assert.throws(() => derivePairingCode('', 'devA'), /required/)
  assert.throws(() => derivePairingCode(secret, ''), /required/)
})

test('constantTimeEqual: equal and unequal buffers', () => {
  assert.equal(constantTimeEqual('123456', '123456'), true)
  assert.equal(constantTimeEqual('123456', '123457'), false)
  assert.equal(constantTimeEqual('123', '123456'), false)
})
