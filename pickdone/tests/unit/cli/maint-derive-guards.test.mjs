/**
 * maint round (2026-09-28) — two CLI guards must be DERIVED, not hand-copied:
 *  1. restore-backup schemaV guard: the hand-written 6-segment literal missed tomatoRecords, so a
 *     schemaV=2 tomatoRecords segment passed the CLI's "Snapshot OK" while the App's restore
 *     (dbRecovery RESTORE_SEGMENTS registry, 7 segments) refused the dump. The guard now derives
 *     from RESTORE_SEGMENT_NAMES; this test proves a tomatoRecords-only future segment is refused.
 *  2. settings deny door: the 4-key SETTINGS_DENIED literal missed the manifest's machine-local
 *     keys, so `settings set enableSecurityLock false` was accepted and hot-synced into a running
 *     App (bypassing F-A1). The deny check now ALSO applies the shared
 *     isMachineLocalSettingKey predicate; check-command-bus.cjs asserts the derivation.
 * Run: node --test tests/unit/cli/maint-derive-guards.test.mjs
 */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-maint-derive-')
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require_ = createRequire(import.meta.url)
const db = require_(path.join(ROOT, 'src/main/db.js'))
db.init(process.env.TODO_DB_DIR)
const lib = require_(path.join(ROOT, 'cli/lib.js'))

const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCliFail = args => {
  try { execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return null } catch (e) {
    try { return JSON.parse(e.stderr || e.stdout) } catch { return { error: 'UNKNOWN', message: String(e.message) } }
  }
}

function dumpWith (segPatch) {
  return JSON.stringify({
    backup: {
      todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 't1', taskContent: '任务' }], recycleList: [] }),
      categoryState: JSON.stringify({ schemaV: 1, list: [] }),
      ...segPatch
    }
  })
}

test('derive-1: RESTORE_SEGMENT_NAMES is exported and covers tomatoRecords (7 segments)', () => {
  const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
  assert.ok(Array.isArray(dbRecovery.RESTORE_SEGMENT_NAMES), 'RESTORE_SEGMENT_NAMES exported from the registry module')
  assert.ok(dbRecovery.RESTORE_SEGMENT_NAMES.includes('tomatoRecords'), 'the registry names include tomatoRecords (the segment the old literal dropped)')
  assert.equal(dbRecovery.RESTORE_SEGMENT_NAMES.length, 7, 'registry-derived list matches the 7-segment restore surface')
})

test('derive-1 regression: a schemaV=2 tomatoRecords segment is refused with SNAPSHOT_FUTURE (was "Snapshot OK")', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'future-tomato.json')
  fs.writeFileSync(f, dumpWith({ tomatoRecords: JSON.stringify({ schemaV: 2, records: [] }) }))
  const r = runCliFail(['restore-backup', f, '--json'])
  assert.equal(r && r.error, 'SNAPSHOT_FUTURE', 'a future tomatoRecords segment must fail validation like every other registry segment')
  assert.match(r && r.message, /tomatoRecords\.schemaV=2/)
})

test('derive-1: a schemaV=1 tomatoRecords segment still validates OK (no over-blocking)', () => {
  const f = path.join(process.env.TODO_DB_DIR, 'ok-tomato.json')
  fs.writeFileSync(f, dumpWith({ tomatoRecords: JSON.stringify({ schemaV: 1, records: [] }) }))
  const out = JSON.parse(execFileSync(process.execPath, [cliPath, 'restore-backup', f, '--json'], { encoding: 'utf8' })).data
  assert.equal(out.todos, 1, 'v1 dump still validates with real counts')
})

test('derive-2 regression: `settings set enableSecurityLock` is DENIED_KEY (was accepted + hot-synced)', () => {
  let threw = null
  try { lib.settingsSet('enableSecurityLock', 'false') } catch (e) { threw = e }
  assert.ok(threw, 'the machine-local lock key must be rejected by the CLI')
  assert.equal(threw && threw.code, 'DENIED_KEY')
})

test('derive-2: every shared machine-local key is denied by the CLI settings door', () => {
  const shared = require_(path.join(ROOT, 'shared/machine-local-keys.mjs'))
  for (const key of shared.MACHINE_LOCAL_SETTING_KEYS) {
    assert.throws(() => lib.settingsSet(key, 'false'), e => e.code === 'DENIED_KEY', `settings set ${key} must be DENIED_KEY`)
  }
  assert.throws(() => lib.settingsSet('securityLockPassword', 'x'), e => e.code === 'DENIED_KEY', 'securityLock* family still denied')
  assert.throws(() => lib.settingsSet('_savedAt', '123'), e => e.code === 'DENIED_KEY', '_-stamped keys still denied')
})

test('derive-2: a normal setting is still settable (no over-blocking)', () => {
  const r = lib.settingsSet('showTagPanel', 'false')
  assert.equal(r.value, false)
})

test('derive-2 gate: check-command-bus.checkCliSettingsDeny passes on the current tree', () => {
  const bus = require_(path.join(ROOT, 'cli/check-command-bus.cjs'))
  const problems = []
  assert.equal(bus.checkCliSettingsDeny(m => problems.push(m)), true, 'gate must pass: ' + problems.join('; '))
})
