/* M2a (w7) robust-relocate regression tests — data migration / recovery / external-write poll domain.
 * Covers:
 *   P1 validateTarget realpath containment (junction/symlink into the source subtree must be rejected)
 *   P1 writeBootRedirect durable write contract (tmp → fsync → rename; no residue, content correct)
 *   P2 migrateData reentry gate (concurrent second call refused; refused after a finished migration)
 *   P2 dbRecovery encryptedProbe: non-64-hex db.key → 'unknown' (no .corrupt-* rename of a live db)
 *   P2 external-db-watch: debounce-callback failure rolls the mtime baseline back (write not consumed)
 *   P3 requiredFiles: recovery-pending.json / renderer-crash-relaunch-count.json / legacy critical-state-backup.json
 *   P3 sweepEmptyCriticalBackups: keep newest 5 critical-state-backup.empty-*.json; mounted in sweepPendingDeletes
 * Run: node --test tests/unit/main/w7-robust-relocate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dl = require('../../../src/main/data-location.cjs')
const dbr = require('../../../src/main/dbRecovery.cjs')
const watch = require('../../../src/main/external-db-watch.js')

const win32 = process.platform === 'win32'
const sleep = ms => new Promise(r => setTimeout(r, ms))

function sandbox (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w7-' + tag + '-'))
}

async function withHome (home, fn) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return await fn() } finally { Object.assign(process.env, old) }
}

// ---------- P1: validateTarget realpath containment (junction) ----------

test('validateTarget rejects a junction that lexically sits outside but resolves inside the source data dir', { skip: !win32 }, async () => {
  const home = sandbox('junction')
  const src = path.join(home, 'src-data')
  fs.mkdirSync(src)
  fs.writeFileSync(path.join(src, 'todos.db'), 'x')
  fs.writeFileSync(path.join(src, 'db.key'), 'k')
  // The OneDrive-shaped hazard: a real directory INSIDE the source subtree, reached through a
  // junction that lives OUTSIDE it — every lexical check passes, only realpath sees the truth.
  const inside = path.join(src, 'sub')
  fs.mkdirSync(inside)
  const link = path.join(home, 'outside-link')
  fs.symlinkSync(inside, link, 'junction')
  const res = dl.validateTarget(link, src)
  assert.equal(res.ok, false, JSON.stringify(res))
  assert.match(res.reason, /resolves inside/)
})

test('validateTarget still accepts a plain sibling directory (no false positive from the realpath guard)', async () => {
  const home = sandbox('plain-target')
  const src = path.join(home, 'src-data')
  fs.mkdirSync(src)
  const tgt = path.join(home, 'tgt')
  const res = dl.validateTarget(tgt, src, { freeBytes: 1024 * 1024 * 1024 })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.target, path.resolve(tgt))
})

// ---------- P1: writeBootRedirect durable contract ----------

test('writeBootRedirect: durable write (tmp→fsync→rename contract) leaves no residue and round-trips', async () => {
  const home = sandbox('boot-durable')
  await withHome(home, async () => {
    const dir = path.join(home, 'ud')
    fs.mkdirSync(dir)
    dl.writeBootRedirect(dir)
    // Contract (durable-fs.writeFileDurable, dbRecovery.cjs:201-211 shape): the content hits the
    // disk via fsync BEFORE the rename, and on any failure the tmp is removed + error rethrown.
    // Behavioral assertions here: correct content published at the final path, and no tmp residue
    // (neither the legacy .tmp- nor the durable .dtmp suffix) next to the boot file.
    assert.equal(dl.readBootRedirect(), dir)
    const raw = JSON.parse(fs.readFileSync(dl.bootRedirectPath(), 'utf8'))
    assert.equal(raw.userDataDir, dir)
    const residue = fs.readdirSync(home).filter(f => f.includes('.tmp-') || f.endsWith('.dtmp'))
    assert.deepEqual(residue, [], 'no tmp residue after the durable rename')
  })
})

test('writeBootRedirect still rejects relative/missing dirs', async () => {
  const home = sandbox('boot-invalid')
  await withHome(home, async () => {
    assert.throws(() => dl.writeBootRedirect('relative/dir'))
    assert.throws(() => dl.writeBootRedirect(null))
  })
})

// ---------- P2: migrateData reentry gate ----------

function makeSource (dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'todos.db'), Buffer.alloc(4096, 7))
  fs.writeFileSync(path.join(dir, 'db.key'), 'a'.repeat(64))
  const backups = path.join(dir, 'backups')
  fs.mkdirSync(backups)
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(backups, 'b' + i + '.json'), '{"x":' + i + '}')
}

test('migrateData: a concurrent second call is refused with "migration already in progress"', async () => {
  const home = sandbox('gate-concurrent')
  await withHome(home, async () => {
    const src = path.join(home, 'src')
    const tgt = path.join(home, 'tgt')
    makeSource(src)
    const opts = { freeBytes: 1024 * 1024 * 1024 }
    const p1 = dl.migrateData(src, tgt, opts)
    // p1 is in-flight: it copies 20 backup files with event-loop yields — wait past the first tick.
    await sleep(30)
    const p2 = await dl.migrateData(src, path.join(home, 'tgt2'), opts)
    assert.equal(p2.ok, false)
    assert.equal(p2.error, 'migration already in progress')
    const r1 = await p1
    assert.equal(r1.ok, true, JSON.stringify(r1))
    // relocationPending (module-level, lives until relaunch) now refuses any further call too.
    const p3 = await dl.migrateData(src, path.join(home, 'tgt3'), opts)
    assert.equal(p3.ok, false)
    assert.equal(p3.error, 'migration already in progress')
  })
})

// ---------- P2: encryptedProbe / attemptDbRecovery with a truncated db.key ----------

test('attemptDbRecovery: truncated (non-64-hex) db.key → conservative no-rename, no .corrupt-* created', async () => {
  const ud = sandbox('truncated-key')
  // Bad-header db (would look corrupt to the header guard) + a READABLE but truncated key +
  // a parseable critical backup (so the old 'no' verdict used to drive the full rename path).
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.from('THIS IS NOT A SQLITE DATABASE FILE....'))
  fs.writeFileSync(path.join(ud, 'db.key'), 'a'.repeat(32)) // truncated 64-hex key
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({
    backup: { todoState: JSON.stringify({ todoList: [{ taskId: 't1', title: 'x' }], recycleList: [] }) }
  }))
  const res = dbr.attemptDbRecovery(ud)
  // db.js treats a non-64-hex key as keyless (plaintext continuation), so the probe cannot call
  // this db corrupt — aligned verdict is 'unknown' → recovery declines (transient), no rename.
  assert.ok(res, 'structured result expected')
  assert.equal(res.source, 'transient', JSON.stringify(res))
  assert.match(res.label, /declined|no rename|decrypt probe/i)
  const leftovers = fs.readdirSync(ud).filter(f => f.includes('.corrupt-'))
  assert.deepEqual(leftovers, [], 'no .corrupt-* rename may fire on an unclassifiable key')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db')), true, 'todos.db untouched')
})

// ---------- P2: external-db-watch debounce-failure baseline rollback ----------

function makeWatchDeps (dir, scheduler) {
  const noop = () => {}
  return {
    app: { getPath: () => dir },
    log: { info: noop, warn: noop, error: noop },
    dbm: { call: () => null },
    fixUtil: {
      stableRead: fn => fn(),
      tryForwardTomatoCmd: () => ({})
    },
    extWatchGate: { canPoll: () => true },
    nextWatchBaseline: (oldV, read) => read() ?? oldV,
    scheduler: { reloadAll: scheduler },
    getMainWindow: () => null,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: noop,
    broadcastTomatoRecordsChanged: noop,
    BrowserWindow: { getAllWindows: () => [] }
  }
}

test('external-db-watch: a failing debounce handler rolls the baseline back — the next poll re-processes the same change', async () => {
  const dir = sandbox('watch-rollback')
  const dbFile = path.join(dir, 'todos.db')
  fs.writeFileSync(dbFile, 'x')
  const t0 = Date.now() - 10_000
  fs.utimesSync(dbFile, new Date(t0), new Date(t0)) // setup baseline

  let reloadCalls = 0
  let failFirst = true
  const scheduler = () => {
    reloadCalls++
    if (failFirst) throw new Error('simulated reload failure')
  }
  const api = watch.createExternalDbWatch(makeWatchDeps(dir, scheduler))
  api.watchDbForExternalWrites()

  // An external write advances the mtime; the poll sees the change and schedules the kick.
  const t1 = new Date()
  fs.utimesSync(dbFile, t1, t1)
  api.__pollChangeForTests()
  await sleep(300) // debounce (150ms) fires; reloadAll throws → baseline must roll back, not consume
  assert.equal(reloadCalls, 1, 'first debounce handler ran (and failed)')

  failFirst = false
  api.__pollChangeForTests() // same on-disk mtime; a consumed baseline would skip — rolled-back one re-kicks
  await sleep(300)
  assert.equal(reloadCalls, 2, 'the external write was NOT consumed: the next poll re-triggered the reload')

  api.stopForQuit()
})

test('external-db-watch: a succeeding debounce handler still re-baselines (no reload loop)', async () => {
  const dir = sandbox('watch-ok')
  const dbFile = path.join(dir, 'todos.db')
  fs.writeFileSync(dbFile, 'x')
  fs.utimesSync(dbFile, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000))
  let reloadCalls = 0
  const api = watch.createExternalDbWatch(makeWatchDeps(dir, () => { reloadCalls++ }))
  api.watchDbForExternalWrites()
  fs.utimesSync(dbFile, new Date(), new Date())
  api.__pollChangeForTests()
  await sleep(300)
  assert.equal(reloadCalls, 1)
  api.__pollChangeForTests() // mtime === re-baselined value → no new kick
  await sleep(300)
  assert.equal(reloadCalls, 1, 'success path absorbs its own echo exactly as before')
  api.stopForQuit()
})

// ---------- P3: requiredFiles additions ----------

test('requiredFiles: recovery-critical side files migrate; absent ones are not minted', async () => {
  const withAll = sandbox('req-all')
  for (const f of ['todos.db', 'db.key', 'recovery-pending.json', 'renderer-crash-relaunch-count.json', 'critical-state-backup.json']) {
    fs.writeFileSync(path.join(withAll, f), 'x')
  }
  const names = dl.requiredFiles(withAll)
  for (const f of ['recovery-pending.json', 'renderer-crash-relaunch-count.json', 'critical-state-backup.json']) {
    assert.ok(names.includes(f), f + ' must be in the migration set')
  }
  const bare = sandbox('req-bare')
  fs.writeFileSync(path.join(bare, 'todos.db'), 'x')
  const bareNames = dl.requiredFiles(bare)
  for (const f of ['recovery-pending.json', 'renderer-crash-relaunch-count.json', 'critical-state-backup.json']) {
    assert.ok(!bareNames.includes(f), f + ' must not be minted when absent in the source')
  }
})

// ---------- P3: sweepEmptyCriticalBackups ----------

test('sweepEmptyCriticalBackups keeps the newest 5 empty-* side files and sweeps older ones', () => {
  const ud = sandbox('sweep-empty')
  for (let ts = 1000; ts <= 8000; ts += 1000) {
    fs.writeFileSync(path.join(ud, 'critical-state-backup.empty-' + ts + '.json'), '{}')
  }
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{"backup":{}}') // never touched
  const swept = dbr.sweepEmptyCriticalBackups(ud)
  assert.equal(swept, 3)
  const left = fs.readdirSync(ud).filter(f => f.startsWith('critical-state-backup.empty-')).sort()
  assert.deepEqual(left, [
    'critical-state-backup.empty-4000.json', 'critical-state-backup.empty-5000.json',
    'critical-state-backup.empty-6000.json', 'critical-state-backup.empty-7000.json',
    'critical-state-backup.empty-8000.json'
  ], 'the 5 newest survive')
  assert.equal(fs.existsSync(path.join(ud, 'critical-state-backup.json')), true)
})

test('sweepEmptyCriticalBackups: custom keep count and empty dir tolerance', () => {
  const ud = sandbox('sweep-custom')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.empty-1.json'), '{}')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.empty-2.json'), '{}')
  assert.equal(dbr.sweepEmptyCriticalBackups(ud, 1), 1)
  assert.deepEqual(fs.readdirSync(ud).filter(f => f.includes('.empty-')), ['critical-state-backup.empty-2.json'])
  const empty = sandbox('sweep-none')
  assert.equal(dbr.sweepEmptyCriticalBackups(empty), 0)
})

test('sweepPendingDeletes reaches the empty-backup sweep (startup mount point without index.js changes)', () => {
  const ud = sandbox('sweep-mount')
  for (let ts = 1; ts <= 6; ts++) fs.writeFileSync(path.join(ud, 'critical-state-backup.empty-' + ts + '.json'), '{}')
  fs.writeFileSync(path.join(ud, 'pending-delete-123-abc'), 'x')
  const swept = dbr.sweepPendingDeletes(ud)
  assert.equal(swept, 2, '1 pending-delete + 1 surplus empty backup')
  assert.equal(fs.existsSync(path.join(ud, 'pending-delete-123-abc')), false)
  assert.equal(fs.readdirSync(ud).filter(f => f.includes('.empty-')).length, 5, 'keep-5 held via the mounted chain')
})
