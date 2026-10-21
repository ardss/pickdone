/* D1#7 — user-dir resolution order: TODO_DB_DIR > TODO_USER_DATA_DIR > boot redirect >
 * platform default. The boot branch is the B#1 CLI split-brain fix: after a data-location
 * migration the App boots into the redirect dir, and the CLI must follow it or it opens a
 * DIFFERENT database than the running App.
 * Run: node --test tests/unit/main/user-dir.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ud = require('../../../src/main/user-dir.js')
const dl = require('../../../src/main/data-location.cjs')

function sandbox (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'user-dir-' + tag + '-'))
}

/** Isolate BOTH the env chain and the boot file (os.homedir-derived) for the test's duration. */
function withCleanEnv (home, fn) {
  const old = { ...process.env }
  delete process.env.TODO_DB_DIR
  delete process.env.TODO_USER_DATA_DIR
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return fn() } finally { process.env.TODO_DB_DIR = old.TODO_DB_DIR; process.env.TODO_USER_DATA_DIR = old.TODO_USER_DATA_DIR; process.env.HOME = old.HOME; process.env.USERPROFILE = old.USERPROFILE }
}

test('TODO_DB_DIR wins over everything (legacy CLI override, unchanged)', () => {
  const home = sandbox('dbdir')
  withCleanEnv(home, () => {
    process.env.TODO_USER_DATA_DIR = path.join(home, 'udd')
    process.env.TODO_DB_DIR = path.join(home, 'dbdir')
    assert.equal(ud.userDataDir(), process.env.TODO_DB_DIR)
  })
})

test('TODO_USER_DATA_DIR beats the boot redirect (test isolation stays highest)', () => {
  const home = sandbox('udd')
  withCleanEnv(home, () => {
    const bootDir = path.join(home, 'boot-dir')
    fs.mkdirSync(bootDir)
    dl.writeBootRedirect(bootDir)
    process.env.TODO_USER_DATA_DIR = path.join(home, 'iso-ud')
    assert.equal(ud.userDataDir(), process.env.TODO_USER_DATA_DIR)
  })
})

test('no env + valid boot file → boot redirect dir (split-brain fix)', () => {
  const home = sandbox('boot')
  withCleanEnv(home, () => {
    const bootDir = path.join(home, 'relocated')
    fs.mkdirSync(bootDir)
    dl.writeBootRedirect(bootDir)
    assert.equal(ud.userDataDir(), bootDir)
    // corrupt boot file → fall through to the platform default, never brick resolution
    fs.writeFileSync(dl.bootRedirectPath(), '{bad json')
    assert.notEqual(ud.userDataDir(), null)
    assert.notEqual(ud.userDataDir(), bootDir)
  })
})

test('no env + no boot file → platform default (unchanged shape)', () => {
  const home = sandbox('def')
  withCleanEnv(home, () => {
    const d = ud.userDataDir()
    assert.ok(path.isAbsolute(d))
    assert.ok(d.endsWith('pickdone'), 'platform default still ends in pickdone: ' + d)
  })
})

test('hasIsolationEnv mirrors the two env vars (unchanged)', () => {
  const home = sandbox('iso')
  withCleanEnv(home, () => {
    assert.equal(ud.hasIsolationEnv(), false)
    process.env.TODO_USER_DATA_DIR = path.join(home, 'x')
    assert.equal(ud.hasIsolationEnv(), true)
  })
})
