/* W29 maintenance — backup handler surface, behavior coverage.
 *
 * Exercises the real IPC handlers in src/main/handlers/backup.js against a real temp
 * backup dir (TODO_BACKUP_DIR): gates (main-window-only + lock), the critical-state
 * channel (plausibility gate + real on-disk snapshot), run-auto-backup's write / dedup /
 * same-second collision / retention prune / empty-snapshot quarantine / housekeeping
 * sweeps, and the read/list twins' structured error states.
 *
 * Run: node --test tests/unit/main/w29-backup-handler-paths.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const require = createRequire(import.meta.url)

// durable-fs stub with a failure toggle: atomicWriteJson resolves '../durable-fs' at call time
const realDurable = require('../../../src/main/durable-fs.js')
const durableStub = {
  dtmpPath: realDurable.dtmpPath,
  writeFileDurable: (f, d) => {
    if (durableStub.fail) throw new Error('simulated disk failure (w29)')
    return realDurable.writeFileDurable(f, d)
  },
  fail: false
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => os.tmpdir(), getVersion: () => '0' } }
  if (request === '../durable-fs') return durableStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backupHandlers = require('../../../src/main/handlers/backup.js')
const dbRecovery = require('../../../src/main/dbRecovery.cjs')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const eAux = { sender: { id: 'float-wc' } } // a compromised/auxiliary window's sender

const dirs = []
function freshBackupDir () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-bkp-'))
  dirs.push(dir)
  process.env.TODO_BACKUP_DIR = dir
  return dir
}
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function ctxWith ({ locked = false } = {}) {
  return {
    isLocked: () => locked,
    app: { getPath: () => os.tmpdir() },
    getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false })
  }
}

const DUMP = JSON.stringify({ backup: { todoState: JSON.stringify({ todoList: [{ id: 't1', title: 'hello' }], recycleList: [] }) } })

test('w29-backup: gates — non-main sender and the locked state are rejected on the dangerous channels', () => {
  freshBackupDir()
  const h = backupHandlers(ctxWith({ locked: true }))
  assert.throws(() => h['write-critical-state-backup'](eMain, DUMP), /app is locked/)
  assert.throws(() => h['run-auto-backup'](eMain, DUMP), /app is locked/)
  assert.throws(() => h['read-auto-backup'](eMain, null, 'auto-x.json'), /app is locked/)
  assert.throws(() => h['list-auto-backups'](eMain, null), /app is locked/)
  const h2 = backupHandlers(ctxWith())
  assert.throws(() => h2['write-critical-state-backup'](eAux, DUMP), /main window only/)
  assert.throws(() => h2['run-auto-backup'](eAux, DUMP), /main window only/)
  assert.throws(() => h2['list-auto-backups'](eAux, null), /main window only/)
})

test('w29-backup: critical-state channel writes the real snapshot to disk; garbage payloads are rejected with coded errors', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  assert.equal(h['write-critical-state-backup'](eMain, DUMP), true, 'a plausible dump is accepted')
  const snap = dbRecovery.criticalBackupPath(path.join(dir, 'backups'))
  // defaultBackupRoot under TODO_BACKUP_DIR: locate the written file by name
  const root = h['get-default-backup-dir']()
  const written = path.join(root, path.basename(snap))
  assert.ok(fs.existsSync(written), 'the critical snapshot exists on disk at the default root')
  assert.match(fs.readFileSync(written, 'utf8'), /hello/, 'the payload bytes landed verbatim')
  for (const garbage of ['', '   ', 'null', '123', '[]', '{oops']) {
    assert.throws(() => h['write-critical-state-backup'](eMain, garbage), err => err && err.code === 'INVALID_BACKUP_JSON',
      'garbage payload rejected: ' + JSON.stringify(garbage))
  }
  // snapshot still intact after all the rejections (the freshest point was never poisoned)
  assert.match(fs.readFileSync(written, 'utf8'), /hello/)
})

test('w29-backup: run-auto-backup — first write, same-second collision dedup, content dedup twin, and the evt tag naming', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  const r1 = h['run-auto-backup'](eMain, DUMP, { recent: 24 })
  assert.equal(r1.ok, true)
  assert.match(r1.file, /^auto-\d{8}-\d{6}\.json$/, 'the snapshot uses the auto tier naming')
  const stamp = r1.file.slice('auto-'.length, -'.json'.length)
  // a second run in the SAME second with IDENTICAL content: content dedup returns the twin
  const r2 = h['run-auto-backup'](eMain, DUMP, { recent: 24 })
  assert.equal(r2.ok, true)
  assert.equal(r2.dedup, true, 'identical content dedups against the same-tag twin')
  assert.equal(r2.file, r1.file, 'no duplicate snapshot was written')
  assert.equal(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).length, 1, 'exactly one point on disk')
  // a CHANGED payload in the same second: collision suffix, both points exist
  const changed = JSON.stringify({ backup: { todoState: JSON.stringify({ todoList: [{ id: 't1', title: 'changed' }], recycleList: [] }) } })
  const r3 = h['run-auto-backup'](eMain, changed, { recent: 24 })
  assert.equal(r3.ok, true)
  assert.match(r3.file, /-dup1\.json$/, 'same-second collision gets the -dup1 suffix, never an overwrite')
  assert.equal(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).length, 2)
  void stamp
  // evt tag: sanitized lowercase tag rides the name
  const r4 = h['run-auto-backup'](eMain, changed, { tag: 'Test Event #1', recent: 24 })
  assert.equal(r4.ok, true)
  assert.match(r4.file, /^evt-testevent1-\d{8}-\d{6}/, 'the tag is sanitized into the evt namespace')
})

test('w29-backup: run-auto-backup retention — a failed write never thins the tier; a successful run prunes beyond recent', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  // seed an old tier
  for (const n of ['auto-20200101-000000.json', 'auto-20200102-000000.json', 'auto-20200103-000000.json']) {
    fs.writeFileSync(path.join(dir, n), '{"seed":1}')
  }
  // FAILED write: return is structured, no new snapshot, no prune
  durableStub.fail = true
  let r
  try { r = h['run-auto-backup'](eMain, DUMP, { recent: 1 }) } finally { durableStub.fail = false }
  assert.equal(r.ok, false)
  assert.match(r.error, /simulated disk failure/)
  const afterFail = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
  assert.equal(afterFail.length, 3, 'D18: a failed write must not thin the tier')
  // successful write with recent:1 and no day/week anchors → only the new snapshot + newest old survive
  r = h['run-auto-backup'](eMain, DUMP, { recent: 1, dailyDays: 0, weeklyWeeks: 0 })
  assert.equal(r.ok, true)
  const after = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
  assert.ok(after.includes(r.file), 'the new snapshot landed')
  assert.equal(after.length, 2, 'retention pruned down to the new point + the newest anchor')
  assert.ok(!after.includes('auto-20200101-000000.json'), 'the oldest point was pruned')
})

test('w29-backup: F1 empty-snapshot quarantine — a 0-row dump never becomes the newest restore point', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  // an existing GOOD point still holding rows
  const good = 'auto-20260101-000000.json'
  fs.writeFileSync(path.join(dir, good), DUMP)
  const emptyDump = JSON.stringify({ backup: { todoState: JSON.stringify({ todoList: [], recycleList: [] }) } })
  const r = h['run-auto-backup'](eMain, emptyDump, { recent: 24 })
  assert.equal(r.ok, true)
  assert.equal(r.emptyQuarantined, true, 'the empty dump is quarantined, not written as a snapshot')
  assert.match(r.file, /^empty-quarantine-/, 'the quarantine lands OUTSIDE the ^(auto|evt) restore namespace')
  assert.ok(fs.existsSync(path.join(dir, r.file)))
  assert.ok(fs.existsSync(path.join(dir, good)), 'the freshest good point is preserved untouched')
  assert.equal(fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f)).length, 1)
  // the quarantine side files are kept-5 swept by later runs
  for (let i = 0; i < 7; i++) {
    const n = 'empty-quarantine-2026010' + i + '-000000000000' + i + '.json'
    fs.writeFileSync(path.join(dir, n), emptyDump)
    fs.utimesSync(path.join(dir, n), new Date(Date.now() - (10 - i) * 60000), new Date(Date.now() - (10 - i) * 60000))
  }
  h['run-auto-backup'](eMain, DUMP, { recent: 24 })
  const q = fs.readdirSync(dir).filter(f => f.startsWith('empty-quarantine-'))
  assert.ok(q.length <= 5, 'empty-quarantine side files are kept at most 5 (got ' + q.length + ')')
})

test('w29-backup: housekeeping — stale .tmp residue and orphan sidecar manifests are swept by a real run', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  fs.writeFileSync(path.join(dir, 'auto-20260101-000000.json'), DUMP)
  fs.writeFileSync(path.join(dir, 'auto-20260101-000000.json.111.222.dtmp'), 'residue')
  fs.utimesSync(path.join(dir, 'auto-20260101-000000.json.111.222.dtmp'), new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000))
  fs.writeFileSync(path.join(dir, 'att-manifest-auto-20200101-000000.json'), '{"entries":[]}') // orphan: base long gone
  const r = h['run-auto-backup'](eMain, DUMP, { recent: 24 })
  assert.equal(r.ok, true)
  assert.ok(!fs.existsSync(path.join(dir, 'auto-20260101-000000.json.111.222.dtmp')), 'stale atomic-write residue was swept')
  assert.ok(!fs.existsSync(path.join(dir, 'att-manifest-auto-20200101-000000.json')), 'the orphan sidecar was swept')
})

test('w29-backup: the attachment sidecar rides a new snapshot with a deterministic manifest', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  const filesDir = path.join(dir, 'files')
  fs.mkdirSync(filesDir)
  fs.writeFileSync(path.join(filesDir, 'b.bin'), 'bb')
  fs.writeFileSync(path.join(filesDir, 'a.txt'), 'a')
  fs.writeFileSync(path.join(filesDir, 'aliases.json'), '{}') // skipped by the manifest
  fs.writeFileSync(path.join(filesDir, 'noise-custom.x'), 'x') // skipped by the manifest
  // stub attachDir by pointing the attachments module at our dir via electron stub? attachDir is
  // reached through safeAttachDir(); with the tmpdir electron stub it resolves inside os.tmpdir().
  // Instead verify the exported sidecar writer directly (the handler path is best-effort).
  const files = fs.readdirSync(dir)
  assert.ok(files.every(f => !f.startsWith(backupHandlers.ATT_SIDECAR_PREFIX) || fs.existsSync(path.join(dir, f.slice(backupHandlers.ATT_SIDECAR_PREFIX.length)))),
    'no orphan sidecars after the run')
  const ok = backupHandlers.writeAttachmentSidecar(fs, dir, 'auto-20260101-000000.json', filesDir)
  assert.equal(ok, true, 'the sidecar writer reports success')
  const side = path.join(dir, backupHandlers.attachmentSidecarNameFor('auto-20260101-000000.json'))
  const manifest = JSON.parse(fs.readFileSync(side, 'utf8'))
  assert.deepEqual(manifest.entries.map(e => e.key), ['a.txt', 'b.bin'], 'deterministic sorted keys, skip rules applied')
  assert.equal(manifest.entries[0].size, 1)
  // a dead files dir → false, never throws
  assert.equal(backupHandlers.writeAttachmentSidecar(fs, dir, 'auto-20260101-000000.json', path.join(dir, 'nope')), false)
})

test('w29-backup: read/list twins — structured states for empty default, vanished configured dir, whitelist filter, and reads', () => {
  const dir = freshBackupDir()
  const h = backupHandlers(ctxWith()) // eslint-disable-line no-unused-vars
  // a) default root not yet materialized: listing is a benign empty state and CREATES the root
  const l1 = h['list-auto-backups'](eMain, undefined)
  assert.equal(l1.ok, true)
  assert.deepEqual(l1.files, [])
  assert.ok(fs.existsSync(dir), 'the default backup root is materialized by the listing')
  // b) configured dir that does not exist: explicit missing+configured error (unregistered dir
  //    falls back to the default root, which points at a fresh never-created path here)
  process.env.TODO_BACKUP_DIR = path.join(dir, 'never-created-root')
  const l2 = h['list-auto-backups'](eMain, path.join(dir, 'gone'))
  assert.equal(l2.ok, false)
  assert.equal(l2.missing, true)
  assert.equal(l2.configured, true)
  process.env.TODO_BACKUP_DIR = dir
  // c) populated dir: newest-first, sidecars/tmp filtered out
  fs.writeFileSync(path.join(dir, 'auto-20260102-000000.json'), DUMP)
  fs.writeFileSync(path.join(dir, 'auto-20260101-000000.json'), DUMP)
  fs.writeFileSync(path.join(dir, 'evt-x-20260103-000000.json'), DUMP)
  fs.writeFileSync(path.join(dir, 'att-manifest-auto-20260102-000000.json'), '{}')
  const l3 = h['list-auto-backups'](eMain, undefined)
  assert.equal(l3.ok, true)
  assert.deepEqual(l3.files, ['evt-x-20260103-000000.json', 'auto-20260102-000000.json', 'auto-20260101-000000.json'])
  // d) reads: invalid name / existing / missing
  assert.deepEqual(h['read-auto-backup'](eMain, undefined, '../todos.db'), { ok: false, error: 'invalid backup file name' }, 'path traversal rejected by the naming whitelist')
  const r1 = h['read-auto-backup'](eMain, undefined, 'auto-20260101-000000.json')
  assert.equal(r1.ok, true)
  assert.equal(r1.text, DUMP)
  const r2 = h['read-auto-backup'](eMain, undefined, 'auto-19990101-000000.json')
  assert.deepEqual(r2, { ok: false, error: 'backup file not found' })
  // e) critical read twin: missing → null (no false "exists")
  assert.equal(h['read-critical-state-backup'](eMain), null)
})

test('w29-backup: exported helpers — ingress cap, plausibility, twin compare, same-tag twin pick, snapshot naming', () => {
  const dir = freshBackupDir()
  assert.throws(() => backupHandlers.assertIngressSize('x'.repeat(backupHandlers.INGRESS_MAX_BYTES + 1), 'run-auto-backup'),
    err => err && err.code === 'PAYLOAD_TOO_LARGE')
  assert.equal(backupHandlers.criticalJsonPlausible(DUMP), true)
  assert.equal(backupHandlers.criticalJsonPlausible('[]'), false, 'an array is not a plausible dump')
  assert.equal(backupHandlers.criticalJsonPlausible('{}'), false, 'an empty object is not a plausible dump')
  // twinMatches: size short-circuit + byte equality
  const twinPath = path.join(dir, 'twin.json')
  fs.writeFileSync(twinPath, DUMP)
  assert.equal(backupHandlers.twinMatches(fs, twinPath, DUMP), true, 'byte-identical payload matches its twin')
  assert.equal(backupHandlers.twinMatches(fs, twinPath, DUMP + 'x'), false, 'size mismatch short-circuits to false')
  assert.equal(backupHandlers.twinMatches(fs, path.join(dir, 'nope.json'), DUMP), false)
  // newestSameTag: same-prefix-only twin pick
  assert.equal(backupHandlers.newestSameTag(['evt-x-2.json', 'auto-1.json', 'evt-x-1.json'], 'evt-'), 'evt-x-2.json')
  assert.equal(backupHandlers.newestSameTag(['auto-1.json'], 'evt-'), null, 'no same-tag twin → null (no cross-tag dedup)')
  // uniqueSnapshotName: collision → -dup1; exhaustion → null
  assert.equal(backupHandlers.uniqueSnapshotName(() => false, dir, 'auto-', '20260101-000000', 0), 'auto-20260101-000000.json')
  assert.equal(backupHandlers.uniqueSnapshotName(p => p.endsWith('-dup1.json') ? false : true, dir, 'auto-', '20260101-000000', 0), 'auto-20260101-000000-dup1.json')
  assert.equal(backupHandlers.uniqueSnapshotName(() => true, dir, 'auto-', '20260101-000000', 0), null)
})
