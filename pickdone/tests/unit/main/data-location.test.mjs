/* F-RELOC regression tests — configurable data storage location + safe migration.
 *   data-location.cjs (pure node): boot-redirect read/write/clear atomicity + corrupt-JSON
 *   tolerance; validateTarget rejection branches; migrateData success + failure leaves the
 *   SOURCE untouched and writes NO boot file.
 *   index.js wiring: env branch stays ABOVE the boot-redirect branch (test isolation priority).
 * Run: node --test tests/unit/main/data-location.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dl = require('../../../src/main/data-location.cjs')

function sandbox (tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-loc-' + tag + '-'))
  return root
}

/** Isolate the boot file into the sandbox: the module derives its path from os.homedir(), so
 *  HOME/USERPROFILE are pointed at a fresh temp dir for the duration of a test. */
async function withHome (home, fn) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return await fn() } finally { Object.assign(process.env, old) }
}

// ---------- boot redirect file ----------

test('bootRedirectPath is a dot-file under homedir', async () => {
  await withHome(sandbox('path'), async () => {
    const p = dl.bootRedirectPath()
    assert.ok(path.isAbsolute(p))
    assert.equal(path.basename(p), '.pickdone-data-location.json')
  })
})

test('readBootRedirect: missing file / bad JSON / relative path / vanished dir → null', async () => {
  const home = sandbox('read')
  await withHome(home, async () => {
    assert.equal(dl.readBootRedirect(), null, 'no file yet')
    // bad JSON tolerated
    fs.writeFileSync(dl.bootRedirectPath(), '{not json')
    assert.equal(dl.readBootRedirect(), null, 'bad JSON')
    // valid JSON but relative path
    fs.writeFileSync(dl.bootRedirectPath(), JSON.stringify({ userDataDir: 'relative/dir' }))
    assert.equal(dl.readBootRedirect(), null, 'relative path')
    // absolute but nonexistent
    fs.writeFileSync(dl.bootRedirectPath(), JSON.stringify({ userDataDir: path.join(home, 'ghost') }))
    assert.equal(dl.readBootRedirect(), null, 'vanished dir')
    // happy path
    const real = path.join(home, 'real-ud')
    fs.mkdirSync(real)
    fs.writeFileSync(dl.bootRedirectPath(), JSON.stringify({ userDataDir: real }))
    assert.equal(dl.readBootRedirect(), real)
  })
})

test('writeBootRedirect is atomic (no tmp residue) and round-trips; clear removes it', async () => {
  const home = sandbox('write')
  await withHome(home, async () => {
    const dir = path.join(home, 'ud2')
    fs.mkdirSync(dir)
    dl.writeBootRedirect(dir)
    assert.equal(dl.readBootRedirect(), dir)
    // tmp+rename: no .tmp-* residue next to the boot file
    const residue = fs.readdirSync(home).filter(f => f.includes('.tmp-'))
    assert.deepEqual(residue, [], 'no tmp files left behind')
    const dir3 = path.join(home, 'ud3')
    fs.mkdirSync(dir3) // readBootRedirect only honors dirs that exist — mirror real usage
    dl.writeBootRedirect(dir3)
    assert.equal(dl.readBootRedirect(), dir3, 'second write supersedes')
    dl.clearBootRedirect()
    assert.equal(dl.readBootRedirect(), null, 'cleared')
    dl.clearBootRedirect() // idempotent — clearing a missing file does not throw
  })
})

test('writeBootRedirect rejects relative dirs', async () => {
  const home = sandbox('reject')
  await withHome(home, async () => {
    assert.throws(() => dl.writeBootRedirect('relative'), /absolute/)
  })
})

// ---------- validateTarget ----------

function makeSource (root) {
  const src = path.join(root, 'src-ud')
  fs.mkdirSync(path.join(src, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(src, 'todos.db'), 'SQLITE-DATA')
  fs.writeFileSync(path.join(src, 'db.key'), 'a'.repeat(64))
  fs.writeFileSync(path.join(src, 'config.json'), '{}')
  fs.writeFileSync(path.join(src, 'backups', 'b1.json'), '{}')
  return src
}

test('validateTarget rejects: relative / equals current / inside current / non-dir / junk non-empty target', async () => {
  const root = sandbox('vt')
  const src = makeSource(root)
  assert.equal(dl.validateTarget('relative', src).ok, false, 'relative')
  assert.equal(dl.validateTarget(src, src).ok, false, 'equals current')
  assert.equal(dl.validateTarget(path.join(src, 'child'), src).ok, false, 'inside current')
  const filePathTarget = path.join(root, 'afile')
  fs.writeFileSync(filePathTarget, 'x')
  assert.equal(dl.validateTarget(filePathTarget, src).ok, false, 'not a directory')
  const junk = path.join(root, 'junk')
  fs.mkdirSync(junk)
  fs.writeFileSync(path.join(junk, 'random.txt'), 'x')
  assert.equal(dl.validateTarget(junk, src).ok, false, 'non-empty non-data target')
  assert.match(dl.validateTarget(junk, src).reason, /neither empty nor a valid data directory/)
})

test('validateTarget allows: nonexistent, empty, and already-valid data dir (switch back)', async () => {
  const root = sandbox('vt-ok')
  const src = makeSource(root)
  assert.equal(dl.validateTarget(path.join(root, 'brand-new'), src).ok, true, 'nonexistent')
  const empty = path.join(root, 'empty')
  fs.mkdirSync(empty)
  assert.equal(dl.validateTarget(empty, src).ok, true, 'empty')
  const old = path.join(root, 'old-ud')
  fs.mkdirSync(old)
  fs.writeFileSync(path.join(old, 'todos.db'), 'OLD')
  fs.writeFileSync(path.join(old, 'db.key'), 'b'.repeat(64))
  const v = dl.validateTarget(old, src)
  assert.equal(v.ok, true, 'valid data dir = switch-back allowed')
})

test('validateTarget rejects unwritable target', async () => {
  const root = sandbox('vt-ro')
  const src = makeSource(root)
  const ro = path.join(root, 'ro')
  fs.mkdirSync(ro)
  const afile = path.join(root, 'afile')
  fs.writeFileSync(afile, 'x')
  if (process.platform === 'win32') {
    // Windows ACL semantics make chmod-based read-only dirs still writable; probe the negative
    // branch through a NON-DIRECTORY obstruction instead (write under a file path is rejected
    // by the isDirectory check — same reason chain, deterministic on all platforms).
    assert.equal(dl.validateTarget(afile, src).ok, false)
  } else {
    fs.chmodSync(ro, 0o500)
    try { assert.equal(dl.validateTarget(ro, src).ok, false, 'read-only target rejected') } finally { fs.chmodSync(ro, 0o700) }
  }
})

test('validateTarget rejects insufficient free space (injected probe)', async () => {
  const root = sandbox('vt-disk')
  const src = makeSource(root)
  const v = dl.validateTarget(path.join(root, 'new'), src, { freeBytes: 256 * 1024 * 1024 })
  assert.equal(v.ok, false)
  assert.match(v.reason, /insufficient free space/)
  // null (statfs unsupported) skips the guard, huge value passes
  assert.equal(dl.validateTarget(path.join(root, 'new'), src, { freeBytes: null }).ok, true)
  assert.equal(dl.validateTarget(path.join(root, 'new'), src, { freeBytes: Number.MAX_SAFE_INTEGER }).ok, true)
})

// ---------- migrateData ----------

function snapshotDir (dir) {
  const out = {}
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const key = prefix + e.name
      if (e.isDirectory()) { out[key + '/'] = 'dir'; walk(p, key + '/') } else out[key] = fs.statSync(p).size + ':' + fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir, '')
  return out
}

test('migrateData success: copies the required set (logs/ excluded), verifies, writes boot redirect', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('mig-ok-home')
  await withHome(home, async () => {
    const root = sandbox('mig-ok')
    const src = makeSource(root)
    fs.mkdirSync(path.join(src, 'logs'))
    fs.writeFileSync(path.join(src, 'logs', 'main.log'), 'noise')
    // conditional file: present here. NOTE: the wal must be EMPTY — a non-empty -wal/-shm in the
    // source is now a torn-DB abort ('in use by another process'); an empty residual file copies.
    fs.writeFileSync(path.join(src, 'cli-audit.jsonl'), '{"a":1}\n')
    fs.writeFileSync(path.join(src, 'todos.db-wal'), '')

    const target = path.join(root, 'target')
    const beforeSrc = snapshotDir(src)
    const r = await dl.migrateData(src, target)
    assert.equal(r.ok, true, 'migration succeeds: ' + (r.error || ''))
    assert.equal(fs.readFileSync(path.join(target, 'todos.db'), 'utf8'), 'SQLITE-DATA')
    assert.equal(fs.readFileSync(path.join(target, 'db.key'), 'utf8').length, 64)
    assert.equal(fs.readFileSync(path.join(target, 'todos.db-wal'), 'utf8'), '', 'empty residual wal copied')
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{}')
    assert.equal(fs.readFileSync(path.join(target, 'cli-audit.jsonl'), 'utf8'), '{"a":1}\n')
    assert.equal(fs.readFileSync(path.join(target, 'backups', 'b1.json'), 'utf8'), '{}')
    assert.equal(fs.existsSync(path.join(target, 'logs')), false, 'logs/ deliberately not migrated')
    assert.equal(dl.readBootRedirect(), target, 'boot file points at the new dir')
    // source untouched
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source byte-identical')
  })
})

test('migrateData failure (junk pre-existing target): source zero-change, NO boot file written', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('mig-fail-home')
  await withHome(home, async () => {
    const root = sandbox('mig-fail')
    const src = makeSource(root)
    const junk = path.join(root, 'junk')
    fs.mkdirSync(junk)
    fs.writeFileSync(path.join(junk, 'occupied.txt'), 'keep me')
    const beforeSrc = snapshotDir(src)
    const r = await dl.migrateData(src, junk)
    assert.equal(r.ok, false)
    assert.match(r.error, /neither empty nor a valid data directory/)
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched on rejection')
    assert.equal(dl.readBootRedirect(), null, 'no boot file on failure')
    assert.equal(fs.readFileSync(path.join(junk, 'occupied.txt'), 'utf8'), 'keep me', 'target junk untouched')
  })
})

test('migrateData verification failure cleans only what IT wrote (switch-back into valid dir keeps prior content)', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('mig-ver-home')
  await withHome(home, async () => {
    const root = sandbox('mig-ver')
    const src = makeSource(root)
    const target = path.join(root, 'prior-ud')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'todos.db'), 'PRIOR-DB')
    fs.writeFileSync(path.join(target, 'db.key'), 'c'.repeat(64))
    // Force a verification failure AFTER the copy: make backups tree mismatch by planting an
    // extra file in the target's backups mid-flight via a source that gains a nested dir between
    // copy and verify is not injectable — instead simulate via a source backups subtree deeper
    // than the copy achieves is impossible; use the DB-empty branch: shrink todos.db to empty on
    // the SOURCE is destructive. Cleanest injectable failure: read-only target dir -> copy throws.
    // On Windows chmod is unreliable, so exercise the written-only cleanup through a monkeypatched
    // copyFileSync failure via requiredFiles ordering: copy config.json over an existing READ-ONLY
    // target file is not portable either. Accept the portable path: use a pre-existing valid target
    // whose backups/ subtree ALREADY diverges → post-copy countFsObjects mismatch → rollback.
    fs.mkdirSync(path.join(target, 'backups'))
    fs.writeFileSync(path.join(target, 'backups', 'extra-old.json'), '{}')
    fs.writeFileSync(path.join(src, 'backups', 'b1.json'), '{}')
    const beforeSrc = snapshotDir(src)
    const r = await dl.migrateData(src, target)
    assert.equal(r.ok, false, 'divergent backups tree fails verification: ' + (r.error || ''))
    assert.match(r.error, /backups tree mismatch/)
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched after verification failure')
    // cleanup removed only THIS call's writes; the user's prior content survives
    assert.equal(fs.readFileSync(path.join(target, 'todos.db'), 'utf8'), 'PRIOR-DB', 'prior db intact')
    assert.equal(fs.existsSync(path.join(target, 'db.key')), true, 'prior key intact')
    assert.equal(fs.readFileSync(path.join(target, 'backups', 'extra-old.json'), 'utf8'), '{}', 'prior backup intact')
    assert.equal(dl.readBootRedirect(), null, 'no boot file on verification failure')
  })
})

test('migrateData rejects the same targets validateTarget rejects', async () => {
  dl._resetRelocationGatesForTests()
  const root = sandbox('mig-rej')
  const src = makeSource(root)
  assert.equal((await dl.migrateData(src, src)).ok, false)
  assert.equal((await dl.migrateData(src, path.join(src, 'nested'))).ok, false)
  assert.equal((await dl.migrateData(src, 'relative')).ok, false)
})

// ---------- index.js wiring anchors (source-level, no electron boot) ----------

test('index.js wiring: env branch stays BEFORE the boot-redirect branch (test isolation wins)', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8')
  const envIdx = src.indexOf("if (process.env.TODO_USER_DATA_DIR) app.setPath('userData', process.env.TODO_USER_DATA_DIR)")
  const bootIdx = src.indexOf("const bootRedirect = require('./data-location.cjs').readBootRedirect()")
  const elseIdx = src.indexOf("else if (bootRedirect) app.setPath('userData', bootRedirect)")
  assert.ok(envIdx > -1, 'env branch present')
  assert.ok(bootIdx > -1, 'boot redirect read present')
  assert.ok(elseIdx > -1, 'else-if branch present')
  assert.ok(bootIdx < envIdx, 'boot file is READ before the env branch (value only used in else)')
  assert.ok(envIdx < elseIdx, 'env branch precedes the boot-redirect branch')
})

test('preload exposes the two data-location channels aligned with handlers/system.js', async () => {
  const pre = fs.readFileSync(path.join(process.cwd(), 'src/preload/index.js'), 'utf8')
  const sys = fs.readFileSync(path.join(process.cwd(), 'src/main/handlers/system.js'), 'utf8')
  for (const ch of ['data:location-info', 'data:relocate']) {
    assert.ok(pre.includes(`'${ch}'`), `preload invokes ${ch}`)
    assert.ok(sys.includes(`'${ch}'`), `system.js handles ${ch}`)
  }
  assert.ok(/relocateDataDir: targetDir => invoke\('data:relocate'/.test(pre), 'relocateDataDir passthrough')
  // main-window gate on both channels (same guard class as the updater siblings)
  const relocate = sys.slice(sys.indexOf("'data:relocate'"), sys.indexOf("'data:relocate'") + 400)
  const info = sys.slice(sys.indexOf("'data:location-info'"), sys.indexOf("'data:location-info'") + 200)
  assert.ok(relocate.includes('assertMainWindow(e)') && relocate.includes("isLocked()"), 'data:relocate gated')
  assert.ok(info.includes('assertMainWindow(e)'), 'data:location-info gated')
})

// ---------- D1 fix-wave regressions (2026-10-21) ----------

test('D1#2 validateTarget rejects a target that CONTAINS the current dir (ancestor)', async () => {
  const root = sandbox('anc')
  const src = path.join(root, 'outer', 'inner-ud')
  fs.mkdirSync(path.join(src, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(src, 'todos.db'), 'X')
  fs.writeFileSync(path.join(src, 'db.key'), 'k'.repeat(64))
  const v = dl.validateTarget(path.join(root, 'outer'), src)
  assert.equal(v.ok, false)
  assert.match(v.reason, /contains the current data directory/)
  assert.equal((await dl.migrateData(src, path.join(root, 'outer'))).ok, false)
})

test('D1#5 windows case-insensitive bypass: casing variant of the current dir is rejected', { skip: process.platform !== 'win32' }, () => {
  const root = sandbox('case')
  const src = makeSource(root)
  // Same directory on NTFS, different string: resolve() does not fold case, so the old
  // strict === comparison let this variant pass every guard and migrate onto itself.
  const variant = src.replace(/src-ud$/, 'SRC-UD')
  assert.notEqual(variant, src, 'test setup: the variant must differ textually')
  const v = dl.validateTarget(variant, src)
  assert.equal(v.ok, false)
  assert.match(v.reason, /equals the current data directory/)
})

test('D1#4a migrateData aborts when a NON-EMPTY todos.db-wal/-shm sits in the source (external writer)', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('wal-home')
  await withHome(home, async () => {
    const root = sandbox('wal')
    const src = makeSource(root)
    fs.writeFileSync(path.join(src, 'todos.db-wal'), 'LIVE-WAL-FRAMES')
    const beforeSrc = snapshotDir(src)
    const r = await dl.migrateData(src, path.join(root, 'target'))
    assert.equal(r.ok, false)
    assert.match(r.error, /in use by another process/)
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched')
    assert.equal(dl.readBootRedirect(), null, 'no boot file')
    // same for -shm
    fs.rmSync(path.join(src, 'todos.db-wal'), { force: true })
    fs.writeFileSync(path.join(src, 'todos.db-shm'), 'S')
    const r2 = await dl.migrateData(src, path.join(root, 'target'))
    assert.equal(r2.ok, false)
    assert.match(r2.error, /todos\.db-shm/)
    // an EMPTY residual wal is inert and may still migrate
    fs.rmSync(path.join(src, 'todos.db-shm'), { force: true })
    fs.writeFileSync(path.join(src, 'todos.db-wal'), '')
    assert.equal((await dl.migrateData(src, path.join(root, 'target'))).ok, true)
  })
})

test('D1#4b migrateData aborts when the source todos.db changes during the copy (concurrent writer)', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('mtime-home')
  await withHome(home, async () => {
    const root = sandbox('mtime')
    const src = makeSource(root)
    const target = path.join(root, 'target')
    const beforeSrc = snapshotDir(src)
    // Simulate a writer advancing the source db MID-FLIGHT: while the copy of todos.db lands in
    // the target, bump the source file's mtime (size+stamp identity then mismatches post-copy).
    const realCopy = fs.copyFileSync
    const patched = (srcFile, destFile) => {
      realCopy(srcFile, destFile)
      if (String(destFile).endsWith(path.join('target', 'todos.db'))) {
        const st = fs.statSync(srcFile)
        fs.utimesSync(srcFile, st.atime, new Date(Date.now() + 5000))
      }
    }
    fs.copyFileSync = patched
    let r
    try { r = await dl.migrateData(src, target) } finally { fs.copyFileSync = realCopy }
    assert.equal(r.ok, false)
    assert.match(r.error, /changed during the copy/)
    // full rollback contract: only THIS call's writes are removed, source byte-identical
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched')
    assert.equal(fs.existsSync(path.join(target, 'todos.db')), false, 'copied db rolled back')
    assert.equal(dl.readBootRedirect(), null, 'no boot file')
  })
})

test('D1#6 requiredFiles carries files/ and allowed-backup-dirs.json; trees verified', async () => {
  const home = sandbox('files-home')
  await withHome(home, async () => {
    const root = sandbox('files')
    const src = makeSource(root)
    fs.writeFileSync(path.join(src, 'allowed-backup-dirs.json'), '[]')
    fs.mkdirSync(path.join(src, 'files'))
    fs.mkdirSync(path.join(src, 'files', 'att-1'))
    fs.writeFileSync(path.join(src, 'files', 'att-1', 'a.bin'), 'AA')
    const target = path.join(root, 'target')
    const r = await dl.migrateData(src, target)
    assert.equal(r.ok, true, 'migration succeeds: ' + (r.error || ''))
    assert.equal(fs.readFileSync(path.join(target, 'allowed-backup-dirs.json'), 'utf8'), '[]')
    assert.equal(fs.readFileSync(path.join(target, 'files', 'att-1', 'a.bin'), 'utf8'), 'AA')
    // a divergent files/ tree fails verification and rolls back (same contract as backups/)
    const root2 = sandbox('files2')
    const src2 = makeSource(root2)
    fs.mkdirSync(path.join(src2, 'files'))
    fs.writeFileSync(path.join(src2, 'files', 'x.bin'), 'X')
    const prior = path.join(root, 'prior')
    fs.mkdirSync(prior)
    fs.writeFileSync(path.join(prior, 'todos.db'), 'PRIOR')
    fs.writeFileSync(path.join(prior, 'db.key'), 'd'.repeat(64))
    fs.mkdirSync(path.join(prior, 'files'))
    fs.writeFileSync(path.join(prior, 'files', 'old.bin'), 'O')
    dl._resetRelocationGatesForTests()
    const r2 = await dl.migrateData(src2, prior)
    assert.equal(r2.ok, false)
    assert.match(r2.error, /files tree mismatch/)
    assert.equal(fs.readFileSync(path.join(prior, 'files', 'old.bin'), 'utf8'), 'O', 'prior files/ restored')
    // absent on a bare source → absent in target
    dl._resetRelocationGatesForTests()
    const root3 = sandbox('bare')
    const bare = path.join(root3, 'bare-ud')
    fs.mkdirSync(bare)
    fs.writeFileSync(path.join(bare, 'todos.db'), 'B')
    fs.writeFileSync(path.join(bare, 'db.key'), 'e'.repeat(64))
    const t2 = path.join(root3, 'bare-target')
    assert.equal((await dl.migrateData(bare, t2)).ok, true)
    assert.equal(fs.existsSync(path.join(t2, 'files')), false, 'no files/ dir minted')
    assert.equal(fs.existsSync(path.join(t2, 'allowed-backup-dirs.json')), false, 'no whitelist minted')
  })
})

test('D1#3 boot-redirect write failure is inside the rollback contract (copy undone, stash restored)', async () => {
  const home = sandbox('bootfail-home')
  await withHome(home, async () => {
    // Sabotage the boot file path: make it an existing DIRECTORY — the atomic tmp+rename throws,
    // which used to fall into the second catch and leave the copied content + orphaned stash.
    fs.mkdirSync(dl.bootRedirectPath(), { recursive: true })
    const root = sandbox('bootfail')
    const src = makeSource(root)
    const target = path.join(root, 'prior-ud')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'todos.db'), 'PRIOR-DB')
    fs.writeFileSync(path.join(target, 'db.key'), 'f'.repeat(64))
    const beforeSrc = snapshotDir(src)
    dl._resetRelocationGatesForTests()
    const r = await dl.migrateData(src, target)
    assert.equal(r.ok, false)
    assert.match(r.error, /boot redirect|rename|EPERM|EEXIST|EISDIR/i)
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched')
    assert.equal(fs.readFileSync(path.join(target, 'todos.db'), 'utf8'), 'PRIOR-DB', 'prior db restored, not the copy')
    assert.equal(fs.existsSync(path.join(target, 'config.json')), false, 'this call\'s writes cleaned')
    assert.equal(fs.existsSync(path.join(target, 'backups')), false, 'copied backups tree cleaned')
  })
})

test('D1#8c migrateData sets the in-process relocation-pending gate on success', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('gate-home')
  await withHome(home, async () => {
    const root = sandbox('gate')
    const src = makeSource(root)
    // The gate is module-level and sticky-until-exit BY DESIGN: it arms at the first successful
    // migration and stays armed for the migrate→relaunch window (the process exits right after),
    // so this suite only asserts the arming, not a reset.
    assert.equal((await dl.migrateData(src, path.join(root, 'target'))).ok, true)
    assert.equal(dl.getRelocationPending(), true, 'gate open for the migrate→relaunch window')
  })
})

test('D1#1 handlers/system.js data:relocate refuses isolated/test instances BEFORE any side effect', async () => {
  const sys = fs.readFileSync(path.join(process.cwd(), 'src/main/handlers/system.js'), 'utf8')
  const h = sys.indexOf("'data:relocate'")
  const body = sys.slice(h, sys.length)
  const guard = body.indexOf('TODO_USER_DATA_DIR || process.env.TODO_DB_DIR')
  const msg = body.indexOf('relocation is disabled in isolated/test instances')
  assert.ok(guard > -1 && msg > -1, 'isolation guard present in data:relocate')
  // the guard must precede every side effect: dialog open, db close, migrate
  for (const later of ["showOpenDialog", 'dbm.close', 'dl.migrateData', 'stopLatestDbWatch']) {
    const at = body.indexOf(later)
    assert.ok(at > guard, `${later} sits after the isolation guard`)
  }
  // D1#8a: the external-write poll is stopped before the DB close
  assert.ok(body.indexOf('stopLatestDbWatch') < body.indexOf('dbm.close'), 'watch stop precedes db close')
  // D1#8b: a running pomodoro is confirmed before the close (same gate as quit-and-install)
  assert.ok(body.includes('hasRunningSession()'), 'pomodoro gate present')
})

// ---------- migration progress + boot-state honesty (2026-10-22 UX round) ----------

test('migrateData onProgress: copy ticks are monotone with a correct total, then verify+boot phases', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('prog-home')
  await withHome(home, async () => {
    const root = sandbox('prog')
    const src = makeSource(root)
    // enough files/ objects that several YIELD_EVERY ticks fire
    fs.mkdirSync(path.join(src, 'files'), { recursive: true })
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(src, 'files', 'f' + i + '.bin'), 'x'.repeat(i + 1))
    const events = []
    const target = path.join(root, 'target')
    const r = await dl.migrateData(src, target, { onProgress: p => events.push({ ...p }) })
    assert.equal(r.ok, true, r.error || '')
    const copy = events.filter(e => e.phase === 'copy')
    assert.ok(copy.length >= 2, 'multiple copy progress ticks fired, got ' + copy.length)
    assert.equal(copy[copy.length - 1].done, copy[copy.length - 1].total, 'final copy tick reaches the total')
    for (let i = 1; i < copy.length; i++) {
      assert.ok(copy[i].done >= copy[i - 1].done, 'copy progress is monotone')
      assert.equal(copy[i].total, copy[0].total, 'total is stable across ticks')
    }
    assert.deepEqual(events.filter(e => e.phase !== 'copy').map(e => e.phase), ['verify', 'boot'], 'verify then boot phases at the tail')
    // denominator sanity: the pre-count equals the real tree size (db+key+config+backups tree+files tree+…)
    const countTree = d => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? countTree(path.join(d, e.name)) : 1; return n }
    const last = copy[copy.length - 1]
    assert.ok(last.total >= 30, 'total covers the files/ tree, got ' + last.total)
    assert.equal(countTree(target), countTree(src), 'shape identity preserved')
  })
})

test('migrateData onProgress is optional (legacy two-arg call still migrates)', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('prog2-home')
  await withHome(home, async () => {
    const root = sandbox('prog2')
    const src = makeSource(root)
    const r = await dl.migrateData(src, path.join(root, 'target'))
    assert.equal(r.ok, true, r.error || '')
    assert.equal(dl.readBootRedirect(), path.join(root, 'target'))
  })
})

test('readBootRedirectState: ok / missing / invalid / none, and readBootRedirect still null-guards', async () => {
  const home = sandbox('state-home')
  await withHome(home, async () => {
    assert.equal(dl.readBootRedirectState().status, 'none', 'no boot file yet')
    dl.writeBootRedirect(home)
    assert.deepEqual(dl.readBootRedirectState(), { status: 'ok', dir: home })
    // target vanished: 'missing' with the dir remembered (index.js surfaces a dialog), readBootRedirect null
    const gone = path.join(home, 'gone')
    fs.writeFileSync(dl.bootRedirectPath(), JSON.stringify({ userDataDir: gone }))
    const st = dl.readBootRedirectState()
    assert.equal(st.status, 'missing')
    assert.equal(st.dir, gone)
    assert.equal(dl.readBootRedirect(), null, 'legacy read still guards the vanished dir')
    // invalid: corrupt JSON / relative dir
    fs.writeFileSync(dl.bootRedirectPath(), '{ truncated')
    assert.equal(dl.readBootRedirectState().status, 'invalid')
    fs.writeFileSync(dl.bootRedirectPath(), JSON.stringify({ userDataDir: 'relative/path' }))
    assert.equal(dl.readBootRedirectState().status, 'invalid')
  })
})

test('startup honesty anchors: index.js surfaces a missing boot target; preload pushes progress', () => {
  const idx = fs.readFileSync(path.join(process.cwd(), 'src/main/index.js'), 'utf8')
  assert.match(idx, /readBootRedirectState\(\)/, 'index.js snapshots the boot state')
  const notice = fs.readFileSync(path.join(process.cwd(), 'src/main/boot-notice.cjs'), 'utf8')
  assert.match(notice, /dataLocMissingTitle/, 'missing-target dialog wired (boot-notice.cjs)')
  assert.match(notice, /status !== 'missing'/, 'notice no-ops unless the target truly vanished')
  // the snapshot must be taken in the same module-init region as the setPath branches (before ready)
  const snapIdx = idx.indexOf('const bootRedirectState =')
  const readyIdx = idx.indexOf('app.whenReady()')
  assert.ok(snapIdx > -1 && readyIdx > -1 && snapIdx < readyIdx, 'boot state read before whenReady')
  const pre = fs.readFileSync(path.join(process.cwd(), 'src/preload/index.js'), 'utf8')
  assert.match(pre, /onMigrateProgress/, 'preload exposes the progress push')
  const sys = fs.readFileSync(path.join(process.cwd(), 'src/main/handlers/system.js'), 'utf8')
  assert.match(sys, /data-migrate-progress/, 'relocate handler emits progress')
  assert.match(sys, /await dl\.migrateData/, 'handler awaits the async migration')
})
