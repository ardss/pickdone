import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  issueToken, verifyToken, revokeToken, TOKEN_ERRORS,
  SCOPE_READ, SCOPE_WRITE, DEFAULT_TOKEN_TTL_MS
} from '../../../shared/cross-platform/capability-token.mjs'

const SECRET = 'pairing-secret-hex-32bytes-worth'

test('no credential is rejected (missing token fails closed)', () => {
  const v = verifyToken(SECRET, undefined)
  assert.equal(v.ok, false)
  assert.equal(v.code, TOKEN_ERRORS.MISSING)
})

test('a freshly issued token verifies with its device, scope and expiry', () => {
  const now = 1_000_000
  const { token, jti, expiresAt } = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_WRITE, now })
  assert.equal(expiresAt, now + DEFAULT_TOKEN_TTL_MS)
  const v = verifyToken(SECRET, token, { now })
  assert.equal(v.ok, true)
  assert.equal(v.payload.deviceId, 'mob-1')
  assert.equal(v.payload.scope, SCOPE_WRITE)
  assert.equal(v.payload.jti, jti)
})

test('expired token fails closed with EXPIRED', () => {
  const now = 1_000_000
  const { token } = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ, now, ttlMs: 1000 })
  const v = verifyToken(SECRET, token, { now: now + 1001 })
  assert.equal(v.ok, false)
  assert.equal(v.code, TOKEN_ERRORS.EXPIRED)
})

test('tampered token fails closed with BAD_SIGNATURE', () => {
  const { token } = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ })
  const [body] = token.split('.')
  // wrong mac, right shape
  const swapped = `${body}.${issueToken(SECRET, { deviceId: 'other', scope: SCOPE_READ }).token.split('.')[1]}`
  assert.equal(verifyToken(SECRET, swapped).code, TOKEN_ERRORS.BAD_SIGNATURE)
  // structurally malformed shapes
  assert.equal(verifyToken(SECRET, 'only-one-part').code, TOKEN_ERRORS.MALFORMED)
  assert.equal(verifyToken(SECRET, 'a.b.c').code, TOKEN_ERRORS.MALFORMED)
  // garbage body (valid base64url chars, junk payload): signature check fires first
  assert.equal(verifyToken(SECRET, `!!!!.${token.split('.')[1]}`).code, TOKEN_ERRORS.BAD_SIGNATURE)
})

test('wrong signing secret fails closed (no second trust root accepted)', () => {
  const { token } = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ })
  const v = verifyToken('a-different-secret', token)
  assert.equal(v.ok, false)
  assert.equal(v.code, TOKEN_ERRORS.BAD_SIGNATURE)
})

test('jti revocation and whole-device revocation both fail closed with REVOKED', () => {
  const revocations = new Set()
  const a = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ })
  const b = issueToken(SECRET, { deviceId: 'mob-2', scope: SCOPE_READ })
  revokeToken(revocations, { jti: a.jti })
  assert.equal(verifyToken(SECRET, a.token, { revocations }).code, TOKEN_ERRORS.REVOKED)
  assert.equal(verifyToken(SECRET, b.token, { revocations }).ok, true)
  revokeToken(revocations, { deviceId: 'mob-2' })
  assert.equal(verifyToken(SECRET, b.token, { revocations }).code, TOKEN_ERRORS.REVOKED)
})

test('scope enforcement: READ token cannot perform a WRITE op; WRITE implies READ', () => {
  const read = issueToken(SECRET, { deviceId: 'd', scope: SCOPE_READ }).token
  const write = issueToken(SECRET, { deviceId: 'd', scope: SCOPE_WRITE }).token
  assert.equal(verifyToken(SECRET, read, { requiredScope: SCOPE_WRITE }).code, TOKEN_ERRORS.BAD_SCOPE)
  assert.equal(verifyToken(SECRET, write, { requiredScope: SCOPE_WRITE }).ok, true)
  assert.equal(verifyToken(SECRET, write, { requiredScope: SCOPE_READ }).ok, true)
})

test('issueToken refuses unknown scopes and missing inputs (fail closed at mint time)', () => {
  assert.throws(() => issueToken(SECRET, { deviceId: 'd', scope: 'ADMIN' }), TypeError)
  assert.throws(() => issueToken(null, { deviceId: 'd', scope: SCOPE_READ }), TypeError)
  assert.throws(() => issueToken(SECRET, { scope: SCOPE_READ }), TypeError)
})
