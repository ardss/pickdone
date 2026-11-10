import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthGate, GATE_ERRORS, OP_SCOPES } from '../../../shared/cross-platform/auth-gate.mjs'
import { issueToken, SCOPE_READ, SCOPE_WRITE, TOKEN_ERRORS, revokeToken } from '../../../shared/cross-platform/capability-token.mjs'

const SECRET = 'pairing-secret'
const NONCE = 'csrf-nonce-123'

function gateWithClock (start = 100_000, opts = {}) {
  let t = start
  const revocations = new Set()
  const gate = new AuthGate({ secret: SECRET, sessionNonce: NONCE, now: () => t, revocations, allowedOrigins: ['http://localhost:5173'], ...opts })
  return { gate, revocations, tick: ms => { t += ms } }
}

function req (over = {}) {
  return {
    op: 'sync.pull',
    origin: 'http://localhost:5173',
    csrfHeader: NONCE,
    deviceId: 'mob-1',
    messageId: 'm1',
    bearer: issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ, now: 100_000 }).token,
    ...over
  }
}

test('every op declares its minimum scope (WRITE ops reject READ tokens)', () => {
  for (const [op, scope] of Object.entries(OP_SCOPES)) {
    assert.ok(scope === SCOPE_READ || scope === SCOPE_WRITE, op)
  }
  const { gate } = gateWithClock()
  const readToken = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ, now: 100_000 }).token
  const r = gate.handle(req({ op: 'sync.push', bearer: readToken, messageId: 'w1' }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, TOKEN_ERRORS.BAD_SCOPE)
  assert.equal(r.status, 401)
})

test('no credentials (missing bearer) fails closed with 401', () => {
  const { gate } = gateWithClock()
  const r = gate.handle(req({ bearer: undefined }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, TOKEN_ERRORS.MISSING)
  assert.equal(r.status, 401)
})

test('expired bearer fails closed', () => {
  const { gate, tick } = gateWithClock()
  const shortToken = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ, now: 100_000, ttlMs: 500 }).token
  tick(501)
  const r = gate.handle(req({ bearer: shortToken, messageId: 'm2' }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, TOKEN_ERRORS.EXPIRED)
})

test('revoked device token fails closed with REVOKED', () => {
  const { gate, revocations } = gateWithClock()
  const token = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_READ, now: 100_000 }).token
  revokeToken(revocations, { deviceId: 'mob-1' })
  const r = gate.handle(req({ bearer: token, messageId: 'm3' }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, TOKEN_ERRORS.REVOKED)
})

test('unknown browser origin is rejected; allowlisted origin and loopback pass', () => {
  const { gate } = gateWithClock()
  const bad = gate.handle(req({ origin: 'https://evil.example', messageId: 'o1' }), () => 'ok')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, GATE_ERRORS.ORIGIN)
  assert.equal(bad.status, 403)
  assert.equal(gate.handle(req({ messageId: 'o2' }), () => 'ok').ok, true)
  const loop = gate.handle(req({ isLocalLoopback: true, origin: undefined, messageId: 'o3' }), () => 'ok')
  assert.equal(loop.ok, true)
})

test('CSRF guard: missing or wrong X-PickDone-Request header is rejected before auth', () => {
  const { gate } = gateWithClock()
  for (const [name, over] of [['missing', { csrfHeader: undefined }], ['wrong', { csrfHeader: 'attacker-value' }]]) {
    const r = gate.handle(req({ ...over, messageId: `c-${name}` }), () => 'never')
    assert.equal(r.ok, false, name)
    assert.equal(r.code, GATE_ERRORS.CSRF, name)
  }
})

test('duplicate message id returns the cached verdict with replay=true (idempotent, no re-execution)', () => {
  const { gate } = gateWithClock()
  let runs = 0
  const handler = () => { runs += 1; return { applied: 1 } }
  const first = gate.handle(req({ messageId: 'dup-1' }), handler)
  const second = gate.handle(req({ messageId: 'dup-1' }), handler)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.replay, true)
  assert.equal(runs, 1, 'handler must run exactly once per message id')
  assert.deepEqual(second.result, { applied: 1 })
})

test('duplicate message id on a WRITE op is also idempotent (no double apply)', () => {
  const { gate } = gateWithClock()
  const writeToken = issueToken(SECRET, { deviceId: 'mob-1', scope: SCOPE_WRITE, now: 100_000 }).token
  let runs = 0
  const handler = () => { runs += 1; return 'applied' }
  gate.handle(req({ op: 'sync.push', bearer: writeToken, messageId: 'push-1' }), handler)
  const again = gate.handle(req({ op: 'sync.push', bearer: writeToken, messageId: 'push-1' }), handler)
  assert.equal(again.replay, true)
  assert.equal(runs, 1)
})

test('message id is mandatory (replay protection needs it)', () => {
  const { gate } = gateWithClock()
  const r = gate.handle(req({ messageId: undefined }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, GATE_ERRORS.REPLAY_MALFORMED)
})

test('rate limit: exceeding the per-device window fails closed with retryAfterMs', () => {
  const { gate } = gateWithClock(100_000, { rate: { windowMs: 60_000, max: 3 } })
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.handle(req({ messageId: `rl-${i}` }), () => 'ok').ok, true)
  }
  const blocked = gate.handle(req({ messageId: 'rl-3' }), () => 'never')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, GATE_ERRORS.RATE_LIMITED)
  assert.equal(blocked.status, 429)
  assert.ok(blocked.retryAfterMs > 0)
})

test('a forged device id that mismatches the token device fails closed', () => {
  const { gate } = gateWithClock()
  const r = gate.handle(req({ deviceId: 'someone-else', messageId: 'f1' }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.status, 401)
})

test('unknown op fails closed with BAD_SCOPE', () => {
  const { gate } = gateWithClock()
  const r = gate.handle(req({ op: 'admin.nuke', messageId: 'u1' }), () => 'never')
  assert.equal(r.ok, false)
  assert.equal(r.code, TOKEN_ERRORS.BAD_SCOPE)
})

test('handler errors surface as 500 without leaking a throw', () => {
  const { gate } = gateWithClock()
  const r = gate.handle(req({ messageId: 'e1' }), () => { throw new Error('boom') })
  assert.equal(r.ok, false)
  assert.equal(r.status, 500)
  assert.equal(r.code, 'handler_error')
})

test('settled replay entries expire after the dedupe window', () => {
  const { gate, tick } = gateWithClock()
  let runs = 0
  gate.handle(req({ messageId: 'win-1' }), () => { runs += 1; return 1 })
  tick(10 * 60 * 1000 + 1)
  gate.handle(req({ messageId: 'win-1' }), () => { runs += 1; return 2 })
  assert.equal(runs, 2, 'a message outside the dedupe window is a NEW message')
})
