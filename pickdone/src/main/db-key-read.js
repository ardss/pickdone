'use strict'
/**
 * D18 (2026-10-02): db.js init used to read db.key with a bare fs.readFileSync — a transient
 * Windows file lock (EPERM/EBUSY from an AV scanner or indexer) threw out of init, dbRecovery
 * saw an intact SQLite header and answered 'transient' with NO backoff, and the immediate
 * re-init failure surfaced the reset-data dialog for a perfectly healthy database.
 *
 * This module holds the pure retry helper: bounded backoff retries (aligned with the
 * config-store.js read-backoff pattern), and on exhaustion a DISTINCT coded error
 * (DB_KEY_TRANSIENT_UNREADABLE) so index.js can classify the failure as transient/retryable
 * and keep the recovery path conservative (no recovery rename, no reset-data offer — the
 * database itself is fine, only the key file is locked). Pure/injected so it is unit-testable
 * without touching the real file system or sleeping for real.
 */

/** Synchronous backoff: init's contract is sync (startup runs before any async plumbing).
 *  Atomics.wait when available, honest busy-spin fallback otherwise (same pattern as
 *  config-store.sleepBackoff). Exported for tests so the fake sleep can count calls. */
function sleepSync (ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return } catch { /* no SAB/Atomics.wait: busy spin below keeps the delay real */ }
  const end = Date.now() + ms
  while (Date.now() < end) { /* spin */ }
}

/**
 * Read the DB key file with bounded backoff. Returns the trimmed key, or null when the key
 * file does not exist (fresh install / plaintext db). Throws Error with code
 * DB_KEY_TRANSIENT_UNREADABLE when the file exists but stayed unreadable for the whole budget.
 * All IO/sleep is injectable for tests.
 */
function readDbKeyWithRetry (keyFile, {
  exists = p => require('fs').existsSync(p),
  read = p => require('fs').readFileSync(p, 'utf8'),
  attempts = 3,
  backoffMs = 500,
  sleep = sleepSync
} = {}) {
  if (!exists(keyFile)) return null
  let lastErr = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) sleep(backoffMs) // backoff BETWEEN attempts, not before the first
    try { return read(keyFile).trim() } catch (e) { lastErr = e }
  }
  const err = new Error('db.key is present but stayed unreadable for ' + attempts +
    ' attempts: ' + ((lastErr && lastErr.message) || lastErr))
  err.code = 'DB_KEY_TRANSIENT_UNREADABLE'
  err.cause = lastErr
  throw err
}

module.exports = { readDbKeyWithRetry, sleepSync, DB_KEY_TRANSIENT_UNREADABLE: 'DB_KEY_TRANSIENT_UNREADABLE' }
