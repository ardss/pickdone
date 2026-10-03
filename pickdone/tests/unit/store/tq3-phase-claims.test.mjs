/** TQ-3 (2026-10-03) — main-process compare-and-set phase claims.
 *
 * Invariants under test:
 *  [A] at most one claimer per phase (two concurrent claims → exactly one win);
 *  [B] only the claim OWNER can release — a contender's release-on-failure path can never
 *      delete the owner's live claim (the ownerless-LS-value defect);
 *  [C] the renderer's claimPhase funnels through the main-process bridge when present, and
 *      completeFocus/giveUp/finishRest honor the bridge verdict.
 *
 * Run: node --test tests/unit/store/tq3-phase-claims.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPhaseClaims, claims } = require('../../../src/main/phase-claims.js')

test('tq3[A]: two claims for the same phase — exactly one wins (main-process CAS, not LS check-then-set)', () => {
  const c = createPhaseClaims()
  const first = c.claim('startTomatoTime:111')
  assert.equal(first.won, true)
  assert.ok(first.token, 'winner receives an owner token')
  const second = c.claim('startTomatoTime:111')
  assert.equal(second.won, false, 'the contender loses')
  assert.equal(second.token, null)
  // distinct phases never block each other
  assert.equal(c.claim('startTomatoTime:222').won, true)
})

test('tq3[B]: a non-owner release leaves the claim intact; only the owner token deletes it', () => {
  const c = createPhaseClaims()
  const { token } = c.claim('startRestTime:333')
  assert.equal(c.release('startRestTime:333', 'forged-token'), false, 'forged token refused')
  assert.equal(c.release('startRestTime:333', undefined), false, 'missing token refused')
  assert.equal(c.isClaimed('startRestTime:333'), true, 'the owner claim SURVIVES a contender release attempt')
  assert.equal(c.release('startRestTime:333', token), true, 'owner release succeeds')
  assert.equal(c.isClaimed('startRestTime:333'), false)
  // release of a never-claimed phase is a harmless false
  assert.equal(c.release('nope', 'x'), false)
})

test('tq3[B2]: the shared process-lifetime singleton behaves identically (handlers use it)', () => {
  const r = claims.claim('singleton:1')
  assert.equal(r.won, true)
  assert.equal(claims.claim('singleton:1').won, false)
  assert.equal(claims.release('singleton:1', 'wrong'), false)
  assert.equal(claims.release('singleton:1', r.token), true)
})

/* ---- [C] the renderer store funnels every completion transition through the bridge ---- */

function makeCtx (tomato, statePatch = {}) {
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now(),
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: null, tomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  const ctx = {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  return { ctx, state }
}

test('tq3[C]: completeFocus claims through the main-process bridge; a lost bridge claim blocks the completion', async () => {
  const bridgeClaims = []
  globalThis.window.todoAPI = {
    dbCall: async () => ({ accepted: 1, rejected: [] }),
    tomatoClaimPhase: phase => {
      bridgeClaims.push(phase)
      return { won: bridgeClaims.length === 1, token: 'tok-' + bridgeClaims.length }
    },
    tomatoReleasePhase: () => {}
  }
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?tq3-bridge')
  const startedAt = Date.now()
  const a = makeCtx(tomato, { startedAt })
  await tomato.actions.completeFocus(a.ctx)
  assert.equal(a.state.tomatoRecordList.length, 1, 'first (winning) claim completes the focus')
  assert.ok(bridgeClaims[0].startsWith('startTomatoTime:'), 'claim went through the main-process bridge')
  // a second window replaying the same phase loses at the bridge (not at a racy LS read)
  const b = makeCtx(tomato, { startedAt })
  await tomato.actions.completeFocus(b.ctx)
  assert.equal(b.state.tomatoRecordList.length, 0, 'the contender is refused — one set of side effects per phase')
  delete globalThis.window.todoAPI.tomatoClaimPhase
  delete globalThis.window.todoAPI.tomatoReleasePhase
})

test('tq3[C2]: a mid-completion failure releases via the OWNER TOKEN — an ownerless value can never be deleted by a peer', async () => {
  const released = []
  const token = 'owner-tok-1'
  globalThis.window.todoAPI = {
    dbCall: async () => { throw new Error('db died mid-completion') },
    tomatoClaimPhase: () => ({ won: true, token }),
    tomatoReleasePhase: (phase, tok) => { released.push([phase, tok]) }
  }
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?tq3-release')
  const startedAt = Date.now()
  // attachTodo whose property access throws — the G1 guard stretch (resolveFocusedTask) fails
  // before any booking, exercising exactly the release-on-failure path.
  const evilAttach = {}
  Object.defineProperty(evilAttach, 'taskId', { get () { throw new Error('boom') } })
  const a = makeCtx(tomato, { startedAt, attachTodo: evilAttach })
  await assert.rejects(tomato.actions.completeFocus(a.ctx)) // booking throws → G1 releases the claim for retry
  await new Promise(r => setTimeout(r, 10))
  assert.ok(released.some(([p, t]) => t === token && p === 'startTomatoTime:' + startedAt),
    'the release carries the owner token (main-side release only deletes on a match)')
  assert.equal(globalThis.localStorage.getItem('tomatoLastPhaseDone'), null,
    'no ownerless LS residue on the bridge path')
  delete globalThis.window.todoAPI.tomatoClaimPhase
  delete globalThis.window.todoAPI.tomatoReleasePhase
})
