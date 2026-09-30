/**
 * Sync-9/Fault-15 (D12 2026-10-01): run-auto-backup housekeeping order.
 *
 * The old order was: dedup early-return FIRST, stale .tmp sweep + GFS prune AFTER the write —
 * with two leaks:
 *   (a) a content-dedup hit returned before sweep/prune ran, so unchanged data meant the backup
 *       dir NEVER aged (GFS anchor rotation starved → unbounded growth);
 *   (b) the prune file list was tag-filtered (o.tag ? /^evt-/ : both), so an evt-tagged run
 *       never pruned the auto tier.
 * The fix runs sweep + prune BEFORE the dedup return, across BOTH tiers.
 *
 * Run: node --test tests/unit/main/d12-backup-prune-dedup.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

// electron stub (backup.js → dbRecovery/i18n/backup-dirs → electron.app.getPath)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-backup-'))
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backupHandlers = require('../../../src/main/handlers/backup.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const ctx = {
  isLocked: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
}

/** Fresh backup dir; resolveBackupDir(configured) rejects non-whitelisted dirs, so drive the
 *  default root through TODO_BACKUP_DIR (the same explicit-root door production uses). */
function freshBackupDir (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd12-backups-root-'))
  t._d12dir = dir
  process.env.TODO_BACKUP_DIR = dir
  return dir
}

test('Sync-9/Fault-15: a dedup hit still prunes — and prunes BOTH tiers', (t) => {
  const dir = freshBackupDir(t)
  const handlers = backupHandlers(ctx)
  // seed: 3 old auto snapshots + 3 old evt snapshots (over the tight retention below)
  for (const n of ['auto-20260901-100000.json', 'auto-20260902-100000.json', 'auto-20260903-100000.json',
    'evt-x-20260901-100000.json', 'evt-x-20260902-100000.json', 'evt-x-20260903-100000.json']) {
    fs.writeFileSync(path.join(dir, n), '{"seed":1}')
  }
  const twin = 'evt-x-20260903-100000.json'
  const same = fs.readFileSync(path.join(dir, twin), 'utf8')
  // tight retention: keep 1 auto + 1 evt
  const r = handlers['run-auto-backup'](eMain, same, { tag: 'x', recent: 1, dailyDays: 0, weeklyWeeks: 0, eventKeep: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.dedup, true, 'content dedup must still fire (twin survives)')
  const left = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).sort()
  assert.ok(left.includes(twin), 'the dedup twin (newest of its tag) survives')
  assert.ok(!left.includes('evt-x-20260901-100000.json'),
    'red before the fix: the dedup early-return skipped the evt prune entirely')
  assert.ok(!left.includes('auto-20260901-100000.json') && !left.includes('auto-20260902-100000.json'),
    'red before the fix: the tag-filtered file list left the auto tier unpruned on an evt run')
  assert.equal(left.filter(f => f.startsWith('auto-')).length, 1, 'auto tier ages down to recent=1')
})

test('Sync-9/Fault-15: stale .tmp residue is swept even on a dedup hit', (t) => {
  const dir = freshBackupDir(t)
  const handlers = backupHandlers(ctx)
  fs.writeFileSync(path.join(dir, 'auto-20260903-100000.json'), '{"seed":1}')
  const staleTmp = path.join(dir, '.tmp-auto-20260801-000000.json')
  fs.writeFileSync(staleTmp, 'torn')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  fs.utimesSync(staleTmp, old, old)
  const r = handlers['run-auto-backup'](eMain, '{"seed":1}', { recent: 4, dailyDays: 14, weeklyWeeks: 8 })
  assert.equal(r.ok, true)
  assert.equal(r.dedup, true)
  assert.equal(fs.existsSync(staleTmp), false,
    'red before the fix: the dedup early-return skipped the stale .tmp sweep')
})
