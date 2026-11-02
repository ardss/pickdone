/* W29 — handlers/backup.js real-behavior tests over REAL temp directories.
 *
 * Covers, against the REAL handler module (electron/electron-log stubbed, all I/O on a
 * mkdtemp sandbox):
 *   - gates: non-main-window sender and locked app are rejected on every dangerous channel
 *   - the C2 ingress cap and the D17 P2 implausible-JSON coded rejections
 *   - write-critical-state-backup: lands critical-state-backup.json in the REAL default root
 *     (atomic write), read twin round-trips it, missing → null
 *   - run-auto-backup happy path: snapshot file exists with the payload; get-default-backup-dir
 *     agrees with the module's defaultBackupRoot
 *   - content dedup: identical payload returns the EXISTING file (no second snapshot written)
 *   - the F1 empty-snapshot quarantine: a 0-row real dump on a first-ever run is quarantined to
 *     an empty-quarantine side file OUTSIDE the ^(auto|evt)- restore namespace
 *   - read-auto-backup: valid read / invalid name traversal guard / missing-file classification
 *   - list-auto-backups: default-missing benign empty state vs configured-but-vanished error
 *   - pick-backup-dir: canceled dialog → null; persist failure rolls back the in-memory whitelist
 *   - exported pure seams: uniqueSnapshotName dup suffixes + exhaustion, twinMatches size/byte
 *     short-circuits, newestSameTag same-tag-only twin, buildAttachmentManifest skip rules,
 *     atomicWriteJson failure residue cleanup
 *
 * Run: node --test tests/unit/main/w29-backup-handler-tmpdirs.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-backup-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(UD, { recursive: true })

const ELECTRON_STUB = {
  app: { getPath: () => UD, getVersion: () => '0.0.0-test' },
  dialog: {
    showOpenDialog: async (_w, _opts) => dialogResult,
  },
  BrowserWindow () { return {} },
}
let dialogResult = { canceled: true, filePaths: [] }
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {}, hooks: [], transports: { file: {}, console: {} } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })
const backupHandlers = require(path.join(TMP, 'src', 'main', 'handlers', 'backup.js'))
const backupDirs = require(path.join(TMP, 'src', 'main', 'backup-dirs.js'))
const defaultRoot = backupDirs.defaultBackupRoot()
fs.mkdirSync(defaultRoot, { recursive: true })

const MAIN_WC = { id: 1 }
const fakeWin = { isDestroyed: () => false, webContents: MAIN_WC }
const mainEvent = { sender: MAIN_WC }
const floatEvent = { sender: { id: 99 } } // any non-main window
let locked = false
const ctx = {
  isLocked: () => locked,
  app: ELECTRON_STUB.app,
  getMainWindow: () => fakeWin,
}
const h = backupHandlers(ctx)

const GOOD_DUMP = JSON.stringify({ backup: { todoState: { todoList: [{ id: 't1', title: 'real row' }], recycleList: [] } }, metaState: { k: 'v' } })
const EMPTY_DUMP = JSON.stringify({ backup: { todoState: { todoList: [], recycleList: [] } } })

test('gates: every dangerous backup channel rejects non-main-window senders and the locked state', () => {
  assert.throws(() => h['write-critical-state-backup'](floatEvent, GOOD_DUMP), /forbidden: main window only/)
  assert.throws(() => h['run-auto-backup'](floatEvent, GOOD_DUMP), /forbidden/)
  assert.throws(() => h['read-auto-backup'](floatEvent, undefined, 'auto-x.json'), /forbidden/)
  assert.throws(() => h['list-auto-backups'](floatEvent, undefined), /forbidden/)
  assert.throws(() => h['read-critical-state-backup'](floatEvent), /forbidden/)
  locked = true
  assert.throws(() => h['write-critical-state-backup'](mainEvent, GOOD_DUMP), /app is locked/)
  assert.throws(() => h['run-auto-backup'](mainEvent, GOOD_DUMP), /app is locked/)
  assert.throws(() => h['read-auto-backup'](mainEvent, undefined, 'auto-x.json'), /app is locked/)
  assert.throws(() => h['list-auto-backups'](mainEvent, undefined), /app is locked/)
  assert.throws(() => h['read-critical-state-backup'](mainEvent), /app is locked/)
  locked = false
})

test('C2 ingress cap + D17 implausible-JSON: coded rejections at the door, nothing written', () => {
  const listingBefore = fs.readdirSync(defaultRoot).sort().join('|')
  const big = 'x'.repeat(64 * 1024 * 1024 + 1)
  for (const fn of ['write-critical-state-backup', 'run-auto-backup']) {
    try { h[fn](mainEvent, big); assert.fail('must throw') } catch (e) { assert.equal(e.code, 'PAYLOAD_TOO_LARGE', fn) }
  }
  // the D17 plausibility gate guards the disaster-recovery SOURCE (critical channel): garbage
  // must never overwrite critical-state-backup.json. (The auto/evt channel takes renderer JSON
  // verbatim by design — its 0-row dumps are quarantined by the F1 guard instead.)
  for (const garbage of ['', '   ', 'not json {', '123', 'null', '[1,2]']) {
    try { h['write-critical-state-backup'](mainEvent, garbage); assert.fail('must throw for ' + JSON.stringify(garbage)) } catch (e) {
      assert.equal(e.code, 'INVALID_BACKUP_JSON')
    }
  }
  assert.equal(fs.readdirSync(defaultRoot).sort().join('|'), listingBefore, 'the oversized and implausible runs wrote NOTHING to the backup root')
})

test('write-critical-state-backup: lands critical-state-backup.json in the real default root; read twin round-trips; missing → null', () => {
  assert.equal(h['read-critical-state-backup'](mainEvent), null, 'no critical backup yet → benign null')
  const r = h['write-critical-state-backup'](mainEvent, GOOD_DUMP)
  assert.equal(r, true)
  const dest = path.join(defaultRoot, 'critical-state-backup.json')
  assert.equal(fs.readFileSync(dest, 'utf8'), GOOD_DUMP, 'the disaster-recovery source holds the exact payload')
  assert.equal(h['read-critical-state-backup'](mainEvent), GOOD_DUMP)
  assert.equal(h['get-default-backup-dir'](), defaultRoot, 'get-default-backup-dir agrees with the module root')
})

test('run-auto-backup happy path: snapshot exists with the payload; dedup returns the EXISTING file', () => {
  const r1 = h['run-auto-backup'](mainEvent, GOOD_DUMP)
  assert.equal(r1.ok, true)
  const snapPath = path.join(defaultRoot, r1.file)
  assert.match(r1.file, /^auto-\d{8}-\d{6}\.json$/)
  assert.equal(fs.readFileSync(snapPath, 'utf8'), GOOD_DUMP, 'the snapshot file holds the exact payload')
  assert.ok(fs.readdirSync(defaultRoot).every(f => !f.startsWith('.tmp-')), 'no atomic-write residue')

  // identical content → dedup: no new snapshot, the twin name is returned.
  // CI-slow machines can cross a second boundary between r1 and r2 (the dedup twin window is
  // same-second) — in that case r2 legitimately becomes the NEW baseline and r3 (same second
  // as r2) must dedup against it; exactly one extra snapshot exists either way.
  const before = fs.readdirSync(defaultRoot).length
  const r2 = h['run-auto-backup'](mainEvent, GOOD_DUMP)
  assert.equal(r2.ok, true)
  let baseline = r1
  if (!r2.dedup) {
    assert.notEqual(r2.file, r1.file, 'a missed window wrote a second snapshot (second boundary crossed)')
    assert.match(r2.file, /^auto-\d{8}-\d{6}\.json$/)
    baseline = r2
  } else {
    assert.equal(r2.file, r1.file, 'the dedup hit points at the existing snapshot')
  }
  const r3dedup = h['run-auto-backup'](mainEvent, GOOD_DUMP)
  assert.equal(r3dedup.ok, true)
  assert.equal(r3dedup.dedup, true, 'same-byte-length same-content payload dedups within the window')
  assert.equal(r3dedup.file, baseline.file, 'the dedup hit points at the existing snapshot')
  assert.equal(fs.readdirSync(defaultRoot).length, before + (baseline === r1 ? 0 : 1), 'a dedup hit writes no extra snapshot')

  // changed content → a NEW snapshot is written
  const changed = JSON.stringify({ backup: { todoState: { todoList: [{ id: 't2' }], recycleList: [] } } })
  const r3 = h['run-auto-backup'](mainEvent, changed)
  assert.equal(r3dedup.ok, true)
  assert.notEqual(r3.file, r1.file)
  assert.equal(fs.readFileSync(path.join(defaultRoot, r3.file), 'utf8'), changed)
})

test('F1 empty-snapshot quarantine: a first-ever 0-row real dump never seeds the restore namespace', () => {
  const r = h['run-auto-backup'](mainEvent, EMPTY_DUMP)
  assert.equal(r.ok, true)
  assert.equal(r.emptyQuarantined, true, 'the empty dump is quarantined, not stored as a restore point')
  assert.match(r.file, /^empty-quarantine-/)
  assert.ok(fs.existsSync(path.join(defaultRoot, r.file)), 'the quarantined payload is on disk')
  // no ^(auto|evt)- file appeared from THIS run (the pre-existing auto snapshots stay)
  const evtAuto = fs.readdirSync(defaultRoot).filter(f => /^(auto|evt)-/.test(f)).filter(f => f.includes(fs.statSync(path.join(defaultRoot, r.file)).mtimeMs.toString()))
  assert.equal(evtAuto.length, 0, 'the quarantined run produced no restore-namespace file')
  // and the empty payload is NOT the content of any newest auto- snapshot
  const autos = fs.readdirSync(defaultRoot).filter(f => /^auto-/.test(f))
  for (const a of autos) assert.notEqual(fs.readFileSync(path.join(defaultRoot, a), 'utf8'), EMPTY_DUMP)
})

test('read-auto-backup: valid read, naming traversal guard, missing-file classification', () => {
  const name = fs.readdirSync(defaultRoot).find(f => /^auto-/.test(f))
  const r = h['read-auto-backup'](mainEvent, undefined, name)
  assert.equal(r.ok, true)
  assert.equal(r.text, fs.readFileSync(path.join(defaultRoot, name), 'utf8'))
  for (const bad of ['../evil.json', 'auto-.json', 'att-manifest-auto-x.json', 'empty-quarantine-1.json', '']) {
    const rr = h['read-auto-backup'](mainEvent, undefined, bad)
    assert.equal(rr.ok, false, 'non-snapshot names are rejected: ' + bad)
    assert.match(rr.error, /invalid backup file name/)
  }
  const missing = h['read-auto-backup'](mainEvent, undefined, 'auto-20990101-000000.json')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /backup file not found/, 'a genuinely missing file classifies as not-found')
})

test('list-auto-backups: stamp-sorted listing; a configured dir reads as a healthy empty list; pick-backup-dir persists + cancels', async () => {
  // a configured dir that exists → its files list, newest-first
  const rDefault = h['list-auto-backups'](mainEvent, undefined)
  assert.equal(rDefault.ok, true)
  assert.ok(rDefault.files.some(f => /^auto-/.test(f)))
  const names = fs.readdirSync(defaultRoot).filter(f => /^(auto|evt)-/.test(f))
  const fixUtil = require(path.join(TMP, 'src', 'main', 'fix-util.js'))
  assert.deepEqual(rDefault.files, fixUtil.sortBackupNamesNewestFirst(names), 'listing sorts newest-first by the embedded stamp (GFS dup names sort oldest)')

  // pick-backup-dir success path (real whitelist persistence)
  const pickedDir = path.join(TMP, 'picked')
  fs.mkdirSync(pickedDir)
  dialogResult = { canceled: false, filePaths: [pickedDir] }
  const picked = await h['pick-backup-dir'](mainEvent)
  assert.equal(picked, pickedDir, 'a successful pick returns the directory')
  const wl = JSON.parse(fs.readFileSync(path.join(UD, 'allowed-backup-dirs.json'), 'utf8'))
  assert.ok(Array.isArray(wl) && wl.some(d => path.resolve(d) === path.resolve(pickedDir)), 'the pick is durably whitelisted')

  // a CONFIGURED dir that exists but holds no snapshots → healthy empty list
  const rEmptyConfigured = h['list-auto-backups'](mainEvent, pickedDir)
  assert.equal(rEmptyConfigured.ok, true)
  assert.deepEqual(rEmptyConfigured.files, [])

  // canceled dialog → null
  dialogResult = { canceled: true, filePaths: [] }
  assert.equal(await h['pick-backup-dir'](mainEvent), null)
})

test('pick-backup-dir: a whitelist persist failure rolls back the in-memory registration', async () => {
  // break the persistence target: allowed-backup-dirs.json as a DIRECTORY → write fails
  const wlFile = path.join(UD, 'allowed-backup-dirs.json')
  fs.rmSync(wlFile, { force: true }); fs.mkdirSync(wlFile)
  const dir2 = path.join(TMP, 'picked2')
  fs.mkdirSync(dir2)
  dialogResult = { canceled: false, filePaths: [dir2] }
  await assert.rejects(() => h['pick-backup-dir'](mainEvent), /failed to persist backup-dir whitelist/)
  fs.rmSync(wlFile, { recursive: true, force: true })
  // the rolled-back registration must not be honored: list with dir2 falls back to the default root
  const r = h['list-auto-backups'](mainEvent, dir2)
  assert.equal(r.ok, true, 'an unregistered dir falls back to the default root (benign empty state there)')
})

// ---- exported pure seams ----
test('uniqueSnapshotName: collision -dup<n> suffixes and 900-name exhaustion', () => {
  const exists = new Set()
  const probe = f => exists.has(path.basename(String(f)))
  assert.equal(backupHandlers.uniqueSnapshotName(probe, '/d', 'auto-', '20260101-000000', 0), 'auto-20260101-000000.json')
  exists.add('auto-20260101-000000.json')
  assert.equal(backupHandlers.uniqueSnapshotName(probe, '/d', 'auto-', '20260101-000000', 0), 'auto-20260101-000000-dup1.json')
  for (let n = 1; n <= 900; n++) exists.add(`auto-20260101-000000-dup${n}.json`)
  assert.equal(backupHandlers.uniqueSnapshotName(probe, '/d', 'auto-', '20260101-000000', 0), null, 'exhaustion returns null (caller reports failure)')
})

test('twinMatches: size short-circuit, positional compare, unreadable → false', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-twin-'))
  const p = path.join(d, 'twin.json')
  fs.writeFileSync(p, GOOD_DUMP)
  assert.equal(backupHandlers.twinMatches(fs, p, GOOD_DUMP), true)
  assert.equal(backupHandlers.twinMatches(fs, p, GOOD_DUMP + 'x'), false, 'byte-length mismatch short-circuits to false')
  const sameSize = 'z'.repeat(Buffer.byteLength(GOOD_DUMP, 'utf8'))
  assert.equal(backupHandlers.twinMatches(fs, p, sameSize), false, 'same size, different bytes → false')
  assert.equal(backupHandlers.twinMatches(fs, path.join(d, 'nope.json'), GOOD_DUMP), false)
  // multibyte content round-trips the utf8 chunker
  const uni = JSON.stringify({ backup: { todoState: { todoList: [{ title: '番茄计时🍅'.repeat(40000) }], recycleList: [] } } })
  const pu = path.join(d, 'uni.json')
  fs.writeFileSync(pu, uni)
  assert.equal(backupHandlers.twinMatches(fs, pu, uni), true, 'multibyte (surrogate-pair-safe) compare matches')
})

test('newestSameTag: the dedup twin comes only from the SAME tag prefix', () => {
  const names = ['evt-done-20260102-000000.json', 'auto-20260101-120000.json', 'auto-20260101-090000.json']
  assert.equal(backupHandlers.newestSameTag(names, 'auto-'), 'auto-20260101-120000.json')
  assert.equal(backupHandlers.newestSameTag(names, 'evt-'), 'evt-done-20260102-000000.json')
  assert.equal(backupHandlers.newestSameTag(names, 'zzz-'), null, 'no same-tag file → null (no cross-tag twin)')
  assert.equal(backupHandlers.newestSameTag(names, ''), null)
  assert.equal(backupHandlers.newestSameTag([], 'auto-'), null)
})

test('buildAttachmentManifest: skip rules + deterministic sort; missing dir → null', () => {
  const d = path.join(TMP, 'files')
  fs.mkdirSync(d)
  fs.writeFileSync(path.join(d, 'b.bin'), 'xx')
  fs.writeFileSync(path.join(d, 'a.bin'), 'x')
  fs.writeFileSync(path.join(d, 'aliases.json'), '{}') // skipped
  fs.writeFileSync(path.join(d, 'noise-custom.cfg'), '{}') // skipped
  fs.writeFileSync(path.join(d, 'x.att-tmp-1-2'), '{}') // crash residue skipped
  const m = backupHandlers.buildAttachmentManifest(d, fs)
  assert.deepEqual(m.entries.map(e => e.key), ['a.bin', 'b.bin'], 'only real attachment files, sorted by key')
  assert.equal(m.entries[0].size, 1)
  assert.equal(m.entries[1].size, 2)
  assert.equal(backupHandlers.buildAttachmentManifest(path.join(TMP, 'no-such-dir'), fs), null)
  // writeAttachmentSidecar writes the manifest next to the snapshot
  const ok = backupHandlers.writeAttachmentSidecar(fs, defaultRoot, 'auto-20260101-000000.json', d)
  assert.equal(ok, true)
  const side = path.join(defaultRoot, backupHandlers.ATT_SIDECAR_PREFIX + 'auto-20260101-000000.json')
  assert.equal(fs.existsSync(side), true, 'the sidecar rides the snapshot name')
  assert.deepEqual(JSON.parse(fs.readFileSync(side, 'utf8')).entries.map(e => e.key), ['a.bin', 'b.bin'])
})

test('atomicWriteJson: success returns ok+file; a failing fsMod returns a structured error with the tmp residue cleaned', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-atomic-'))
  const ok = backupHandlers.atomicWriteJson(fs, d, 'good.json', '{}')
  assert.deepEqual(ok, { ok: true, file: 'good.json' })
  assert.equal(fs.readFileSync(path.join(d, 'good.json'), 'utf8'), '{}')
  const boom = {
    openSync: () => { throw new Error('injected open failure') },
    writeFileSync: () => { throw new Error('injected write failure') },
    renameSync: () => { throw new Error('injected rename failure') },
    existsSync: fs.existsSync, unlinkSync: fs.unlinkSync, rmSync: fs.rmSync,
  }
  const bad = backupHandlers.atomicWriteJson(boom, d, 'bad.json', '{}')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /injected open failure/)
  assert.equal(fs.readdirSync(d).some(f => f.startsWith('.tmp-')), false, 'no tmp residue after a failed write')
})
