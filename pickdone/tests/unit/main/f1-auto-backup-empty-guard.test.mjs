/**
 * F1 (2026-10-17) — run-auto-backup empty-snapshot guard + reset-data deletion-list contract.
 *
 * P2 run-auto-backup: a renderer hydration failure that persists a blank in-memory store used to
 * land as the newest auto/evt snapshot — the restore entry in SettingsDataTab defaults to
 * selecting the newest point, so the "latest backup" became the poisoned empty one. Semantic
 * parity with the critical channel's destroy-guard: the empty dump is quarantined OUTSIDE the
 * ^(auto|evt)- restore namespace while the freshest good point is preserved.
 *
 * P2 reset-data: the deletion list used to miss recovery-pending.json and the critical-state
 * backup — after "reset data" the next boot's cleanInitReplayDecision replayed the JSON restore
 * and resurrected the just-destroyed data. (The handler itself is an inline dialog flow; this
 * pins the file-name contract against dbRecovery's own path derivation.)
 *
 * Run: node --test tests/unit/main/f1-auto-backup-empty-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')

// backup-dirs.js lazy-requires electron.app — stub it, same pattern as d17-backup-handler-gates.
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-autoud-'))
const ELECTRON_STUB = { app: { getPath: () => TMP_USER_DATA, isPackaged: false } }
const Module = (await import('node:module')).default
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backup = require_(path.join(ROOT, 'src/main/handlers/backup.js'))
const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))

/** Real renderer dump shape (todoBackup.buildBackupDump): nested JSON strings. */
const realDump = (n) => JSON.stringify({
  backup: { schemaV: 1, todoState: JSON.stringify({ schemaV: 1, todoList: Array.from({ length: n }, (_, i) => ({ taskId: 't' + i })), recycleList: [] }) }
})

function makeCtx () {
  const sender = { id: 1 }
  return {
    ctx: { isLocked: () => false, app: { getPath: () => os.tmpdir() }, getMainWindow: () => ({ webContents: sender }) },
    event: { sender }
  }
}

function withBackupDir (fn) {
  const saved = process.env.TODO_BACKUP_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-autobak-'))
  process.env.TODO_BACKUP_DIR = dir
  try { return fn(dir) } finally {
    if (saved === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

test('F1: run-auto-backup quarantines an EMPTY dump instead of making it the newest point', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    const good = realDump(3)
    const first = handlers['run-auto-backup'](event, good, { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(first.ok, true)
    const second = handlers['run-auto-backup'](event, realDump(0), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(second.ok, true)
    assert.equal(second.emptyQuarantined, true, 'red before the fix: the empty dump landed as a normal auto-*.json point')
    assert.ok(/^empty-quarantine-/.test(second.file), 'quarantined OUTSIDE the ^(auto|evt)- restore namespace')
    const autoFiles = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
    assert.equal(autoFiles.length, 1, 'no empty snapshot entered the restore namespace; the good point is preserved')
    assert.equal(fs.readFileSync(path.join(dir, autoFiles[0]), 'utf8'), good)
    assert.ok(fs.existsSync(path.join(dir, second.file)), 'the quarantined dump is kept for forensics')
    const listing = handlers['list-auto-backups'](event, undefined)
    assert.ok(!listing.files.some(f => f.startsWith('empty-quarantine-')), 'the restore entry never sees the quarantined file')
  })
})

test('F1: run-auto-backup — a cascade of empties (newest is also empty) writes normally', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    const r1 = handlers['run-auto-backup'](event, realDump(0), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r1.ok, true)
    const r2 = handlers['run-auto-backup'](event, realDump(0), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r2.ok, true)
    assert.ok(!r2.emptyQuarantined, 'nothing good left to protect — the empty point lands normally (critical-channel parity)')
  })
})

test('F1: run-auto-backup — a non-empty dump still writes normally past the guard', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    assert.equal(handlers['run-auto-backup'](event, realDump(2), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 }).ok, true)
    const r = handlers['run-auto-backup'](event, realDump(4), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r.ok, true)
    assert.ok(!r.emptyQuarantined)
    assert.ok(/^auto-/.test(r.file))
  })
})

test('F1: reset-data deletion list covers the replay sentinels (recovery-pending.json + critical-state backup)', () => {
  // F1 (2026-10-17): the destruction mechanism lives in reset-data-fs.cjs (extracted from the
  // index.js dialog flow for the size ratchet); index.js must still route to it.
  const resetFs = require_(path.join(ROOT, 'src/main/reset-data-fs.cjs'))
  assert.ok(resetFs.RESET_TARGET_FILES.includes('recovery-pending.json'), 'red before the fix: the sentinel survived reset and re-fed cleanInitReplayDecision')
  assert.ok(resetFs.RESET_TARGET_FILES.includes('critical-state-backup.json'), 'red before the fix: the legacy-location critical backup survived reset')
  assert.ok(resetFs.RESET_TARGET_FILES.includes('todos.db'), 'the original DB-file destruction list is preserved')
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')
  assert.ok(idxSrc.includes("deleteResetTargets(ud, ts,"), 'index.js reset-and-relaunch routes through deleteResetTargets')
  // the ACTIVE default-root copy (<userData>/backups/critical-state-backup.json — where the
  // replay actually reads it) is swept through dbRecovery.criticalBackupPath
  const resetSrc = fs.readFileSync(path.join(ROOT, 'src/main/reset-data-fs.cjs'), 'utf8')
  assert.ok(resetSrc.includes('dbRecovery.criticalBackupPath(ud)'), 'the active default-root critical backup is swept via criticalBackupPath')
  // name contract: the sentinel path dbRecovery derives is exactly the listed file name
  assert.ok(dbRecovery.recoveryPendingPath(os.tmpdir()).endsWith('recovery-pending.json'))
  assert.ok(path.basename(dbRecovery.criticalBackupPath(TMP_USER_DATA)) === 'critical-state-backup.json')
})

test('F1: cleanInitReplayDecision actually re-feeds from the swept locations (contract sanity)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-resetud-'))
  try {
    fs.mkdirSync(path.join(ud, 'backups'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'backups', 'critical-state-backup.json'), realDump(1))
    fs.writeFileSync(dbRecovery.recoveryPendingPath(ud), '{"reason":"json-restore-unconsumed","at":1}')
    const d = dbRecovery.cleanInitReplayDecision(ud)
    assert.equal(d.replay, true, 'this is exactly the state reset-data must destroy: sentinel + parseable backup')
    fs.rmSync(path.join(ud, 'backups', 'critical-state-backup.json'), { force: true })
    fs.rmSync(dbRecovery.recoveryPendingPath(ud), { force: true })
    assert.equal(dbRecovery.cleanInitReplayDecision(ud).replay, false, 'after the reset-data sweep the replay can no longer resurrect the data')
  } finally { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F1: deleteResetTargets actually destroys the sentinel + ACTIVE default-root critical backup', () => {
  const resetFs = require_(path.join(ROOT, 'src/main/reset-data-fs.cjs'))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-resetfs-'))
  try {
    fs.mkdirSync(path.join(ud, 'backups'), { recursive: true })
    const crit = path.join(ud, 'backups', 'critical-state-backup.json')
    fs.writeFileSync(crit, realDump(1))
    fs.writeFileSync(dbRecovery.recoveryPendingPath(ud), '{"reason":"x","at":1}')
    fs.writeFileSync(path.join(ud, 'todos.db'), 'SQLite format 3\x00')
    // seed the whole historical list so no absent-file ENOENT noise enters failures (behavior
    // preserved verbatim from the original inline loop)
    for (const f of ['todos.db-wal', 'todos.db-shm', 'db.key', 'todos.db.plain-bak']) {
      fs.writeFileSync(path.join(ud, f), 'x')
    }
    const failures = resetFs.deleteResetTargets(ud, Date.now())
    // behavior preserved verbatim from the original inline loop: a file ABSENT from userData
    // (unlink ENOENT → rename ENOENT) is reported as a failure entry
    assert.ok(failures.every(f => /ENOENT/.test(f)), 'failures are only absent-file ENOENT entries: ' + failures.join('; '))
    assert.ok(!fs.existsSync(crit), 'red before the fix: the ACTIVE default-root backup survived reset')
    assert.ok(!fs.existsSync(dbRecovery.recoveryPendingPath(ud)), 'the sentinel is destroyed')
    assert.ok(!fs.existsSync(path.join(ud, 'todos.db')), 'the DB file destruction behavior is preserved')
    // replay can no longer resurrect anything
    assert.equal(dbRecovery.cleanInitReplayDecision(ud).replay, false)
  } finally { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 }) }
})
