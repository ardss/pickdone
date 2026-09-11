/** Security-lock + secure-storage IPC handlers (pure relocation from index.js registerIpc). */
const log = require('electron-log')
const { makeAssertMainWindow } = require('./shared')

module.exports = function securityHandlers (ctx) {
  const { lockAppNow, unlockAppNow, verifyLockPassword, isLockWindow, getMainWindow } = ctx
  const assertMainWindow = makeAssertMainWindow(getMainWindow)

  // Lock-screen password brute-force throttling: after 5 failures, trip for 60s (guards against dictionary attacks)
  const LOCK_FAIL_LIMIT = 5
  const LOCK_FAIL_WINDOW = 60 * 1000
  const LOCK_COOLDOWN = 60 * 1000
  const lockFailCount = { n: 0, firstAt: 0, lockedUntil: 0 }
  function checkLockRateLimit (plain) {
    const now = Date.now()
    if (now < lockFailCount.lockedUntil) return false // currently tripped
    if (now - lockFailCount.firstAt > LOCK_FAIL_WINDOW) {
      lockFailCount.n = 0; lockFailCount.firstAt = now
    }
    const ok = verifyLockPassword(plain)
    if (!ok) {
      lockFailCount.n += 1
      if (lockFailCount.n >= LOCK_FAIL_LIMIT) {
        lockFailCount.lockedUntil = now + LOCK_COOLDOWN
        log.warn('[SecurityLock] 失败 ' + lockFailCount.n + ' 次，熔断 60s')
      }
    } else {
      lockFailCount.n = 0; lockFailCount.firstAt = 0; lockFailCount.lockedUntil = 0
    }
    return ok
  }

  return {
    // --- Security lock (verification happens entirely in the main process; the plaintext password is never returned to the renderer) ---
    'lock-app': () => { lockAppNow() },
    // Unlock may only be initiated by the lock-screen window itself (prevents the float/other windows from calling without a password)
    'unlock-app': (e) => { if (isLockWindow(e.sender)) unlockAppNow() },
    // Password verification: (1) must be initiated by the lock-screen window (prevents brute force from any renderer window) (2) 5 failures trip a 60s cooldown (prevents dictionary attacks)
    'verify-lock-password': (e, plain) => {
      if (!isLockWindow(e.sender)) {
        log.warn('[SecurityLock] 拒绝 verify-lock-password from non-lock window, sender:', e.sender.id)
        return false
      }
      return checkLockRateLimit(plain)
    },
    // --- Secure storage: sensitive values like securityLockPassword encrypted with safeStorage (DPAPI/Keychain) ---
    // Main window only: encrypt/decrypt primitives serve only the main window's settings page and lock-screen flow; a compromised float/quick-add window must not use them to recover plaintext
    'encrypt-secret': (e, plain) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      // When encryption is unavailable, refuse rather than persist plaintext (storing the lock password in plaintext contradicts "secure storage"; open-source audits would flag it).
      // Windows DPAPI is always available; this branch realistically only appears in anomalous environments.
      const { safeStorage } = require('electron')
      if (!plain) return ''
      if (!safeStorage.isEncryptionAvailable()) throw new Error('secure-encryption-unavailable')
      return 'enc1:' + safeStorage.encryptString(String(plain)).toString('base64')
    },
    'decrypt-secret': (e, stored) => {
      assertMainWindow(e) // main-window guard via getMainWindow (isDestroyed-safe; bare module var win threw "Object has been destroyed" after X-close→tray)
      try {
        const { safeStorage } = require('electron')
        if (!stored) return ''
        if (!stored.startsWith('enc1:')) return stored // backward compatible with historical plaintext
        if (!safeStorage.isEncryptionAvailable()) return ''
        return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
      } catch { return '' }
    }
  }
}
