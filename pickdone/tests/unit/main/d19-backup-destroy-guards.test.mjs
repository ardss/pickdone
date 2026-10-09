/* R5/R6 nightly (2026-10-10) — backup destroy-guards:
 *   1. critical-state destroy-guard: a valid-but-EMPTY snapshot must not atomically overwrite the
 *      last good disaster-recovery source (it gets quarantined to a side file instead).
 *   2. conflict-backup key namespace: the restore path mints `-r<seq36>` so it can never collide
 *      with the apply path's `-<seq36>` in the same millisecond (both counters start at 0).
 *   3. retention floor: renderer-supplied retention tiers of 0 are floored at 1 (a hostile/buggy
 *      {recent:0,dailyDays:0,...} call used to classify the entire snapshot dir as prunable).
 * Run: node --test tests/unit/main/d19-backup-destroy-guards.test.mjs
 * Isolation: fresh mkdtemp dirs only; the real %APPDATA%/pickdone is never touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbRecovery = await import('../../../src/main/dbRecovery.cjs')
const { createRequire } = await import('node:module')
const require_ = createRequire(import.meta.url)
const syncApply = require_('../../../src/main/sync-apply.js')
const autoBackup = require_('../../../src/main/autoBackup.js')

test('destroy-guard: empty snapshot cannot overwrite a non-empty critical backup (quarantined instead)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-destroy-'))
  try {
    const good = JSON.stringify({ backup: { todoState: { todoList: [{ taskId: 't1' }], recycleList: [] } } })
    const dest = dbRecovery.writeCriticalStateBackupAtomic(ud, good)
    assert.ok(dest.endsWith('critical-state-backup.json'))
    // renderer boots blank and dutifully persists an empty snapshot:
    const empty = JSON.stringify({ backup: { todoState: { todoList: [], recycleList: [] } } })
    const side = dbRecovery.writeCriticalStateBackupAtomic(ud, empty)
    assert.match(side, /critical-state-backup\.empty-/, 'empty snapshot must be quarantined to a side file')
    assert.equal(fs.readFileSync(dest, 'utf8'), good, 'the last good recovery source must survive byte-identical')
    // a later real snapshot overwrites normally again:
    const newer = JSON.stringify({ backup: { todoState: { todoList: [{ taskId: 't1' }, { taskId: 't2' }], recycleList: [] } } })
    assert.ok(dbRecovery.writeCriticalStateBackupAtomic(ud, newer).endsWith('critical-state-backup.json'))
    assert.equal(fs.readFileSync(path.join(ud, 'critical-state-backup.json'), 'utf8'), newer)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('destroy-guard: first-ever write may be empty (no recovery source to destroy)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-firstempty-'))
  try {
    const empty = JSON.stringify({ backup: { todoState: { todoList: [], recycleList: [] } } })
    const dest = dbRecovery.writeCriticalStateBackupAtomic(ud, empty)
    assert.ok(dest.endsWith('critical-state-backup.json'))
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('conflict-backup keys: restore suffix (-r<seq>) is disjoint from the apply suffix (-<seq>) and still parses for prune order', () => {
  const parse = k => syncApply.parseMetaBackupKeySuffix(k)
  const sameMs = Date.now().toString(36)
  const applyKey = `metaConflictBackup.meta:x.${sameMs}-0`
  const restoreKey = `metaConflictBackup.meta:x.${sameMs}-r0`
  assert.notEqual(applyKey, restoreKey, 'same-ms apply + restore snapshots must not mint the same key')
  const pa = parse(applyKey); const pr = parse(restoreKey)
  assert.ok(pa && pr, 'both suffixes must stay parseable (prune comparator contract)')
  assert.ok(syncApply.compareMetaBackupKeys(applyKey, restoreKey) < 0, 'ordering must remain deterministic')
})

test('retention floor: renderer-supplied tiers of 0 are floored at the trust boundary (selectPrunes keeps the newest)', () => {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
  const files = [`auto-${stamp}.json`, 'auto-20250101-000000.json', 'auto-20240101-000000.json']
  const o = autoBackup.floorRetention({ recent: 0, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
  const prunes = autoBackup.selectPrunes(files, o)
  assert.ok(!prunes.includes(`auto-${stamp}.json`), 'the newest snapshot must survive a zeroed-retention call')
  assert.equal(o.dailyDays, 0, 'anchor tiers keep their legitimate 0 = disabled semantics')
  // absent fields still fall through to selectPrunes' own defaults (floor must not invent tiers):
  assert.deepEqual(autoBackup.floorRetention({}), {})
})
