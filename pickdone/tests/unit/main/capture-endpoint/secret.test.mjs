/**
 * [S4 capture-endpoint RED→GREEN] secret.js — the X-PickDone-Key handshake primitive.
 *
 * Behavior under test (user/attacker-visible):
 *   - generateKey() mints a 48-hex-char key; two calls never collide.
 *   - keysMatch(provided, expected) is TRUE only for the exact key; missing/empty/wrong/short
 *     provided values all fail; comparison is constant-time (timingSafeEqual on sha256
 *     digests — length never leaks through an early return).
 *   - the header name is exactly 'X-PickDone-Key'.
 *
 * Run: node --test tests/unit/main/capture-endpoint/secret.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { generateKey, keysMatch, KEY_HEADER } from '../../../../src/main/capture-endpoint/secret.js'

test('generateKey mints a 48-char lowercase-hex key', () => {
  const k = generateKey()
  assert.match(k, /^[0-9a-f]{48}$/)
})

test('generateKey never repeats (entropy sanity over 64 draws)', () => {
  const seen = new Set()
  for (let i = 0; i < 64; i++) seen.add(generateKey())
  assert.equal(seen.size, 64)
})

test('keysMatch: exact key matches', () => {
  const k = generateKey()
  assert.equal(keysMatch(k, k), true)
})

test('keysMatch: wrong key, missing header, empty string all reject', () => {
  const k = generateKey()
  assert.equal(keysMatch(generateKey(), k), false, 'a different valid-shape key must not match')
  assert.equal(keysMatch(undefined, k), false, 'missing header rejects')
  assert.equal(keysMatch(null, k), false)
  assert.equal(keysMatch('', k), false, 'empty header rejects')
  assert.equal(keysMatch(k, null), false, 'no configured secret fails closed')
  assert.equal(keysMatch(k, ''), false)
})

test('keysMatch is length-safe: short/long forgeries reject without throwing', () => {
  const k = generateKey()
  assert.equal(keysMatch('a', k), false)
  assert.equal(keysMatch(k + k, k), false)
  assert.doesNotThrow(() => keysMatch('x'.repeat(1000), k))
})

test('the handshake header is exactly X-PickDone-Key', () => {
  assert.equal(KEY_HEADER, 'X-PickDone-Key')
})
