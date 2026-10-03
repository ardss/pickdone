/**
 * Regression: enc-migration-preflight-ignores-key-quarantine-failure (2026-10-02).
 *
 * preflightMigrateResidue (dbRecovery.cjs) used to swallow a failed db.key rename (`catch {}`)
 * and PROCEED: unconditional sidecar rm + copyFileSync(todos.db.plain-bak, todos.db) + return
 * true — while the stale db.key was still on disk. The follow-up init reopened the restored
 * PLAINTEXT db with the OLD WRONG key and db.js landed in the permanent transient/dbEncMismatch
 * dead-loop. Root-cause rule (M-1 / D13 #14 doctrine): a key that cannot be moved aside ABORTS
 * the migration — log the specific error, touch nothing, return false so the next boot retries.
 *
 * Run: node --test tests/unit/main/dbrecovery-preflight-key-abort.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbRecovery = require('../../../src/main/dbRecovery.cjs')

const SQLITE_HEADER = Buffer.from('SQLite format 3\x00' + '.'.repeat(32), 'binary')

function tmpUd () {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-key-abort-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  return ud
}

/** Patch fs.renameSync to throw only for db.key (the AV/lock-held scene), restore afterwards.
 *  dbRecovery.cjs captures the fs module object at require time, so patching the shared module
 *  object reaches the code under test. */
function withKeyRenameFailure (ud, fn) {
  const realRename = fs.renameSync
  fs.renameSync = (src, dest) => {
    if (typeof src === 'string' && src === path.join(ud, 'db.key')) {
      throw new Error('EPERM: injected key-rename failure (simulated lock/AV hold)')
    }
    return realRename(src, dest)
  }
  try { return fn() } finally { fs.renameSync = realRename }
}

test('key-rename failure: preflight returns false and leaves todos.db absent, plain-bak + db.key untouched', () => {
  const ud = tmpUd()
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), SQLITE_HEADER) // valid plaintext backup
  fs.writeFileSync(path.join(ud, 'db.key'), 'a'.repeat(64))
  const r = withKeyRenameFailure(ud, () => dbRecovery.preflightMigrateResidue(ud))
  assert.equal(r, false, 'red before the fix: the swallowed rename failure let the flow continue and returned true')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db')), false, 'todos.db stays ABSENT — the plaintext bak was never copied over a fresh shell')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db.plain-bak')), true, 'the last backup is untouched')
  assert.equal(fs.readFileSync(path.join(ud, 'db.key'), 'utf8'), 'a'.repeat(64), 'the stale key is untouched (no .superseded-* rename happened)')
  assert.equal(fs.readdirSync(ud).filter(f => f.includes('.superseded-') || f.startsWith('todos.db-wal') || f.startsWith('todos.db-shm')).length, 0,
    'no sidecar sweep and no key rename residue: the scene is exactly as before for the next boot retry')
})

test('key-rename success: preflight restores from plain-bak and moves the key aside (companion green)', () => {
  const ud = tmpUd()
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), SQLITE_HEADER)
  fs.writeFileSync(path.join(ud, 'db.key'), 'b'.repeat(64))
  const r = dbRecovery.preflightMigrateResidue(ud)
  assert.equal(r, true, 'the healthy path is unchanged')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db')), true, 'todos.db restored from plain-bak')
  assert.equal(fs.existsSync(path.join(ud, 'db.key')), false, 'the old key was moved aside')
  assert.equal(fs.readdirSync(ud).filter(f => f.startsWith('db.key.superseded-')).length, 1, 'the key landed at db.key.superseded-*')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db.plain-bak')), true, 'plain-bak survives (cleanup is not this function\'s job)')
})

test('no-residue scene: no todos.db, no plain-bak → preflight is a no-op false', () => {
  const ud = tmpUd()
  assert.equal(dbRecovery.preflightMigrateResidue(ud), false)
})
