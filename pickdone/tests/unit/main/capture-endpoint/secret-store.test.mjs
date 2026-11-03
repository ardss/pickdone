/**
 * [S4 capture-endpoint RED→GREEN] secret at rest — the '_captureEndpointSecret' meta row is
 * encrypted with Electron safeStorage (OS keyring) before it touches meta, and decrypted on
 * read. Without a usable keyring (early boot / Linux without one) the value falls back to
 * plaintext and the settings tab can detect that ('enc1:' prefix absent).
 *
 * Pure helpers, no electron import — safeStorage is injected (stubbed in both shapes).
 *
 * Run: node --test tests/unit/main/capture-endpoint/secret-store.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  encryptSecretValue,
  decryptSecretValue,
  migrateSecret,
  SECRET_ENC_PREFIX
} from '../../../../src/main/capture-endpoint/index.js'

const KEY = 'a'.repeat(48)

/** Stub shape 1: a working OS keyring. */
function workingSafeStorage () {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from('enc::' + plain, 'utf8'),
    decryptString: (buf) => Buffer.from(buf).toString('utf8').slice('enc::'.length)
  }
}

/** Stub shape 2: safeStorage present but the OS keyring is unavailable. */
function brokenSafeStorage () {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('no keyring') },
    decryptString: () => { throw new Error('no keyring') }
  }
}

test('encrypt/decrypt round-trip with a working safeStorage', () => {
  const ss = workingSafeStorage()
  const stored = encryptSecretValue(KEY, ss)
  assert.notEqual(stored, KEY) // never plaintext at rest
  assert.ok(stored.startsWith(SECRET_ENC_PREFIX))
  assert.equal(decryptSecretValue(stored, ss), KEY)
})

test('fallback: no safeStorage → stored plaintext, read returns it unchanged', () => {
  assert.equal(encryptSecretValue(KEY, null), KEY)
  assert.equal(decryptSecretValue(KEY, null), KEY)
  // an encrypted value WITHOUT a keyring must fail closed (null), never leak the blob as key
  assert.equal(decryptSecretValue(SECRET_ENC_PREFIX + 'Zm9v', null), null)
})

test('fallback: broken keyring (isEncryptionAvailable false) → plaintext at rest, readable', () => {
  const ss = brokenSafeStorage()
  assert.equal(encryptSecretValue(KEY, ss), KEY)
  assert.equal(decryptSecretValue(KEY, ss), KEY)
})

test('corrupt encrypted blob decrypts to null (fail closed)', () => {
  const ss = workingSafeStorage()
  ss.decryptString = () => { throw new Error('bad blob') }
  assert.equal(decryptSecretValue(SECRET_ENC_PREFIX + 'not-valid', ss), null)
})

test('migrateSecret: plaintext row + working keyring → re-written encrypted', () => {
  const ss = workingSafeStorage()
  const written = []
  migrateSecret({
    read: () => KEY,
    write: (v) => written.push(v),
    safeStorage: ss
  })
  assert.equal(written.length, 1)
  assert.ok(written[0].startsWith(SECRET_ENC_PREFIX))
  assert.equal(decryptSecretValue(written[0], ss), KEY)
})

test('migrateSecret: no keyring or already-encrypted or missing row → no write', () => {
  const writes = []
  migrateSecret({ read: () => KEY, write: v => writes.push(v), safeStorage: null })
  migrateSecret({ read: () => SECRET_ENC_PREFIX + 'x', write: v => writes.push(v), safeStorage: workingSafeStorage() })
  migrateSecret({ read: () => null, write: v => writes.push(v), safeStorage: workingSafeStorage() })
  assert.equal(writes.length, 0)
})
