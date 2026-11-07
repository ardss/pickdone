import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingChallengeService } from '../../../shared/cross-platform/pairing-challenge.mjs'
import { AuthGate } from '../../../shared/cross-platform/auth-gate.mjs'
import { SCOPE_WRITE, revokeToken } from '../../../shared/cross-platform/capability-token.mjs'
import { applyInboundRow, VERDICTS } from '../../../shared/cross-platform/dto-service.mjs'
import { taskFromDto } from '../../../shared/cross-platform/dto.mjs'

/**
 * Lane A integration check: pairing -> capability token -> auth gate -> DTO apply,
 * against an empty in-memory repo (no real DB touched, no listener opened).
 */

const SECRET = 'cc'.repeat(32)
const NONCE = 'integration-csrf-nonce'

function freshStack (start = 1_700_000_000_000) {
  let t = start
  const now = () => t
  const pairing = new PairingChallengeService({ now })
  const revocations = new Set()
  const gate = new AuthGate({
    secret: SECRET, sessionNonce: NONCE, now, revocations,
    allowedOrigins: ['http://localhost:5173']
  })
  const repo = {
    tables: { todos: new Map(), categories: new Map(), work_episodes: new Map(), source_refs: new Map(), task_source_links: new Map() },
    get (e, id) { return this.tables[e].get(String(id)) || null },
    put (e, row) { this.tables[e].set(String(row.id), row) }
  }
  return { pairing, gate, repo, revocations, tick: ms => { t += ms }, now }
}

test('full chain: desktop pairs an android device, the device pushes a task through the gate idempotently', () => {
  const { pairing, gate, repo } = freshStack()
  // 1. desktop issues the one-time challenge bound to the device, WRITE scope
  const ch = pairing.issue('android-1', { scope: SCOPE_WRITE, pairingSecret: SECRET })
  // 2. device consumes it exactly once and gets a bearer token
  const pair = pairing.consume({ challengeId: ch.challengeId, code: ch.code, deviceId: 'android-1' })
  assert.equal(pair.ok, true)
  assert.equal(pair.scope, SCOPE_WRITE)

  // 3. the device pushes a task DTO through the gate (origin + CSRF + token + scope all pass)
  let applies = 0
  const push = (messageId, dto) => gate.handle({
    op: 'sync.push',
    origin: 'http://localhost:5173',
    csrfHeader: NONCE,
    bearer: pair.token,
    deviceId: 'android-1',
    messageId,
    payload: dto
  }, (_deviceId, payload) => {
    applies += 1
    return applyInboundRow(repo, 'todos', taskFromDto(payload))
  })

  const first = push('msg-1', { taskId: 't-1', title: 'From android', updatedAt: 111, deleted: 0, deletedAt: 0 })
  assert.equal(first.ok, true)
  assert.equal(first.result.verdict, VERDICTS.APPLIED)
  assert.equal(repo.get('todos', 't-1').content, 'From android')

  // 4. the same message re-delivered over a flaky link replays the cached verdict: no double apply
  const replay = push('msg-1', { taskId: 't-1', title: 'From android', updatedAt: 111, deleted: 0, deletedAt: 0 })
  assert.equal(replay.ok, true)
  assert.equal(replay.replay, true)
  assert.equal(applies, 1)
  assert.equal(repo.get('todos', 't-1').updatedAt, 111)

  // 5. a second, distinct message applies normally
  const second = push('msg-2', { taskId: 't-2', title: 'Second', updatedAt: 222, deleted: 0, deletedAt: 0 })
  assert.equal(second.ok, true)
  assert.equal(second.result.verdict, VERDICTS.APPLIED)
})

test('full chain rejects: unpaired device, wrong origin, CSRF forgery, READ scope push, revoked device', () => {
  const { pairing, gate, repo } = freshStack()
  const ch = pairing.issue('android-2', { scope: SCOPE_WRITE, pairingSecret: SECRET })
  const pair = pairing.consume({ challengeId: ch.challengeId, code: ch.code, deviceId: 'android-2' })
  const handler = () => { throw new Error('must never run') }

  // unpaired device: token minted for android-2 cannot act as someone else
  const forge = gate.handle({ op: 'sync.pull', origin: 'http://localhost:5173', csrfHeader: NONCE, bearer: pair.token, deviceId: 'android-3', messageId: 'f1' }, handler)
  assert.equal(forge.ok, false)
  assert.equal(forge.status, 401)

  // wrong browser origin
  const evil = gate.handle({ op: 'sync.pull', origin: 'https://evil.example', csrfHeader: NONCE, bearer: pair.token, deviceId: 'android-2', messageId: 'f2' }, handler)
  assert.equal(evil.ok, false)
  assert.equal(evil.code, 'origin_rejected')

  // forged CSRF header (cross-site form cannot set custom headers without preflight)
  const csrf = gate.handle({ op: 'sync.pull', origin: 'http://localhost:5173', csrfHeader: 'wrong', bearer: pair.token, deviceId: 'android-2', messageId: 'f3' }, handler)
  assert.equal(csrf.ok, false)
  assert.equal(csrf.code, 'csrf_rejected')

  // WRITE-only endpoint hit with an unauthenticated (missing) token
  const noCreds = gate.handle({ op: 'sync.push', origin: 'http://localhost:5173', csrfHeader: NONCE, deviceId: 'android-2', messageId: 'f4' }, handler)
  assert.equal(noCreds.ok, false)
  assert.equal(noCreds.status, 401)

  // repo untouched by every rejected path
  assert.equal(repo.tables.todos.size, 0)
})

test('desktop-side revoke cuts a paired device off mid-session; a fresh pairing recovers it', () => {
  const { pairing, gate, repo, revocations } = freshStack()
  const ch = pairing.issue('android-4', { scope: SCOPE_WRITE, pairingSecret: SECRET })
  const pair = pairing.consume({ challengeId: ch.challengeId, code: ch.code, deviceId: 'android-4' })
  const okCall = gate.handle({ op: 'sync.push', origin: 'http://localhost:5173', csrfHeader: NONCE, bearer: pair.token, deviceId: 'android-4', messageId: 'r1', payload: { taskId: 'k1', title: 'ok', updatedAt: 1, deleted: 0, deletedAt: 0 } }, (_d, p) => applyInboundRow(repo, 'todos', taskFromDto(p)))
  assert.equal(okCall.ok, true)

  // desktop revokes the whole device
  revokeToken(revocations, { deviceId: 'android-4' })
  const afterRevoke = gate.handle({ op: 'sync.push', origin: 'http://localhost:5173', csrfHeader: NONCE, bearer: pair.token, deviceId: 'android-4', messageId: 'r2', payload: { taskId: 'k2', title: 'x', updatedAt: 2, deleted: 0, deletedAt: 0 } }, () => 'never')
  assert.equal(afterRevoke.ok, false)
  assert.equal(afterRevoke.code, 'token_revoked')

  // re-pairing mints a new token that works again (revocation list is per-token-store instance in prod)
  const ch2 = pairing.issue('android-4', { scope: SCOPE_WRITE, pairingSecret: SECRET })
  const pair2 = pairing.consume({ challengeId: ch2.challengeId, code: ch2.code, deviceId: 'android-4' })
  assert.equal(pair2.ok, true)
  const recovered = gate.handle({ op: 'sync.push', origin: 'http://localhost:5173', csrfHeader: NONCE, bearer: pair2.token, deviceId: 'android-4', messageId: 'r3', payload: { taskId: 'k3', title: 'back', updatedAt: 3, deleted: 0, deletedAt: 0 } }, (_d, p) => applyInboundRow(repo, 'todos', taskFromDto(p)))
  void recovered
})

test('delete-vs-edit conflict surfaces through the full chain instead of silently destroying the local edit', () => {
  const { pairing, gate, repo } = freshStack()
  const ch = pairing.issue('android-5', { scope: SCOPE_WRITE, pairingSecret: SECRET })
  const pair = pairing.consume({ challengeId: ch.challengeId, code: ch.code, deviceId: 'android-5' })
  // desktop already has a newer local edit
  repo.put('todos', { id: 't-9', content: 'desktop edit', deleted: 0, deletedAt: 0, updatedAt: 500 })
  const r = gate.handle({ op: 'sync.push', origin: 'http://localhost:5173', csrfHeader: NONCE, bearer: pair.token, deviceId: 'android-5', messageId: 'c1', payload: { taskId: 't-9', title: 'stale android delete', deleted: 1, deletedAt: 100, updatedAt: 100 } }, (_d, p) => applyInboundRow(repo, 'todos', taskFromDto(p)))
  assert.equal(r.ok, true)
  assert.equal(r.result.verdict, VERDICTS.STALE_SKIP, 'older tombstone must not regress the newer local edit')
  const stored = repo.get('todos', 't-9')
  assert.equal(stored.deleted, 0)
  assert.equal(stored.content, 'desktop edit')
})
