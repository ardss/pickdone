/**
 * F1 (2026-10-17) — backup/recovery domain fixes, regression tests.
 *
 * 1. P1 META_RESTORE_PREFIXES preserves sync.deviceId / sync.pairingSecret; the metaState
 *    importer routes those two keys to the settingsPut callback (settings_rows is the identity
 *    authority — lan-sync-bootstrap.settingGet reads settingsRowsAll; a meta-table put would be
 *    silently inert).
 * 2. P1 criticalBackupRowCount now counts the REAL renderer dump shape (todoState as a nested
 *    JSON string) — the counter used to answer 0 for every real dump, making both empty-snapshot
 *    destroy-guards (critical channel + run-auto-backup) silently inert.
 * 3. P2 plain-bak restore copy failure returns source:'error' instead of crashing startup.
 * 4. P2 startup JSON restore demotes dangling repeatIds (parity with SettingsDataTab.vue:544-552).
 *
 * Run: node --test tests/unit/main/f1-recovery-identity-empty-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const dbRecovery = require_(path.resolve(import.meta.dirname, '../../../src/main/dbRecovery.cjs'))

/** Real renderer dump shape (todoBackup.buildBackupDump): segments are NESTED JSON STRINGS. */
function realDump ({ todoList = [], recycleList = [], metaEntries = [] } = {}) {
  return JSON.stringify({
    backup: {
      schemaV: 1,
      todoState: JSON.stringify({ schemaV: 1, todoList, recycleList }),
      metaState: metaEntries.length ? JSON.stringify({ schemaV: 1, entries: metaEntries }) : undefined
    }
  })
}

test('F1-2: criticalBackupRowCount counts the REAL renderer dump shape (nested JSON string)', () => {
  const good = realDump({ todoList: [{ taskId: 'a' }], recycleList: [{ taskId: 'b' }] })
  assert.equal(dbRecovery.criticalBackupRowCount(good), 2, 'red before the fix: a nested-string todoState always counted 0')
  assert.equal(dbRecovery.criticalBackupRowCount(realDump()), 0, 'a genuinely empty dump still counts 0')
  assert.equal(dbRecovery.criticalBackupRowCount(realDump({ todoList: [{ taskId: 'a' }] })), 1)
  // legacy object shape still counts (back-compat)
  assert.equal(dbRecovery.criticalBackupRowCount(JSON.stringify({ backup: { todoState: { todoList: [{ taskId: 'x' }] } } })), 1)
  assert.equal(dbRecovery.criticalBackupRowCount('garbage {{{'), 0)
})

test('F1-2: writeCriticalStateBackupAtomic quarantines a real-shaped EMPTY dump and keeps the good one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-crit-'))
  try {
    const good = realDump({ todoList: [{ taskId: 'a' }] })
    assert.equal(dbRecovery.writeCriticalStateBackupAtomic(root, good), path.join(root, 'critical-state-backup.json'))
    const empty = realDump()
    const landed = dbRecovery.writeCriticalStateBackupAtomic(root, empty)
    assert.notEqual(landed, path.join(root, 'critical-state-backup.json'), 'red before the fix: the counter read 0 on BOTH sides, so the empty dump overwrote the good backup')
    assert.ok(/critical-state-backup\.empty-/.test(landed), 'the empty dump is quarantined to a side file')
    assert.equal(fs.readFileSync(path.join(root, 'critical-state-backup.json'), 'utf8'), good, 'the freshest good recovery source survives')
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F1-1: META_RESTORE_PREFIXES preserves sync.deviceId / sync.pairingSecret (identity survive a JSON restore)', () => {
  const wl = dbRecovery.META_RESTORE_PREFIXES
  assert.ok(wl.includes('sync.deviceId'), 'red before the fix: a JSON restore minted a fresh deviceId and broke every peer pairing/watermark')
  assert.ok(wl.includes('sync.pairingSecret'), 'pairing secret rides with the identity or peers cannot re-authenticate')
  // machine-local display name / local sync config must NOT cross the restore
  assert.ok(!wl.some(p => p.startsWith('sync.deviceName')), 'donor device name is machine-local branding, never restored')
})

test('F1-1: restoreMetaEntriesFromCriticalBackup routes identity keys to settingsPut, not metaPut', () => {
  const metaPuts = []
  const settingsPuts = []
  const raw = { backup: { metaState: JSON.stringify({ schemaV: 1, entries: [
    { key: 'sync.deviceId', value: 'dev-uuid-1' },
    { key: 'sync.pairingSecret', value: 'sekret' },
    { key: 'userTags', value: '["x"]' }
  ] }) } }
  const n = dbRecovery.restoreMetaEntriesFromCriticalBackup(raw, pair => metaPuts.push(pair), pair => settingsPuts.push(pair))
  assert.equal(n, 3)
  assert.deepEqual(metaPuts.map(p => p[0]), ['userTags'], 'identity keys must NOT land in the meta table (wrong table — inert)')
  assert.deepEqual(settingsPuts, [['sync.deviceId', 'dev-uuid-1'], ['sync.pairingSecret', 'sekret']])
})

test('F1-1: without settingsPut the identity keys are honestly skipped (no wrong-table write)', () => {
  const metaPuts = []
  const raw = { backup: { metaState: JSON.stringify({ schemaV: 1, entries: [{ key: 'sync.deviceId', value: 'dev' }] }) } }
  const n = dbRecovery.restoreMetaEntriesFromCriticalBackup(raw, pair => metaPuts.push(pair))
  assert.equal(n, 0)
  assert.equal(metaPuts.length, 0)
})

test('F1-3: a plain-bak copy failure surfaces source:"error" instead of crashing startup', () => {
  const durable = require_(path.resolve(import.meta.dirname, '../../../src/main/durable-fs'))
  const orig = durable.writeFileDurable
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-plain-'))
  try {
    // corrupt main db (no SQLite magic) + usable plain-bak + no JSON → plain-bak branch
    fs.writeFileSync(path.join(root, 'todos.db'), Buffer.alloc(100, 7))
    fs.writeFileSync(path.join(root, 'todos.db.plain-bak'), 'SQLite format 3\x00' + 'x'.repeat(84))
    durable.writeFileDurable = () => { throw new Error('ENOSPC: no space left on device') }
    const r = dbRecovery.attemptDbRecovery(root)
    assert.equal(r && r.source, 'error', 'red before the fix: the bare copyFileSync call propagated ENOSPC out of attemptDbRecovery and crashed startup')
    assert.ok(/plain-bak restore copy failed/.test(r.label), 'the error text reaches the recovery dialog')
    assert.ok(fs.existsSync(path.join(root, 'todos.db.plain-bak')), 'the backup is preserved for manual salvage')
  } finally {
    durable.writeFileDurable = orig
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('F1-4: startup JSON restore demotes rows with dangling repeatIds (parity with SettingsDataTab)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-demote-'))
  try {
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
    fs.writeFileSync(path.join(root, 'backups', 'critical-state-backup.json'), realDump({
      todoList: [{ taskId: 't1', repeatId: 'r1' }, { taskId: 't2', repeatId: 'r9' }],
      metaEntries: [{ key: 'repeatRule:r1', value: '{"id":"r1"}' }]
    }))
    const upserts = []
    const report = dbRecovery.restoreSegmentsFromCriticalBackup(root, list => upserts.push(...list))
    assert.equal(report.tasks, 2)
    const t1 = upserts.find(t => t.taskId === 't1')
    const t2 = upserts.find(t => t.taskId === 't2')
    assert.equal(t1.repeatId, 'r1', 'a repeatId backed by a repeatRule in the same backup is kept')
    assert.equal(t2.repeatId, null, 'red before the fix: the startup path imported a dangling repeatId (UI path already demoted)')
    assert.equal(report.imported, 2, 'demotion does not zero out the import count (proved gate must stay reachable)')
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F1-4: no metaState segment in the backup → demotion conservatively skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-demote2-'))
  try {
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
    fs.writeFileSync(path.join(root, 'backups', 'critical-state-backup.json'), realDump({
      todoList: [{ taskId: 't1', repeatId: 'r1' }]
    }))
    const upserts = []
    dbRecovery.restoreSegmentsFromCriticalBackup(root, list => upserts.push(...list))
    assert.equal(upserts[0].repeatId, 'r1', 'an old backup without meta state must not lose its repeat rules')
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})
