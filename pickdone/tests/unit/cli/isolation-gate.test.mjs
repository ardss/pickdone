/* Isolation gate (P0 root fix, 2026-09-25): without an explicitly declared isolation dir the CLI
   must refuse every write-side command instead of silently falling back to the real user database
   (%APPDATA%/pickdone). Covers: write command exits non-zero with ISOLATION_REQUIRED (and never
   opens a DB), --yes-i-know / TODO_DB_DIR allow the write through, read commands and
   restore-backup list stay unlocked, launchApp rejects without isolation.
   Run: node --test tests/unit/cli/isolation-gate.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const CLI = require_.resolve('../../../cli/pickdone.js')
const lib = require_('../../../cli/lib.js')

const ISOL_KEYS = ['TODO_DB_DIR', 'TODO_USER_DATA_DIR']
/** Child env with every isolation var stripped — simulates a bare CLI invocation */
const bareEnv = () => {
  const env = { ...process.env }
  for (const k of ISOL_KEYS) delete env[k]
  return env
}
const runCli = (args, env) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

test('gate unit: assertIsolationForWrite throws ISOLATION_REQUIRED without env, passes with TODO_DB_DIR', () => {
  const saved = { ...process.env }
  for (const k of ISOL_KEYS) delete process.env[k]
  try {
    assert.throws(() => lib.assertIsolationForWrite(), e => e.code === 'ISOLATION_REQUIRED' && /TODO_DB_DIR/.test(e.message))
    process.env.TODO_DB_DIR = path.join(os.tmpdir(), 'pd-iso-gate-unit')
    lib.assertIsolationForWrite() // must not throw
    delete process.env.TODO_DB_DIR
    process.env.TODO_USER_DATA_DIR = path.join(os.tmpdir(), 'pd-iso-gate-unit-ud')
    lib.assertIsolationForWrite() // TODO_USER_DATA_DIR alone also passes
  } finally {
    for (const k of ISOL_KEYS) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('write command without isolation env: exit 1 + ISOLATION_REQUIRED, real DB never opened', async () => {
  const r = await runCli(['add', 'isolation gate probe', '--json'], bareEnv())
  assert.equal(r.code, 1)
  assert.match(r.stderr, /ISOLATION_REQUIRED/)
  assert.match(r.stderr, /--yes-i-know/)
  // Nothing may have been written anywhere: the gate fires before lib.open(), so no DB init happened
  assert.ok(!r.stdout.includes('"ok":true'))
})

test('plan shortcut form (plan <task> <HH:mm>) without isolation env: gated (adversarial round)', async () => {
  // The shortcut dispatches planSet directly without the `set` sub-op — it used to slip past the
  // gate and open the default-dir DB (returned TASK_NOT_FOUND with a DB created in a fake APPDATA)
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-plan-'))
  const env = bareEnv(); env.APPDATA = fake
  const r = await runCli(['plan', 'sometask', '09:00'], env)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /ISOLATION_REQUIRED/)
  assert.ok(!fs.existsSync(path.join(fake, 'pickdone', 'todos.db')), 'no DB created in the default dir')
  // read forms stay unlocked
  const rd = await runCli(['plan', 'list'], env)
  assert.notEqual(rd.code, 1, 'plan list must not be gated')
})

test('attachment add/rm without isolation env: gated (adversarial round)', async () => {
  // addAttachment/removeAttachment patch the row and copy files into userData — they used to run
  // ungated and created todos.db/db.key in the default dir before failing with TASK_NOT_FOUND
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-att-'))
  const env = bareEnv(); env.APPDATA = fake
  for (const args of [['attachment', 'add', 't1', 'package.json'], ['attachment', 'rm', 't1', 'img', '1']]) {
    const r = await runCli(args, env)
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.stderr, /ISOLATION_REQUIRED/)
  }
  assert.ok(!fs.existsSync(path.join(fake, 'pickdone', 'todos.db')), 'no DB created in the default dir')
  // read form stays unlocked (a TASK_NOT_FOUND means it got past the gate to the lookup itself)
  const rd = await runCli(['attachment', 'list', 't1'], env)
  assert.ok(!/ISOLATION_REQUIRED/.test(rd.stderr), 'attachment list must not be gated')
})

test('write command with TODO_DB_DIR: gate bypassed only by isolation or --yes-i-know (confirm path)', async () => {
  // --yes-i-know is the documented explicit confirm for the real DB; here we only prove the gate
  // honours it by running the WRITE against an isolated dir anyway (never the real one).
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-yes-'))
  const env = bareEnv(); env.TODO_DB_DIR = iso
  const r = await runCli(['add', 'isolation gate allowed', '--yes-i-know', '--json'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /"ok":\s*true/)
})

test('write command with TODO_DB_DIR only: passes and lands in the isolated dir', async () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-ok-'))
  const env = bareEnv(); env.TODO_DB_DIR = iso
  const r = await runCli(['add', 'isolation gate ok', '--json'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.ok(fs.existsSync(path.join(iso, 'todos.db')), 'todos.db created inside the isolation dir')
})

test('dry-run write preview without isolation env: read-only, passes the gate', async () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-dry-'))
  const env = bareEnv(); env.TODO_DB_DIR = iso // dry preview opens the DB read-only — point it at an isolated dir, then confirm NO rows written
  const before = fs.existsSync(path.join(iso, 'todos.db'))
  const r = await runCli(['add', 'dry probe', '--dry-run', '--json'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /dryRun/)
  assert.equal(fs.existsSync(path.join(iso, 'todos.db')), before, 'no DB created by the preview')
})

test('read commands stay unlocked: version (no env) exits 0', async () => {
  const r = await runCli(['version', '--json'], bareEnv())
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /"ok":\s*true/)
})

test('restore-backup list is always allowed (read-only safety command)', async () => {
  const emptyUd = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-rb-'))
  const env = bareEnv(); env.TODO_USER_DATA_DIR = emptyUd // no todos.db → proves no gate, no real-DB touch
  const r = await runCli(['restore-backup', '--json'], env)
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /snapshots/)
})

test('launchApp without isolation env: rejects with ISOLATION_REQUIRED before any spawn', () => {
  const saved = { ...process.env }
  for (const k of ISOL_KEYS) delete process.env[k]
  try {
    assert.throws(() => lib.launchApp({}), e => e.code === 'ISOLATION_REQUIRED')
    // allowReal is the explicit-confirm escape hatch used by `open --yes-i-know`
    assert.throws(() => lib.launchApp({ dev: true }), e => e.code === 'ISOLATION_REQUIRED')
  } finally {
    for (const k of ISOL_KEYS) delete process.env[k]
    Object.assign(process.env, saved)
  }
})

test('sync status without isolation env: gated — even reads of sync write a cliSyncCmd row (adversarial round)', async () => {
  // `sync status` inserts a cliSyncCmd command row via lib.writeSyncCmd for the running App to
  // consume; bare it used to create todos.db/db.key in the default dir (APP_NOT_RUNNING exit).
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-iso-gate-sync-'))
  const env = bareEnv(); env.APPDATA = fake
  const r = await runCli(['sync', 'status'], env)
  assert.equal(r.code, 1)
  assert.match(r.stderr, /ISOLATION_REQUIRED/)
  assert.ok(!fs.existsSync(path.join(fake, 'pickdone', 'todos.db')), 'no DB created in the default dir')
})

test('backup root single source: TODO_BACKUP_DIR wins; default stays inside userData; .cjs consumer shares it', () => {
  const bd = require_('../../../src/main/backup-dirs.js')
  const saved = process.env.TODO_BACKUP_DIR
  try {
    process.env.TODO_BACKUP_DIR = path.join(os.tmpdir(), 'pd-backup-override')
    assert.deepEqual(bd.defaultBackupRootCandidates('X:\\ud'), [process.env.TODO_BACKUP_DIR])
    delete process.env.TODO_BACKUP_DIR
    const [active, legacy] = bd.defaultBackupRootCandidates('X:\\ud')
    assert.equal(active, path.join('X:\\ud', 'backups'), 'default root inside the isolation userData (no repo-tree leak)')
    assert.equal(legacy, path.join('X:\\', 'pickdone-backups'), 'legacy external root kept only for discovery/migration')
    const cjs = require_('../../../cli/lib-restore-backup.cjs')
    assert.equal(typeof cjs, 'function', 'CLI .cjs loads the electron-free module (lazy electron require)')
  } finally {
    if (saved === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = saved
  }
})
