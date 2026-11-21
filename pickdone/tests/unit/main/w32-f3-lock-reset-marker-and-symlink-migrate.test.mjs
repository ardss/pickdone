/* W32-F3 regression tests (2026-11-03), two P2 fixes:
 *   1. security-lock.js — the disable-lock fallback (lockLoadFailedFallback, reached from the
 *      lock-window load failure AND the safeStorage decrypt failure) used to ignore writeConfig's
 *      null return when config.json was unreadable (the _readFailed write gate): disk unchanged,
 *      log claimed success, poisoned password re-locked on every restart. Now a durable
 *      lockResetPending.json marker is dropped, and recoverPendingLockReset re-issues the disable
 *      write on the first readable boot (marker cleared only on a confirmed write).
 *   2. data-location.cjs — copyDirRecursive used to throw on symlinks inside files//backups/
 *      (file symlink → copyFileSync on a directory link → whole migration abort + cleanup on
 *      EVERY retry). Now: directory symlinks are recreated as junctions at the target; file
 *      symlinks fail the migration BEFORE any copy, listing the conflicts (fail-closed).
 * Run: node --test tests/unit/main/w32-f3-lock-reset-marker-and-symlink-migrate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sl = require('../../../src/main/security-lock.js')
const dl = require('../../../src/main/data-location.cjs')

function tmpDir (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w32f3-' + tag + '-'))
}

/** Build a createSecurityLock harness with injected deps; captures log lines and writeConfig calls. */
function lockHarness ({ writeConfigReturns } = {}) {
  const calls = { writes: [], logs: { error: [], warn: [] } }
  const log = {
    error: (...a) => calls.logs.error.push(a.map(String).join(' ')),
    warn: (...a) => calls.logs.warn.push(a.map(String).join(' '))
  }
  const writeConfig = (patch) => {
    calls.writes.push(patch)
    return writeConfigReturns === 'throw'
      ? (() => { throw new Error('disk on fire') })()
      : (writeConfigReturns === 'promise' ? Promise.resolve({}) : (writeConfigReturns === 'null' ? null : { ...patch }))
  }
  const lock = sl.createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => ({ enableSecurityLock: true, securityLockPassword: 'enc1:AAAAAAAA' }),
    writeConfig,
    i18n: { mt: (k) => k },
    log,
    getMarkerDir: () => calls.markerDir
  })
  return { lock, calls }
}

/** Drive the decrypt-failure path (stored 'enc1:' + garbage → safeStorage unavailable in plain
 *  node → throw) which routes into lockLoadFailedFallback. */
async function triggerDecryptFailureFallback (lock) {
  return lock.verifyLockPassword('whatever')
}

// ---------- Fix 1a: gated writeConfig during the fallback → durable marker, no fake success ----------

test('W32-F3 #1a: fallback with writeConfig gated (returns null) drops a durable reset marker and does NOT report success', async () => {
  const markerDir = tmpDir('marker-gated')
  const { lock, calls } = lockHarness({ writeConfigReturns: 'null' })
  calls.markerDir = markerDir
  const ok = await triggerDecryptFailureFallback(lock)
  assert.equal(ok, false, 'undecryptable password must not unlock')
  assert.equal(calls.writes.length, 1, 'disable write attempted once')
  assert.deepEqual(calls.writes[0], { enableSecurityLock: false, securityLockPassword: '', securityLockQuestion: '' })
  const marker = sl.readLockResetMarker(markerDir)
  assert.ok(marker, 'marker file must exist on disk after a gated write')
  assert.ok(typeof marker.why === 'string' && marker.why.length > 0, 'marker records why')
  // tmp residue must not survive (durable write: tmp → fsync → rename)
  assert.equal(fs.existsSync(path.join(markerDir, 'lockResetPending.json.tmp')), false, 'no tmp residue')
  // the log must NOT claim the wipe succeeded — an explicit gating error line is required
  const joined = calls.logs.error.join('\n') + calls.logs.warn.join('\n')
  assert.ok(/config\.json 不可读|恢复标记/.test(joined), 'log must surface the gating + marker, not fake success')
})

test('W32-F3 #1a-b: marker write failure (no dir) is logged, fallback still restores the main window', async () => {
  const { lock, calls } = lockHarness({ writeConfigReturns: 'null' })
  calls.markerDir = null // userData unresolvable: marker cannot be written
  const ok = await triggerDecryptFailureFallback(lock)
  assert.equal(ok, false)
  const joined = calls.logs.error.join('\n')
  assert.ok(/恢复标记/.test(joined), 'the missed marker must be visible in the log, not silently dropped')
})

// ---------- Fix 1b: confirmed write clears a stale marker ----------

test('W32-F3 #1b: fallback with a CONFIRMED write clears any stale marker and logs no gating error', async () => {
  const markerDir = tmpDir('marker-clear')
  sl.writeLockResetMarker(markerDir, 'stale from a previous boot')
  const { lock, calls } = lockHarness({ writeConfigReturns: 'object' })
  calls.markerDir = markerDir
  const ok = await triggerDecryptFailureFallback(lock)
  assert.equal(ok, false)
  assert.equal(sl.readLockResetMarker(markerDir), null, 'stale marker must be cleared after a confirmed write')
  assert.ok(!calls.logs.error.some(l => /恢复标记|config\.json 不可读/.test(l)), 'no gating error on the confirmed path')
})

test('W32-F3 #1c: degenerate async writeConfig (Promise) counts as NOT confirmed → marker dropped', async () => {
  const markerDir = tmpDir('marker-promise')
  const { lock, calls } = lockHarness({ writeConfigReturns: 'promise' })
  calls.markerDir = markerDir
  await triggerDecryptFailureFallback(lock)
  assert.ok(sl.readLockResetMarker(markerDir), 'a Promise return is not a confirmed write → marker kept')
})

// ---------- Fix 1d: startup recovery ----------

test('W32-F3 #1d: recoverPendingLockReset re-issues the disable write on a readable boot and clears the marker', () => {
  const markerDir = tmpDir('recover-ok')
  sl.writeLockResetMarker(markerDir, 'gated last boot')
  const calls = { writes: [] }
  const res = sl.recoverPendingLockReset({
    markerDir,
    writeConfig: (p) => { calls.writes.push(p); return { ...p } },
    log: { error: () => {}, warn: () => {} }
  })
  assert.equal(res.recovered, true)
  assert.equal(res.pending, false)
  assert.deepEqual(calls.writes[0], { enableSecurityLock: false, securityLockPassword: '', securityLockQuestion: '' })
  assert.equal(sl.readLockResetMarker(markerDir), null, 'marker cleared only after the confirmed recovery write')
})

test('W32-F3 #1e: recoverPendingLockReset keeps the marker when the boot write is still gated', () => {
  const markerDir = tmpDir('recover-gated')
  sl.writeLockResetMarker(markerDir, 'still locked')
  let attempts = 0
  const res = sl.recoverPendingLockReset({
    markerDir,
    writeConfig: () => { attempts++; return null },
    log: { error: () => {}, warn: () => {} }
  })
  assert.equal(res.recovered, false)
  assert.equal(res.pending, true)
  assert.equal(attempts, 1)
  assert.ok(sl.readLockResetMarker(markerDir), 'gated recovery write must NOT clear the marker')
})

test('W32-F3 #1f: no marker → recovery is a no-op and never touches writeConfig', () => {
  const markerDir = tmpDir('recover-none')
  let attempts = 0
  const res = sl.recoverPendingLockReset({
    markerDir,
    writeConfig: () => { attempts++; return {} },
    log: { error: () => {}, warn: () => {} }
  })
  assert.deepEqual(res, { recovered: false, pending: false })
  assert.equal(attempts, 0)
})

// ---------- Fix 2: symlink handling in the data-location migration ----------

/** Build a minimal valid source data dir: non-empty todos.db + db.key (+ a files/ tree). */
function makeSourceDataDir (root) {
  const src = path.join(root, 'src-ud')
  fs.mkdirSync(path.join(src, 'files'), { recursive: true })
  fs.writeFileSync(path.join(src, 'todos.db'), Buffer.from('sqlite-real-content-not-empty-0123456789'))
  fs.writeFileSync(path.join(src, 'db.key'), 'k')
  fs.writeFileSync(path.join(src, 'files', 'note.txt'), 'hello')
  return src
}

function migrateOpts () {
  return { freeBytes: dl.MIN_FREE_BYTES * 10 } // skip the real volume probe in tests
}

async function withHome (home, fn) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return await fn() } finally { Object.assign(process.env, old) }
}

test('W32-F3 #2a (non-symlink baseline): plain migration still succeeds after the copyDirRecursive rewrite', async () => {
  const root = tmpDir('mig-plain')
  const src = makeSourceDataDir(root)
  const target = path.join(root, 'target')
  await withHome(root, async () => {
    dl._resetRelocationGatesForTests() // sticky until-relaunch gates: reset per case in one process
    const res = await dl.migrateData(src, target, migrateOpts())
    assert.equal(res.ok, true, 'plain migration must succeed: ' + (res.error || ''))
    assert.equal(fs.readFileSync(path.join(target, 'files', 'note.txt'), 'utf8'), 'hello')
    assert.equal(fs.readFileSync(path.join(src, 'files', 'note.txt'), 'utf8'), 'hello', 'source untouched')
    assert.equal(dl.readBootRedirect(), target, 'boot file written to the target')
  })
})

test('W32-F3 #2b: FILE symlink inside files/ fails the migration BEFORE any copy, listing the conflict', async (t) => {
  const root = tmpDir('mig-filesym')
  const src = makeSourceDataDir(root)
  const externalFile = path.join(root, 'external.txt')
  fs.writeFileSync(externalFile, 'linked attachment')
  try {
    fs.symlinkSync(externalFile, path.join(src, 'files', 'linked.txt'), 'file')
  } catch (e) {
    // Windows without admin/developer mode: creating a file symlink fails — environment limitation
    return t.skip('file symlink creation not permitted in this environment: ' + (e.code || e.message))
  }
  const target = path.join(root, 'target')
  await withHome(root, async () => {
    dl._resetRelocationGatesForTests() // sticky until-relaunch gates: reset per case in one process
    const res = await dl.migrateData(src, target, migrateOpts())
    assert.equal(res.ok, false, 'migration must be refused (fail-closed)')
    assert.ok(Array.isArray(res.conflicts) && res.conflicts.some(c => c.includes('linked.txt')), 'conflict list must name the offending symlink')
    assert.equal(fs.existsSync(path.join(target, 'todos.db')), false, 'nothing may be copied on refusal')
    assert.equal(dl.readBootRedirect(), null, 'no boot file on refusal')
    assert.equal(fs.readFileSync(path.join(src, 'todos.db'), 'utf8').length > 0, true, 'source untouched')
  })
})

test('W32-F3 #2c: DIRECTORY symlink inside files/ is recreated as a junction; the linked tree is not copied', async (t) => {
  const root = tmpDir('mig-dirsym')
  const src = makeSourceDataDir(root)
  const linkedDir = path.join(root, 'linked-attachments')
  fs.mkdirSync(linkedDir)
  fs.writeFileSync(path.join(linkedDir, 'big.bin'), 'x'.repeat(1024))
  let junctionOk = true
  try {
    fs.symlinkSync(linkedDir, path.join(src, 'files', 'linked-dir'), 'junction')
  } catch (e) {
    junctionOk = false
  }
  if (!junctionOk) return test.skip('directory symlink creation not permitted in this environment')
  const target = path.join(root, 'target')
  await withHome(root, async () => {
    dl._resetRelocationGatesForTests() // sticky until-relaunch gates: reset per case in one process
    const res = await dl.migrateData(src, target, migrateOpts())
    assert.equal(res.ok, true, 'dir-symlink migration must succeed: ' + (res.error || ''))
    const tLink = path.join(target, 'files', 'linked-dir')
    assert.ok(fs.lstatSync(tLink).isSymbolicLink(), 'target entry is a link, not a copied tree')
    // junction recreation points at the same resolved directory — semantics preserved, not duplicated
    const resolved = fs.realpathSync(tLink)
    assert.equal(resolved.toLowerCase(), fs.realpathSync(linkedDir).toLowerCase(), 'link resolves to the original external dir')
    assert.equal(fs.existsSync(path.join(target, 'files', 'linked-dir', 'big.bin')), true, 'link still resolves through to the content')
    // no duplication: the linked CONTENT must not have been materialized elsewhere in the target tree
    const stray = fs.readdirSync(path.join(target, 'files')).filter(n => n !== 'note.txt' && n !== 'linked-dir')
    assert.deepEqual(stray, [], 'linked tree must not be copied as real files')
    assert.equal(dl.readBootRedirect(), target, 'boot file written')
  })
})

test('W32-F3 #2d: DANGLING file symlink is also refused (fail-closed)', async (t) => {
  const root = tmpDir('mig-dangling')
  const src = makeSourceDataDir(root)
  try {
    fs.symlinkSync(path.join(root, 'ghost-target.bin'), path.join(src, 'files', 'dangling.bin'), 'file')
  } catch (e) {
    return t.skip('file symlink creation not permitted in this environment: ' + (e.code || e.message))
  }
  const target = path.join(root, 'target')
  await withHome(root, async () => {
    dl._resetRelocationGatesForTests() // sticky until-relaunch gates: reset per case in one process
    const res = await dl.migrateData(src, target, migrateOpts())
    assert.equal(res.ok, false)
    assert.ok(res.conflicts.some(c => c.includes('dangling.bin')))
  })
})

test('W32-F3 #2e: findFileSymlinks pre-scan matches copy-time refusal semantics', () => {
  const root = tmpDir('scan')
  const dir = path.join(root, 'tree')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b')
  assert.deepEqual(dl.findFileSymlinks(dir), [], 'clean tree: no conflicts')
  try {
    fs.symlinkSync(path.join(root, 'x.txt'), path.join(dir, 'sub', 'lnk.bin'), 'file')
    const found = dl.findFileSymlinks(dir)
    assert.equal(found.length, 1)
    assert.ok(found[0].includes('lnk.bin'))
  } catch (e) { /* env limitation — the clean-tree assertion above already ran */ }
})
