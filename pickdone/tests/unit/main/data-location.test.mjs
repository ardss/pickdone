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
function withHome (home, fn) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return fn() } finally { Object.assign(process.env, old) }
}

// ---------- boot redirect file ----------

test('bootRedirectPath is a dot-file under homedir', () => {
  withHome(sandbox('path'), () => {
    const p = dl.bootRedirectPath()
    assert.ok(path.isAbsolute(p))
    assert.equal(path.basename(p), '.pickdone-data-location.json')
  })
})

test('readBootRedirect: missing file / bad JSON / relative path / vanished dir → null', () => {
  const home = sandbox('read')
  withHome(home, () => {
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

test('writeBootRedirect is atomic (no tmp residue) and round-trips; clear removes it', () => {
  const home = sandbox('write')
  withHome(home, () => {
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

test('writeBootRedirect rejects relative dirs', () => {
  const home = sandbox('reject')
  withHome(home, () => {
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

test('validateTarget rejects: relative / equals current / inside current / non-dir / junk non-empty target', () => {
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

test('validateTarget allows: nonexistent, empty, and already-valid data dir (switch back)', () => {
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

test('validateTarget rejects unwritable target', () => {
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

test('validateTarget rejects insufficient free space (injected probe)', () => {
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

test('migrateData success: copies the required set (logs/ excluded), verifies, writes boot redirect', () => {
  const home = sandbox('mig-ok-home')
  withHome(home, () => {
    const root = sandbox('mig-ok')
    const src = makeSource(root)
    fs.mkdirSync(path.join(src, 'logs'))
    fs.writeFileSync(path.join(src, 'logs', 'main.log'), 'noise')
    // conditional file: present here
    fs.writeFileSync(path.join(src, 'cli-audit.jsonl'), '{"a":1}\n')
    fs.writeFileSync(path.join(src, 'todos.db-wal'), 'WAL')

    const target = path.join(root, 'target')
    const beforeSrc = snapshotDir(src)
    const r = dl.migrateData(src, target)
    assert.equal(r.ok, true, 'migration succeeds: ' + (r.error || ''))
    assert.equal(fs.readFileSync(path.join(target, 'todos.db'), 'utf8'), 'SQLITE-DATA')
    assert.equal(fs.readFileSync(path.join(target, 'db.key'), 'utf8').length, 64)
    assert.equal(fs.readFileSync(path.join(target, 'todos.db-wal'), 'utf8'), 'WAL', 'conditional wal copied')
    assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{}')
    assert.equal(fs.readFileSync(path.join(target, 'cli-audit.jsonl'), 'utf8'), '{"a":1}\n')
    assert.equal(fs.readFileSync(path.join(target, 'backups', 'b1.json'), 'utf8'), '{}')
    assert.equal(fs.existsSync(path.join(target, 'logs')), false, 'logs/ deliberately not migrated')
    assert.equal(dl.readBootRedirect(), target, 'boot file points at the new dir')
    // source untouched
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source byte-identical')
  })
})

test('migrateData failure (junk pre-existing target): source zero-change, NO boot file written', () => {
  const home = sandbox('mig-fail-home')
  withHome(home, () => {
    const root = sandbox('mig-fail')
    const src = makeSource(root)
    const junk = path.join(root, 'junk')
    fs.mkdirSync(junk)
    fs.writeFileSync(path.join(junk, 'occupied.txt'), 'keep me')
    const beforeSrc = snapshotDir(src)
    const r = dl.migrateData(src, junk)
    assert.equal(r.ok, false)
    assert.match(r.error, /neither empty nor a valid data directory/)
    assert.deepEqual(snapshotDir(src), beforeSrc, 'source untouched on rejection')
    assert.equal(dl.readBootRedirect(), null, 'no boot file on failure')
    assert.equal(fs.readFileSync(path.join(junk, 'occupied.txt'), 'utf8'), 'keep me', 'target junk untouched')
  })
})

test('migrateData verification failure cleans only what IT wrote (switch-back into valid dir keeps prior content)', () => {
  const home = sandbox('mig-ver-home')
  withHome(home, () => {
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
    const r = dl.migrateData(src, target)
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

test('migrateData rejects the same targets validateTarget rejects', () => {
  const root = sandbox('mig-rej')
  const src = makeSource(root)
  assert.equal(dl.migrateData(src, src).ok, false)
  assert.equal(dl.migrateData(src, path.join(src, 'nested')).ok, false)
  assert.equal(dl.migrateData(src, 'relative').ok, false)
})

// ---------- index.js wiring anchors (source-level, no electron boot) ----------

test('index.js wiring: env branch stays BEFORE the boot-redirect branch (test isolation wins)', () => {
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

test('preload exposes the two data-location channels aligned with handlers/system.js', () => {
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
