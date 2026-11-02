/* W28 maintenance round (2026-11-01) — five small P2/P3 fixes, one regression test each:
 *   1. data-location.cjs migrateData: written.push(d) now happens BEFORE copyDirRecursive, so a
 *      mid-copy throw leaves the half-copied target tree inside `written` and the catch's rollback
 *      removes it (previously: orphan half-tree residue next to the user's data).
 *   2. shared/sort-core.mjs nextSort: an all-zero sort list (sort=0 is a legal stored value from
 *      legacy restores/imports) is NOT an empty list — explicit null/undefined check gates the
 *      1024 baseline, so a bottom-append lands at minS-512 (below the zeros), not on top.
 *   3. db-stats-ops.js statsByDay: the completion-day BETWEEN keys must use the SAME explicit +8
 *      convention as the SQL strftime keys — plain dayjs format used the MACHINE-LOCAL timezone,
 *      silently mis-daying completions on non-+8 machines. Test runs under TZ=Etc/GMT-13 (UTC+13).
 *   4. db.js bumpSnow pruning: the per-bump COUNT uses ordered-bounds (key >= 'snowDedup:' AND
 *      key < 'snowDedup;') instead of a full-table LIKE — same rows (every snowDedup key has ':'
 *      at the ';' comparison position), B-tree range scan instead of linear-in-DB-size scan.
 *   5. external-db-watch.js kick: the gate-closed early return inside the debounce must roll the
 *      mtime baseline back (like the catch branch) — otherwise a write landing inside the flush
 *      window is silently consumed (lastMtime already advanced in onChange).
 * Run: node --test tests/unit/main/w28-maintenance-fixes.test.mjs
 */

// Fix 3 needs a machine timezone that is AHEAD of the app's fixed UTC+8 so the local-vs-+8
// key split becomes observable. Must be set before any Date/dayjs work in this file. node --test
// runs each file in its own process, so this cannot leak into other test files.
process.env.TZ = 'Etc/GMT-13' // POSIX-inverted name = UTC+13

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

/* ================= 1. data-location: rollback covers a half-copied dir tree ================= */

const dl = require_('../../../src/main/data-location.cjs')

function sandbox (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w28-' + tag + '-'))
}

async function withHome (home, fn) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try { return await fn() } finally { Object.assign(process.env, old) }
}

function makeSource (root) {
  const src = path.join(root, 'src-ud')
  fs.mkdirSync(path.join(src, 'backups'), { recursive: true })
  fs.writeFileSync(path.join(src, 'todos.db'), 'SQLITE-DATA')
  fs.writeFileSync(path.join(src, 'db.key'), 'a'.repeat(64))
  fs.writeFileSync(path.join(src, 'config.json'), '{}')
  fs.writeFileSync(path.join(src, 'backups', 'b1.json'), '{}')
  fs.writeFileSync(path.join(src, 'backups', 'b2.json'), '{}')
  return src
}

test('w28[1]: a copy failure mid-dir-tree leaves NO orphan half-tree in the target', async () => {
  dl._resetRelocationGatesForTests()
  const home = sandbox('home')
  await withHome(home, async () => {
    const root = sandbox('reloc')
    const src = makeSource(root)
    const target = path.join(root, 'target')
    const realCopy = fs.copyFileSync
    // Throw on the SECOND backup file: b1.json is already copied when the failure lands —
    // exactly the mid-tree torn state. Red before the fix: written.push ran only AFTER
    // copyDirRecursive returned, so the catch's rollback skipped the half-copied backups/
    // tree and target/backups/b1.json survived as an orphan.
    fs.copyFileSync = (s, d) => {
      if (String(d).endsWith('b2.json')) throw new Error('w28 injected mid-copy failure')
      return realCopy(s, d)
    }
    let r
    try { r = await dl.migrateData(src, target) } finally { fs.copyFileSync = realCopy }
    assert.equal(r.ok, false, 'migration reports the failure')
    assert.match(r.error, /w28 injected mid-copy failure/)
    assert.equal(fs.existsSync(path.join(target, 'backups')), false,
      'red before the fix: the half-copied backups tree must be rolled back, not orphaned')
    // and the target is clean enough to retry: no stray content at all
    if (fs.existsSync(target)) {
      assert.deepEqual(fs.readdirSync(target), [], 'target holds nothing after rollback')
    }
  })
})

/* ================= 2. sort-core: all-zero list is not an empty list ================= */

const { nextSort } = await import('../../../shared/sort-core.mjs')

test('w28[2]: nextSort treats an all-zero sort list as non-empty (bottom-append goes BELOW the zeros)', () => {
  assert.equal(nextSort(false, 0, 0), Math.fround(0 - 512),
    'red before the fix: !0 && !0 fell into the 1024 baseline, putting the new bottom task on TOP')
  assert.equal(nextSort(true, 0, 0), Math.fround(0 + 512), 'top-append goes above the zeros')
  assert.equal(nextSort(false, null, null), 1024, 'a genuinely EMPTY list still gets the 1024 baseline')
  assert.equal(nextSort(false, undefined, undefined), 1024, 'undefined likewise')
  assert.equal(nextSort(true, 5, 100), Math.fround(612), 'normal max+512 unchanged')
  assert.equal(nextSort(false, 5, 100), Math.fround(-507), 'normal min-512 unchanged')
})

/* ================= 3. statsByDay completion-day keys use the SQL's +8 convention ================= */

const statsOps = require_('../../../src/main/db-stats-ops.js')

test('w28[3]: completion-day BETWEEN keys follow the +8 convention, not machine-local (+13 machine)', () => {
  // sanity: the test process really is on UTC+13, ahead of the app's fixed +8
  assert.equal(-new Date().getTimezoneOffset(), 780, 'TZ=Etc/GMT-13 must be honored for the split to be observable')
  const captured = []
  const fakeDb = {
    prepare: () => ({ all: (...binds) => { captured.push(binds); return [] } })
  }
  statsOps.statsByDay(fakeDb, { from: 20261101, to: 20261101 })
  // First captured statement = the scheduledDay window (ms, timezone-free); second = the
  // completion-day key window. On a UTC+13 machine: local midnight of Nov 1 renders as
  // Oct 31 19:00 in +8, and end of the local day (Nov 1 23:59:59.999+13) renders as
  // Nov 1 18:59 in +8 — so the +8 key window is [20261031, 20261101].
  assert.equal(captured.length, 2, 'both statements ran')
  const keyBinds = captured[1]
  assert.deepEqual(keyBinds, [20261031, 20261101],
    'red before the fix: machine-local keys [20261101, 20261101] dropped the +8-Oct-31 tail of the queried local day')
})

/* ================= 4. bumpSnow pruning COUNT: ordered bounds, same rows, no full scan ================= */

test('w28[4a]: the ordered-bounds range counts exactly the snowDedup rows the LIKE did (including keys with chars > \';\')', () => {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  const ins = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
  // 'zzz' sorts past ';' — a naive bounds translation could drop it; every real key has ':'
  // (0x3A) at the comparison position, so the ';' upper bound must still include it.
  ins.run('snowDedup:task1:zzz', '1')
  ins.run('snowDedup:task2:x', '1')
  ins.run('snowDedup:task3', '1')
  ins.run('otherKey', '1')
  ins.run('snowDedux:impostor', '1')
  const like = db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'snowDedup:%'").get().n
  const bounds = db.prepare("SELECT COUNT(*) n FROM meta WHERE key >= 'snowDedup:' AND key < 'snowDedup;'").get().n
  assert.equal(like, 3)
  assert.equal(bounds, 3, 'bounds range must be row-for-row identical to the LIKE scan')
  db.close()
})

test('w28[4b]: bumpSnow dedup end-to-end still works after the pruning COUNT change', () => {
  const dbmod = require_('../../../src/main/db.js')
  const dir = sandbox('bumpsnow')
  dbmod.init(dir)
  try {
    const t = { taskId: 'w28_bump', taskContent: 'x', categoryId: null, complete: false, deleted: false }
    assert.equal(dbmod.call('upsert', t).ok !== false, true, 'seed task')
    const first = dbmod.call('bumpSnow', { taskId: 'w28_bump', minutes: 25, dedupKey: 'sess-1' })
    assert.deepEqual(first, { ok: true, minutes: 25 })
    const replay = dbmod.call('bumpSnow', { taskId: 'w28_bump', minutes: 25, dedupKey: 'sess-1' })
    assert.deepEqual(replay, { ok: true, minutes: 0, deduped: true }, 'replay with the same dedupKey is fenced')
    const fresh = dbmod.call('bumpSnow', { taskId: 'w28_bump', minutes: 25, dedupKey: 'sess-2' })
    assert.deepEqual(fresh, { ok: true, minutes: 25 }, 'a different dedupKey still credits')
  } finally {
    try { dbmod.close() } catch { /* best-effort */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ================= 5. external-db-watch: gate-closed debounce rolls the baseline back ================= */

const { createExternalDbWatch } = require_('../../../src/main/external-db-watch.js')
const fixUtil = require_('../../../src/main/fix-util.js')

test('w28[5]: an external write landing in the quit flush window is re-processed after the gate reopens', async () => {
  const dir = sandbox('watch')
  fs.writeFileSync(path.join(dir, 'todos.db'), 'x')
  let gateOpen = true
  let reloads = 0
  const deps = {
    app: { getPath: () => dir },
    log: { warn: () => {}, info: () => {}, error: () => {} },
    dbm: { call: () => null },
    fixUtil,
    extWatchGate: { canPoll: () => gateOpen },
    nextWatchBaseline: (cur, read) => { const m = read(); return m == null ? cur : m },
    scheduler: { reloadAll: () => { reloads++ } },
    getMainWindow: () => null,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    broadcastTomatoRecordsChanged: () => {},
    BrowserWindow: { getAllWindows: () => [] }
  }
  const api = createExternalDbWatch(deps)
  api.watchDbForExternalWrites()
  const dbFile = path.join(dir, 'todos.db')
  try {
    // Tick 1: arm the baseline at mtime A (arm-only, no kick).
    const t0 = Date.now() / 1000 - 100
    fs.utimesSync(dbFile, t0, t0)
    api.__pollChangeForTests()
    assert.equal(reloads, 0, 'baseline arming must not kick')
    // Tick 2: external write (mtime B) while the gate is OPEN — onChange advances the baseline
    // and kick arms its 150ms debounce.
    const t1 = Date.now() / 1000 - 50
    fs.utimesSync(dbFile, t1, t1)
    api.__pollChangeForTests()
    assert.equal(reloads, 0, 'debounce has not fired yet')
    // The gate closes (quit chain started) BEFORE the debounce fires.
    gateOpen = false
    await new Promise(r => setTimeout(r, 250))
    assert.equal(reloads, 0, 'flush window: no reload against the closed gate')
    // The gate reopens (quit aborted / window re-shown). Red before the fix: the gate-closed
    // return left lastMtime at B, so the same external write was consumed forever.
    gateOpen = true
    api.__pollChangeForTests()
    await new Promise(r => setTimeout(r, 250)) // re-kick goes through the 150ms debounce
    assert.equal(reloads, 1, 'red before the fix: the windowed write must be re-processed, not silently consumed')
  } finally {
    api.stopForQuit()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
