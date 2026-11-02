/* W29 (P3) — db init: an ENOENT-class open failure must fail IMMEDIATELY, not after the
 * 15s synchronous backoff ladder.
 *
 * The ioLike retry regex included ENOENT, so a disconnected network volume (or a deleted
 * parent dir) made boot block ~15s (1.5+3+4.5+6s Atomics.wait) and then fail anyway —
 * retrying a deterministic failure is meaningless. ENOENT now throws immediately
 * (err.enoent = true, NOT transientHold). Fresh installs (no todos.db) must keep working:
 * a healthy driver CREATES the missing file, so they never reach the ENOENT throw.
 *
 * Run: node --test tests/unit/main/w29-db-enoent-fastfail.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')

// Wrap the vendor driver: when globalThis.__w29FailOpen is set, the constructor throws an
// ENOENT-shaped error (the disconnected-volume shape) instead of opening; otherwise pass
// through to the REAL driver (the fresh-install regression needs a real db).
const realDriver = require(path.join(ROOT, 'vendor', 'better-sqlite3-multiple-ciphers'))
let openAttempts = 0
function WrappedDriver (file) {
  openAttempts++
  if (globalThis.__w29FailOpen) {
    throw new Error("ENOENT: no such file or directory, open 'Z:\\disconnected-share\\todos.db'")
  }
  return new realDriver(file)
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  // only intercept the JS entry of the vendor driver — NOT the native .node addon
  // (whose absolute path also contains 'better-sqlite3-multiple-ciphers')
  if (typeof request === 'string' && request.includes('better-sqlite3-multiple-ciphers') && !request.endsWith('.node')) return WrappedDriver
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require(path.join(ROOT, 'src', 'main', 'db.js'))

function tmpdir (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'w29-db-' + tag + '-')) }

test('w29: an ENOENT open failure fails on the FIRST attempt, no 15s backoff ladder', () => {
  const ud = tmpdir('enoent')
  globalThis.__w29FailOpen = true
  openAttempts = 0
  const t0 = Date.now()
  let err = null
  try { db.init(ud) } catch (e) { err = e }
  const elapsed = Date.now() - t0
  globalThis.__w29FailOpen = false
  assert.ok(err, 'init must throw on the ENOENT open failure')
  assert.equal(openAttempts, 1, 'RED before the fix: 5 attempts (1 + 4 retries) burned ~15s on a deterministic failure')
  assert.ok(elapsed < 5000, `no backoff ladder expected, took ${elapsed}ms`)
  assert.notEqual(err.transientHold, true, 'a deterministic ENOENT is not a transient hold')
})

test('w29 regression: fresh install (no todos.db, no db.key) still initializes a working empty db', () => {
  const ud = tmpdir('fresh')
  globalThis.__w29FailOpen = false
  openAttempts = 0
  db.init(ud) // must not throw — the driver creates the missing file
  assert.equal(fs.existsSync(path.join(ud, 'todos.db')), true, 'the fresh db file was created')
  db.call('upsert', { taskId: 'w29-1', content: 'w29 fresh install row', createdAt: 0, updatedAt: 0 })
  const rows = db.queryTodos({})
  assert.ok(rows.length >= 1, 'the fresh db is usable')
  assert.ok(openAttempts >= 1 && openAttempts <= 2, `open attempts sane (got ${openAttempts}; the encryption finalization may legally reopen once)`)
  db.close()
})
