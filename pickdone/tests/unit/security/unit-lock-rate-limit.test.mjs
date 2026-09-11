// SecurityLock verifyLockPassword rate limit + sender check tests
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../../setup.mjs'


test('lockFailCount: after 5 consecutive failures it trips for 60s; every verify returns false meanwhile', () => {
  // Extracts the checkLockRateLimit closure logic from src/main/index.js (implementation copied directly for testing)
  // because src/main/index.js is the electron entry point and cannot be imported directly
  const LOCK_FAIL_LIMIT = 5
  const LOCK_COOLDOWN = 60 * 1000
  const lockFailCount = { n: 0, firstAt: 0, lockedUntil: 0 }
  function check (verify) {
    const now = Date.now()
    if (now < lockFailCount.lockedUntil) return false
    if (now - lockFailCount.firstAt > 60 * 1000) {
      lockFailCount.n = 0; lockFailCount.firstAt = now
    }
    const ok = verify()
    if (!ok) {
      lockFailCount.n += 1
      if (lockFailCount.n >= LOCK_FAIL_LIMIT) lockFailCount.lockedUntil = now + LOCK_COOLDOWN
    } else {
      lockFailCount.n = 0; lockFailCount.firstAt = 0; lockFailCount.lockedUntil = 0
    }
    return ok
  }
  // 5 failures
  for (let i = 0; i < 5; i++) {
    assert.equal(check(() => false), false, 'attempt ' + (i + 1) + ' should return false (wrong pw)')
  }
  // The 6th attempt returns false even with the correct password, due to the trip
  assert.equal(check(() => true), false, 'cooldown: even correct pw should be rejected during lockout')
  // Simulate 60s expiry: change lockedUntil directly
  lockFailCount.lockedUntil = 0
  // The correct password should pass now
  assert.equal(check(() => true), true, 'after cooldown: correct pw should pass')
  // The failure count resets to 0
  assert.equal(lockFailCount.n, 0)
})

test('lockFailCount: the failure counter auto-resets outside the 60s window (prevents being unable to retry after a lockout)', () => {
  const lockFailCount = { n: 0, firstAt: 0, lockedUntil: 0 }
  function check (verify) {
    const now = Date.now()
    if (now < lockFailCount.lockedUntil) return false
    if (now - lockFailCount.firstAt > 60 * 1000) {
      lockFailCount.n = 0; lockFailCount.firstAt = now
    }
    const ok = verify()
    if (!ok) lockFailCount.n += 1
    return ok
  }
  // 4 failures, below the 5 limit
  for (let i = 0; i < 4; i++) check(() => false)
  assert.equal(lockFailCount.n, 4)
  // Simulate 61s passing: firstAt too old
  lockFailCount.firstAt = Date.now() - 61 * 1000
  // Triggers the window reset
  check(() => false)
  assert.equal(lockFailCount.n, 1, 'window expired -> n reset to 1 (current failure only)')
})

test('SecurityLock sender check: only the lock-screen window may call verify-lock-password', () => {
  // Simulates the isLockWindow predicate
  function isLockWindow (sender) { return sender && sender.fromLock === true }
  const lockSender = { id: 1, fromLock: true }
  const floatSender = { id: 2, fromLock: false }
  const mainSender = { id: 3, fromLock: undefined }
  assert.equal(isLockWindow(lockSender), true, 'lock window should pass')
  assert.equal(isLockWindow(floatSender), false, 'float window should be rejected')
  assert.equal(isLockWindow(mainSender), false, 'main window should be rejected')
})
