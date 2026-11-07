import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingChallengeService, PAIRING_ERRORS, MAX_ATTEMPTS } from '../../../shared/cross-platform/pairing-challenge.mjs'
import { derivePairingCode } from '../../../shared/sync-core/pairing.mjs'
import { PAIRING_CODE_TTL_MS } from '../../../shared/pairing-ttl.mjs'
import { verifyToken, SCOPE_WRITE } from '../../../shared/cross-platform/capability-token.mjs'

function serviceWithClock (start = 50_000) {
  let t = start
  return { svc: new PairingChallengeService({ now: () => t }), tick: ms => { t += ms } }
}

test('happy path: correct code mints exactly one scoped token', () => {
  const { svc } = serviceWithClock()
  const secret = 'ab'.repeat(32)
  const { challengeId, code, expiresAt } = svc.issue('android-1', { scope: SCOPE_WRITE, pairingSecret: secret })
  assert.ok(expiresAt <= 50_000 + PAIRING_CODE_TTL_MS)
  assert.match(code, /^\d{6}$/)
  const r = svc.consume({ challengeId, code, deviceId: 'android-1' })
  assert.equal(r.ok, true)
  // the minted token is a real capability token verifiable with the pairing secret
  const v = verifyToken(secret, r.token, { requiredScope: SCOPE_WRITE, now: 50_000 })
  assert.equal(v.ok, true)
  assert.equal(v.payload.deviceId, 'android-1')
  assert.equal(r.scope, SCOPE_WRITE)
  assert.equal(r.deviceId, 'android-1')
})

test('the challenge is ONE-SHOT: replaying the same code fails with BURNED', () => {
  const { svc } = serviceWithClock()
  const { challengeId, code } = svc.issue('mob-2')
  assert.equal(svc.consume({ challengeId, code, deviceId: 'mob-2' }).ok, true)
  const replay = svc.consume({ challengeId, code, deviceId: 'mob-2' })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, PAIRING_ERRORS.BURNED)
})

test('expired challenge fails closed and never mints a token', () => {
  const { svc, tick } = serviceWithClock()
  const { challengeId, code } = svc.issue('mob-3')
  tick(PAIRING_CODE_TTL_MS + 1)
  const r = svc.consume({ challengeId, code, deviceId: 'mob-3' })
  assert.equal(r.ok, false)
  assert.equal(r.code, PAIRING_ERRORS.EXPIRED)
})

test('unknown challenge id and malformed requests fail closed', () => {
  const { svc } = serviceWithClock()
  assert.equal(svc.consume({ challengeId: 'nope', code: '123456', deviceId: 'x' }).code, PAIRING_ERRORS.NO_CHALLENGE)
  assert.equal(svc.consume({ challengeId: '', code: '1', deviceId: 'x' }).code, PAIRING_ERRORS.BAD_REQUEST)
  assert.equal(svc.consume({ challengeId: 'c', code: '1' }).code, PAIRING_ERRORS.BAD_REQUEST)
})

test('a different device probing a challenge burns it (BAD_CODE, no token)', () => {
  const { svc } = serviceWithClock()
  const { challengeId, code } = svc.issue('mob-4')
  const r = svc.consume({ challengeId, code, deviceId: 'attacker' })
  assert.equal(r.ok, false)
  assert.equal(r.code, PAIRING_ERRORS.BAD_CODE)
  assert.equal(svc.consume({ challengeId, code, deviceId: 'mob-4' }).code, PAIRING_ERRORS.BURNED)
})

test('wrong codes are throttled: MAX_ATTEMPTS bad tries burn the challenge', () => {
  const { svc } = serviceWithClock()
  const { challengeId, code } = svc.issue('mob-5')
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = svc.consume({ challengeId, code: '000000', deviceId: 'mob-5' })
    assert.equal(r.code, PAIRING_ERRORS.BAD_CODE)
  }
  // even the CORRECT code no longer works after the burn
  const last = svc.consume({ challengeId, code, deviceId: 'mob-5' })
  assert.equal(last.ok, false)
  assert.equal(last.code, PAIRING_ERRORS.THROTTLED)
})

test('issued code verifies against the desktop derivation scheme (one scheme, no drift)', () => {
  const { svc } = serviceWithClock()
  const secret = 'feedface'.repeat(8)
  const { challengeId, code } = svc.issue('mob-6', { pairingSecret: secret })
  assert.equal(code, derivePairingCode(secret, 'mob-6'))
  assert.equal(svc.consume({ challengeId, code, deviceId: 'mob-6' }).ok, true)
})

test('sweep drops dead challenges but keeps live ones', () => {
  const { svc, tick } = serviceWithClock()
  const a = svc.issue('mob-7')
  svc.consume({ challengeId: a.challengeId, code: a.code, deviceId: 'mob-7' })
  tick(PAIRING_CODE_TTL_MS + 1)
  const b = svc.issue('mob-8') // issued after the tick: still live
  svc.sweep()
  assert.equal(svc.challenges.size, 1)
  assert.ok(svc.challenges.has(b.challengeId))
})
