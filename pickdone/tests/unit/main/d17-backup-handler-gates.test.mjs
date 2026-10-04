/**
 * D17 (2026-10-02) — backup handler gates.
 *
 * P2 write-critical-state-backup: renderer jsonText was written verbatim — empty/garbage
 * payloads poisoned the freshest disaster-recovery snapshot. Now gated on plausible JSON
 * (parses to a non-empty object; aligned with the reader's dbRecovery.backupJsonParseable bar).
 *
 * P2 list-auto-backups: a CONFIGURED external backup dir that vanished surfaced as a silent
 * {ok:true, files:[]}; only the never-configured default root is a benign empty state.
 *
 * Run: node --test tests/unit/main/d17-backup-handler-gates.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const Module = (await import('node:module')).default
// backup-dirs.js lazy-requires electron.app (userData path) — stub it for the whole file, same
// pattern as d10-backup-system-handlers.test.mjs.
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-ud-'))
const ELECTRON_STUB = { app: { getPath: () => TMP_USER_DATA, isPackaged: false } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })
const backup = require_(path.join(ROOT, 'src/main/handlers/backup.js'))

const GOOD_CRITICAL = JSON.stringify({ backup: { todoState: JSON.stringify([{ taskId: 't1' }]) }, schemaV: 1 })

function makeCtx () {
  const sender = { id: 1 }
  return {
    ctx: { isLocked: () => false, app: { getPath: () => os.tmpdir() }, getMainWindow: () => ({ webContents: sender }) },
    event: { sender },
  }
}

test('D17 P2: criticalJsonPlausible rejects empty / unparsable / non-object payloads', () => {
  assert.equal(backup.criticalJsonPlausible(''), false)
  assert.equal(backup.criticalJsonPlausible('   '), false)
  assert.equal(backup.criticalJsonPlausible('not json {{{'), false)
  assert.equal(backup.criticalJsonPlausible('null'), false)
  assert.equal(backup.criticalJsonPlausible('123'), false)
  assert.equal(backup.criticalJsonPlausible('"string"'), false)
  assert.equal(backup.criticalJsonPlausible('[]'), false)
  assert.equal(backup.criticalJsonPlausible('{}'), false, 'an empty object is trivial and carries no recovery payload')
  assert.equal(backup.criticalJsonPlausible(GOOD_CRITICAL), true, 'the real critical-state shape passes')
})

test('D17 P2: write-critical-state-backup refuses garbage with a coded error and keeps the previous snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-crit-'))
  const savedEnv = process.env.TODO_BACKUP_DIR
  process.env.TODO_BACKUP_DIR = root
  try {
    fs.writeFileSync(path.join(root, 'critical-state-backup.json'), GOOD_CRITICAL)
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    for (const garbage of ['', 'not json {{{', 'null']) {
      assert.throws(() => handlers['write-critical-state-backup'](event, garbage), (e) => {
        assert.equal(e.code, 'INVALID_BACKUP_JSON')
        return true
      }, 'red before the fix: garbage overwrote the freshest recovery snapshot')
    }
    assert.equal(fs.readFileSync(path.join(root, 'critical-state-backup.json'), 'utf8'), GOOD_CRITICAL,
      'the previous good snapshot is untouched by refused writes')
    assert.equal(handlers['write-critical-state-backup'](event, GOOD_CRITICAL), true, 'a plausible payload still writes')
  } finally {
    if (savedEnv === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = savedEnv
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('D17 P2: list-auto-backups — never-configured missing dir stays a benign empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-list-'))
  const savedEnv = process.env.TODO_BACKUP_DIR
  const dir = path.join(root, 'default-backups')
  process.env.TODO_BACKUP_DIR = dir
  const realReaddir = fs.readdirSync
  try {
    // resolveBackupDir mkdirSync's the default root; simulate the genuinely-missing state at the
    // readdir boundary (race / removal after resolve) — with NO explicit backupDir this stays the
    // historical benign empty state.
    fs.readdirSync = (p, ...a) => {
      if (String(p) === dir) { const e = new Error("ENOENT: no such file or directory, scandir '" + dir + "'"); e.code = 'ENOENT'; throw e }
      return realReaddir(p, ...a)
    }
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    const r = handlers['list-auto-backups'](event, undefined)
    assert.deepEqual({ ok: r.ok, missing: r.missing, files: r.files, error: r.error, configured: r.configured }, { ok: true, missing: true, files: [], error: undefined, configured: undefined })
  } finally {
    fs.readdirSync = realReaddir
    if (savedEnv === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = savedEnv
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('D17 P2: list-auto-backups — a configured dir that vanished surfaces a coded error state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd17-list-'))
  const savedEnv = process.env.TODO_BACKUP_DIR
  const dir = path.join(root, 'external-backups')
  process.env.TODO_BACKUP_DIR = dir // same as the fallback root: no whitelist round-trip needed
  const realReaddir = fs.readdirSync
  try {
    // resolveBackupDir mkdirSync's the resolved dir; simulate the "vanished after mount" state
    // (unplugged drive / deleted folder) at the readdir boundary.
    fs.readdirSync = (p, ...a) => {
      if (String(p) === dir) { const e = new Error("ENOENT: no such file or directory, scandir '" + dir + "'"); e.code = 'ENOENT'; throw e }
      return realReaddir(p, ...a)
    }
    const { ctx, event } = makeCtx()
    const handlers = backup(ctx)
    const configured = handlers['list-auto-backups'](event, dir)
    assert.equal(configured.ok, false, 'red before the fix: configured-but-missing returned silent ok:true')
    assert.equal(configured.configured, true)
    assert.equal(configured.missing, true)
    assert.match(configured.error, /does not exist/)
    assert.deepEqual(configured.files, [])
  } finally {
    fs.readdirSync = realReaddir
    if (savedEnv === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = savedEnv
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
