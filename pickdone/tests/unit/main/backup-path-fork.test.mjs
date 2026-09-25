/**
 * Regression test for the P0 backup-path-fork finding (2026-09-26).
 *
 * The disaster-recovery JSON write path moved to defaultBackupRootCandidates(ud)[0]
 * (<userData>/backups) in commit 539a9521, but dbRecovery.criticalBackupPath kept reading the
 * OLD derivation (parent-of-userData/pickdone-backups + legacy <userData>/critical-state-backup.json)
 * — so neither the startup recovery chain nor the read-critical-state-backup IPC could ever find
 * the snapshot written by writeCriticalStateBackupAtomic on a fresh install.
 *
 * The fix: the reader consumes the SAME single-source derivation (backup-roots.cjs), keeping the
 * legacy <userData> file as an extra fallback and reporting candidates[0] when nothing exists.
 *
 * Run: node --test tests/unit/main/backup-path-fork.test.mjs
 * Isolation: fresh temp dirs only (TODO_BACKUP_DIR is pinned empty for the duration).
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { criticalBackupPath } = (await import('../../../src/main/dbRecovery.cjs')).default ?? await import('../../../src/main/dbRecovery.cjs')
const { defaultBackupRootCandidates, migrateLegacyBackups } = await import('../../../src/main/backup-dirs.js')
const { defaultBackupRootCandidates: pureCandidates } = await import('../../../src/main/backup-roots.cjs')

let ud
let prevBackupDir

beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pickdone-path-fork-'))
  prevBackupDir = process.env.TODO_BACKUP_DIR
  delete process.env.TODO_BACKUP_DIR // test the default derivation, not an explicit override
})

afterEach(() => {
  if (prevBackupDir === undefined) delete process.env.TODO_BACKUP_DIR
  else process.env.TODO_BACKUP_DIR = prevBackupDir
  try { fs.rmSync(ud, { recursive: true, force: true }) } catch {}
})

test('backup-path-fork: a snapshot written to the ACTIVE default root (candidates[0]) is found by criticalBackupPath', () => {
  const candidates = pureCandidates(ud)
  assert.equal(candidates[0], path.join(ud, 'backups'))
  fs.mkdirSync(candidates[0], { recursive: true })
  const written = path.join(candidates[0], 'critical-state-backup.json')
  fs.writeFileSync(written, JSON.stringify({ backup: { todoState: '{}' } }))
  // The reader must resolve the WRITE location — on the pre-fix code this returned the legacy
  // parent-of-userData/pickdone-backups path, which does not exist here.
  assert.equal(criticalBackupPath(ud), written)
  assert.ok(fs.existsSync(criticalBackupPath(ud)))
})

test('backup-path-fork: derivation is single-source (dbRecovery consumes the shared pure module)', () => {
  assert.deepEqual(pureCandidates(ud), defaultBackupRootCandidates(ud))
})

test('backup-path-fork: legacy <userData>/critical-state-backup.json still works as an extra fallback', () => {
  const legacy = path.join(ud, 'critical-state-backup.json')
  fs.writeFileSync(legacy, JSON.stringify({ backup: { todoState: '{}' } }))
  assert.equal(criticalBackupPath(ud), legacy)
})

test('backup-path-fork: after migrateLegacyBackups moves a legacy-root snapshot, recovery finds it in the new root', () => {
  const [root, legacyRoot] = pureCandidates(ud)
  fs.mkdirSync(legacyRoot, { recursive: true })
  const snapName = 'auto-20260926-120000.json'
  fs.writeFileSync(path.join(legacyRoot, snapName), JSON.stringify({ backup: { todoState: '{}' } }))
  migrateLegacyBackups(legacyRoot, root) // defaultBackupRoot() runs this on every call
  assert.ok(fs.existsSync(path.join(root, snapName)), 'migration must move the snapshot into the active root')
  // Pre-fix the reader watched ONLY the legacy dir the migration just emptied → recovery blind.
  assert.equal(criticalBackupPath(ud), path.join(root, 'critical-state-backup.json'))
  const written = path.join(root, 'critical-state-backup.json')
  fs.writeFileSync(written, '{"backup":{}}')
  assert.equal(criticalBackupPath(ud), written)
})

test('backup-path-fork: with nothing on disk, criticalBackupPath reports the default WRITE location', () => {
  assert.equal(criticalBackupPath(ud), path.join(ud, 'backups', 'critical-state-backup.json'))
})
