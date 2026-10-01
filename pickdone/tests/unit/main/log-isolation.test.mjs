/**
 * Log-isolation guard (root fix for test processes writing the REAL %APPDATA%/pickdone/logs/main.log).
 *
 * Reproduces the maint0924-style pollution: a plain-Node child that only sets TODO_DB_DIR,
 * then requires src/main/db.js (which acquires electron-log and logs). Before the fix the
 * electron-log file transport resolved the REAL app log path and appended there
 * ("injected migration failure" / "poison row" / Temp\maint0924 lines were found in the
 * user's real main.log).
 *
 * Assertions:
 *   1. The child process runs with ONLY TODO_DB_DIR set (no TODO_USER_DATA_DIR).
 *   2. The child's marker line NEVER appears in the REAL main.log.
 *   3. Byte growth of the REAL main.log across the run is zero — OR, if the user's live
 *      app instance appended concurrently (the real log is live, so exact equality is
 *      inherently racy), the appended bytes are proven to not contain our marker.
 *      Skipped entirely when the real log does not exist.
 *   4. The child's log lines land in <TODO_DB_DIR>/logs/main.log instead.
 *
 * Run: node --test tests/unit/main/log-isolation.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REAL_LOG = path.join(process.env.APPDATA || '', 'pickdone', 'logs', 'main.log')
const MARKER = `log-isolation guard probe ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const CHILD_SCRIPT = `
const path = require('path')
const db = require(${JSON.stringify(path.join(APP_ROOT, 'src', 'main', 'db.js'))})
db.init(process.env.TODO_DB_DIR)
// Simulate the maint0924 test seam: modules under test log through electron-log
require(${JSON.stringify(path.join(APP_ROOT, 'node_modules', 'electron-log'))}).info(${JSON.stringify(MARKER)})
`

test('child with only TODO_DB_DIR must not append to the REAL main.log', { timeout: 120000 }, (t) => {
  const before = fs.existsSync(REAL_LOG) ? fs.statSync(REAL_LOG) : null
  if (!before) {
    t.skip(`real main.log does not exist at ${REAL_LOG} — nothing to protect; isolation still asserted below`)
  }
  const beforeBytes = before ? fs.readFileSync(REAL_LOG) : null

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-iso-guard-'))
  t.after(() => { try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch { /* best effort */ } })

  // ONLY TODO_DB_DIR is set — this is the exact configuration that used to leak
  const r = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, TODO_DB_DIR: dbDir, TODO_USER_DATA_DIR: '' }
  })
  assert.equal(r.status, 0, `child exited cleanly. stderr: ${r.stderr}`)

  if (before) {
    const after = fs.statSync(REAL_LOG)
    const realContent = fs.readFileSync(REAL_LOG, 'utf8')
    assert.ok(!realContent.includes(MARKER),
      `child's probe line must NEVER appear in the REAL main.log (${REAL_LOG})`)
    if (after.size === before.size) {
      assert.equal(after.mtimeMs, before.mtimeMs, 'real main.log mtime unchanged (no concurrent writer)')
    } else {
      // The user's live instance may append concurrently; our child must not be the writer.
      const appended = realContent.slice(beforeBytes.length)
      assert.ok(!appended.includes(MARKER),
        'real main.log grew during the run but the appended bytes must not be from the isolated child')
      t.diagnostic(`note: real main.log grew by ${after.size - before.size} bytes from a concurrent writer (user's live app); verified the child's marker is not among the appended bytes`)
    }
  }

  // The redirected log exists inside the isolation dir and holds the marker
  const redirected = path.join(dbDir, 'logs', 'main.log')
  assert.ok(fs.existsSync(redirected), `log redirected into the isolation dir (${redirected})`)
  assert.ok(fs.readFileSync(redirected, 'utf8').includes(MARKER),
    'the probe line landed in the redirected log, not the real one')
})
