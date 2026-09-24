/* 2026-09-24 daily maintenance fixes (direction C) regression tests.
 * Covers: C1 encrypted-migration crash mid-state demotion probe (P0), C2 migration-loop
 * try/catch, C12 migration-failure-missing-DB throw, C3 durable-fs unique tmp names,
 * C4 scheduler firstRun on getMeta throw, C5 audit in-flight quit flush, C13 per-chunk
 * failure isolation, C7 stale .dtmp sweep, B12 statsByDay planned alignment, C14 index.js
 * row-level settings watermark (source anchor — index.js is electron-entry, not loadable here).
 * Run: node --test tests/unit/main/maint-daily-0924.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const durableFs = require_('../../../src/main/durable-fs.js')
const autoBackup = require_('../../../src/main/autoBackup.js')
const scheduler = require_('../../../src/main/scheduler.js')
const appAudit = require_('../../../src/main/audit.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')
const backupHandlers = require_('../../../src/main/handlers/backup.js')

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'maint0924-'))
const mkDir = label => fs.mkdtempSync(path.join(TMP_ROOT, label + '-'))
const HEX64 = /^[0-9a-f]{64}$/

/* ---------------- C1 (P0): plaintext todos.db + valid db.key must demote the key and boot ---------------- */

function buildPlaintextLib (dir, { withKey = true } = {}) {
  // A real plaintext todos.db with one row, plus a VALID db.key — the exact post-crash
  // intermediate state of migratePlainToEncrypted (key written before the renames).
  const Driver = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const file = path.join(dir, 'todos.db')
  const d = new Driver(file)
  d.exec(db.SCHEMA)
  d.prepare("INSERT INTO todos (id, content, complete, deleted, createdAt, updatedAt, scheduledAt, scheduledDay) VALUES ('c1task', 'C1 survivor row', 0, 0, 1, 1, 0, 0)").run()
  d.close()
  if (withKey) fs.writeFileSync(path.join(dir, 'db.key'), 'a'.repeat(64)) // valid-format but WRONG for the plaintext lib
}

test('C1: plaintext lib + valid db.key boots, demotes the key, re-encrypts, data survives', () => {
  const dir = mkDir('c1')
  buildPlaintextLib(dir)
  assert.ok(fs.existsSync(path.join(dir, 'db.key')))
  // Before the fix this init threw dbEncMismatch on the first page read and dbRecovery kept
  // reporting 'transient' (SQLite header intact) — a boot loop.
  db.init(dir)
  try {
    const row = db.call('getById', 'c1task')
    assert.ok(row && row.taskContent === 'C1 survivor row', 'data survives the demoted-key path')
    // The stale key was renamed aside, not deleted
    const superseded = fs.readdirSync(dir).filter(n => n.startsWith('db.key.superseded-'))
    assert.equal(superseded.length, 1, 'db.key demoted to db.key.superseded-<ts>')
    assert.equal(fs.readFileSync(path.join(dir, superseded[0]), 'utf8'), 'a'.repeat(64))
    // The lib re-encrypted with a FRESH key (never the demoted one)
    const newKey = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
    assert.match(newKey, HEX64, 'a fresh valid db.key exists after re-encryption')
    assert.notEqual(newKey, 'a'.repeat(64), 'the fresh key is not the demoted stale key')
    // The reopened lib really is encrypted: header no longer carries the plaintext magic
    assert.equal(dbRecovery.sqliteHeaderOk(path.join(dir, 'todos.db')), false, 'todos.db is now ciphertext')
    db.close()
    // And a restart with the new key opens cleanly (full cycle)
    db.init(dir)
    assert.ok(db.call('getById', 'c1task'))
  } finally {
    db.close()
  }
})

test('C1: a genuinely encrypted lib + its key is NOT demoted (probe false-positives guarded)', () => {
  const dir = mkDir('c1b')
  db.init(dir) // fresh install → encrypted lib + matching key
  db.call('setMeta', ['k', 'v'])
  db.close()
  db.init(dir) // restart path — the probe must leave the matching key alone
  try {
    assert.equal(db.call('getMeta', 'k'), 'v', 'encrypted lib + matching key opens normally')
    assert.equal(fs.readdirSync(dir).filter(n => n.startsWith('db.key.superseded-')).length, 0, 'no key demotion for the healthy state')
  } finally {
    db.close()
  }
})

/* ---------------- C2 (P1): a throwing migration must not keep the whole library from opening ---------------- */

test('C2: throwing migration aborts to the current version; the DB still opens and works', () => {
  const dir = mkDir('c2')
  db.init(dir)
  db.call('setMeta', ['c2marker', 'before'])
  db.close()
  db.__setMigrationsForTests([
    { v: 99, fn: () => { throw new Error('boom: injected migration failure') } }
  ])
  try {
    // Before the fix this init threw and the library was unopenable until manual surgery.
    db.init(dir)
    assert.equal(db.call('getMeta', 'c2marker'), 'before', 'existing data intact after the aborted migration')
    assert.equal(db.call('getMeta', 'schemaVersion'), '6', 'schemaVersion stopped at the last good value (99 NOT stamped)')
    db.call('setMeta', ['c2marker', 'after'])
    assert.equal(db.call('getMeta', 'c2marker'), 'after', 'the DB is writable after the abort')
  } finally {
    db.__setMigrationsForTests(null)
    db.close()
  }
})

test('C2: a false-returning migration still stops the loop without advancing (semantics unchanged)', () => {
  const dir = mkDir('c2b')
  db.init(dir)
  db.close()
  let ran = 0
  db.__setMigrationsForTests([
    { v: 98, fn: () => { ran++; return false } },
    { v: 99, fn: () => { ran++; return true } }
  ])
  try {
    db.init(dir)
    assert.equal(ran, 1, 'the loop stopped at the false-returning migration')
  } finally {
    db.__setMigrationsForTests(null)
    db.close()
  }
})

/* ---------------- C12 (P2): migration failure with todos.db still missing must throw into the recovery chain ---------------- */

test('C12: migration failed AND todos.db missing → init throws (no implicit empty-library session)', () => {
  const dir = mkDir('c12')
  // Plaintext lib WITHOUT db.key → init runs the one-time migration → the hook can fail it.
  buildPlaintextLib(dir, { withKey: false })
  // Simulate the worst crash branch: the process DIED mid-rename — todos.db gone, no .plain-bak.
  // (The hook closes the open handle first; a real crash leaves no handle at all.)
  db.__setMigrateFailHookForTests(({ file }) => {
    db.close()
    fs.rmSync(file, { force: true })
    return true
  })
  try {
    assert.throws(() => db.init(dir), /todos\.db 缺位/, 'init must throw instead of opening an implicit empty library')
    assert.equal(fs.existsSync(path.join(dir, 'todos.db')), false, 'no empty todos.db was silently created')
  } finally {
    db.__setMigrateFailHookForTests(null)
    try { fs.rmSync(path.join(dir, 'todos.db'), { force: true }) } catch { /* Windows delete-pending */ }
    db.close()
  }
})

test('C12: migration failure WITH a restorable todos.db still continues plaintext (contract unchanged)', () => {
  const dir = mkDir('c12b')
  buildPlaintextLib(dir, { withKey: false })
  // Simulate the mid-rename crash: file gone, .plain-bak present (the catch restores it).
  db.__setMigrateFailHookForTests(({ file }) => {
    fs.renameSync(file, file + '.plain-bak')
    return true
  })
  try {
    db.init(dir)
    assert.ok(db.call('getById', 'c1task'), 'plaintext continuation after restore — data survives')
  } finally {
    db.__setMigrateFailHookForTests(null)
    db.close()
  }
})

/* ---------------- C3 (P1): writeFileDurable tmp names are unique per call ---------------- */

test('C3: two writeFileDurable calls use distinct tmp paths, both ending in .dtmp', () => {
  const dir = mkDir('c3')
  const seen = []
  const fake = {
    openSync: (p) => { seen.push(String(p)); return 7 },
    writeFileSync: () => {},
    fsyncSync: () => {},
    closeSync: () => {},
    renameSync: () => {},
    existsSync: () => false
  }
  durableFs.writeFileDurable(path.join(dir, 'f.json'), '1', fake)
  durableFs.writeFileDurable(path.join(dir, 'f.json'), '2', fake)
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1], 'concurrent writers no longer share one tmp path')
  for (const p of seen) {
    assert.match(p, /\.dtmp$/, 'tmp names still end with .dtmp (C7 sweep contract)')
    assert.match(p, /\.\d+\.\d+\.\d+\.dtmp$/, 'tmp names carry pid + timestamp + sequence')
  }
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('.dtmp')).length, 0, 'no residue via the real-fs fallback either')
})

test('C3: backup.atomicWriteJson failure-cleanup targets the SAME unique tmp path', () => {
  const removed = []
  const failing = {
    writeFileSync () { throw new Error('disk full') },
    renameSync () { throw new Error('should not run') },
    existsSync: () => true,
    unlinkSync: p => removed.push(p)
  }
  const r = backupHandlers.atomicWriteJson(failing, 'D:\\dir', 'c3-x.json', '{}')
  assert.equal(r.ok, false)
  assert.match(r.error, /disk full/)
  assert.equal(removed.length, 1)
  assert.match(String(removed[0]), /c3-x\.json\.\d+\.\d+\.\d+\.dtmp$/, 'cleanup path matches the durable writer tmp')
})

/* ---------------- C7 (P2): the stale-tmp sweep matches .dtmp residue ---------------- */

test('C7: selectStaleTmp picks old .dtmp residue (unique and legacy) plus legacy .tmp-*, skips fresh files', () => {
  const now = 1e12
  const old = now - 2 * 60 * 60 * 1000
  const fresh = now - 1000
  const picked = autoBackup.selectStaleTmp([
    { name: 'auto-20260901-120000.json.123.456.dtmp', mtimeMs: old }, // C3-style unique residue
    { name: 'auto-20260901-120001.json.dtmp', mtimeMs: old },         // legacy fixed-name residue
    { name: '.tmp-auto-20260901-120002.json', mtimeMs: old },         // historical spelling
    { name: 'evt-r-20260901-120003.json.123.456.dtmp', mtimeMs: fresh }, // in-flight write — never swept
    { name: 'auto-20260901-120004.json', mtimeMs: old }               // real backup — never swept
  ], { now })
  assert.deepEqual(picked.sort(), [
    '.tmp-auto-20260901-120002.json',
    'auto-20260901-120001.json.dtmp',
    'auto-20260901-120000.json.123.456.dtmp'
  ].sort())
})

/* ---------------- C4 (P1): a throwing getMeta counts as first run (no historical bombardment) ---------------- */

test('C4: reloadAll with a throwing getMeta does not catch-up-fire history', () => {
  scheduler._clearStateForTest()
  const fired = []
  scheduler.setFireForTest((t) => fired.push(t.taskId))
  const now = Date.now()
  const db = {
    getMeta () { throw new Error('db transiently unavailable') },
    setMeta ([k, v]) { this.store.set(k, String(v)) },
    store: new Map(),
    queryTodos () {
      return [{ taskId: 'hist', reminderTime: now - 86400000, reminderOffsets: [], complete: false, delete: false }]
    }
  }
  scheduler.reloadAll(db)
  assert.deepEqual(fired, [], 'first-run semantics on read failure: no catch-up bombardment')
  assert.ok(db.store.get('reminderLastSeenAt'), 'watermark is written so history never re-fires later')
})

/* ---------------- C5 (P1): flushNow sync-writes in-flight async batches ---------------- */

test('C5: entries already handed to the async writer land on flushNow without waiting a tick', () => {
  const dir = mkDir('c5')
  appAudit.resetForTests()
  appAudit.setDirResolver(() => dir)
  try {
    // FLUSH_BATCH_MAX is 64: recording 64 entries triggers flushAsync immediately (async write pending)
    for (let i = 0; i < 64; i++) appAudit.recordAppOp('hardDelete', 'c5-' + i)
    // NO await / tick: flushNow must synchronously drain the registered in-flight chunk
    appAudit.flushNow()
    const text = fs.readFileSync(path.join(dir, 'cli-audit.jsonl'), 'utf8')
    const lines = text.trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 64, 'the whole in-flight batch was persisted synchronously')
    for (let i = 0; i < 64; i++) assert.ok(text.includes('"c5-' + i + '"'), 'entry c5-' + i + ' present')
  } finally {
    appAudit.resetForTests()
  }
})

/* ---------------- C13 (P2): one failed chunk does not drop the rest of the batch ---------------- */

test('C13: flushNow drops only the failing chunk; later chunks still land', () => {
  const dir = mkDir('c13')
  appAudit.resetForTests()
  appAudit.setDirResolver(() => dir)
  appAudit.setMaxBytes(1) // every line becomes its own chunk
  const realAppend = fs.appendFileSync
  const realStat = fs.statSync
  let call = 0
  try {
    appAudit.recordAppOp('hardDelete', 'c13-first')
    appAudit.recordAppOp('hardDelete', 'c13-second')
    appAudit.recordAppOp('hardDelete', 'c13-third')
    fs.statSync = () => ({ size: 0 }) // hold rotation out of the way (chunk isolation, not rotation, is under test)
    fs.appendFileSync = function (p, data, ...rest) {
      call++
      if (call === 2 || call === 3) throw new Error('EIO: injected chunk failure') // chunk 2: both attempts
      return realAppend.call(this, p, data, ...rest)
    }
    appAudit.flushNow()
  } finally {
    fs.appendFileSync = realAppend
    fs.statSync = realStat
    appAudit.setMaxBytes(5 * 1024 * 1024)
    appAudit.resetForTests()
  }
  const text = fs.readFileSync(path.join(dir, 'cli-audit.jsonl'), 'utf8')
  assert.ok(text.includes('"c13-first"'), 'chunk before the failure landed')
  assert.ok(!text.includes('"c13-second"'), 'the failing chunk alone is dropped')
  assert.ok(text.includes('"c13-third"'), 'chunks after the failure still landed (no return-and-drag)')
})

/* ---------------- B12 (P3): statsByDay planned counts todoTime-only tasks (metrics.js alignment) ---------------- */

test('B12: statsByDay planned includes scheduledDay=0 tasks whose scheduledAt falls in range', () => {
  const dir = mkDir('b12')
  db.init(dir)
  let raw = null
  try {
    const dayjs = require_('dayjs')
    const dayStart = +dayjs('2026-09-24').startOf('day')
    const midDay = dayStart + 12 * 3600 * 1000
    // Regular rows (upsert derives scheduledDay from todoTime — db-rows.todoToRow)
    db.call('upsert', { taskId: 'b12-day', taskContent: 'day', createTime: 1, updateTime: 1, todoTime: midDay })
    db.call('upsert', { taskId: 'b12-done', taskContent: 'done', complete: true, createTime: 1, updateTime: 1, todoTime: midDay })
    // Legacy/malformed shape that metrics.js already tolerates: scheduledDay=0 with a live scheduledAt.
    // No writer produces it today (todoToRow re-derives), but existing libraries carry such rows —
    // written through a second connection to bypass the re-derivation.
    const Driver = require_('../../../vendor/better-sqlite3-multiple-ciphers')
    raw = new Driver(path.join(dir, 'todos.db'))
    raw.pragma(`key='${fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()}'`)
    raw.pragma('busy_timeout = 5000')
    const ins = raw.prepare("INSERT INTO todos (id, content, complete, deleted, createdAt, updatedAt, scheduledAt, scheduledDay) VALUES (?, 'tt', 0, 0, 1, 1, ?, 0)")
    ins.run('b12-todotime', midDay)
    ins.run('b12-otherday', midDay + 5 * 86400000) // todoTime-only but outside the queried range
    const r = db.call('statsByDay', { from: '20260924', to: '20260924' })
    const row = r.rows.find(x => x.ds === dayStart)
    assert.ok(row, 'a row exists for the day')
    assert.equal(row.total, 3, 'planned = scheduledDay rows + todoTime-only row')
    assert.equal(row.done, 1, 'done counted once')
    assert.equal(r.rows.find(x => x.ds === dayStart + 5 * 86400000), undefined, 'out-of-range todoTime not counted')
  } finally {
    try { if (raw) raw.close() } catch {}
    db.close()
  }
})

/* ---------------- C14 (P2): index.js settings hot-sync uses the row-level watermark (source anchor) ---------------- */

test('C14: index.js hot-sync watermark covers settings_rows row updatedAt (source anchor)', () => {
  // index.js is electron-entry and cannot be required under plain node (project precedent:
  // d6-sync-fixes/d4 assert the wiring statically). Anchor the exact semantics, not just keywords.
  const src = fs.readFileSync(new URL('../../../src/main/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("dbm.call('settingsRowsAll')"), 'the poll reads the row-level settings truth')
  assert.match(src, /for \(const r of rows\) \{ const u = Number\(r && r\.updatedAt\) \|\| 0; if \(u > at\) at = u \}/, 'row updatedAt feeds the watermark')
  assert.match(src, /if \(doc && at > lastSettingsSavedAt\)/, 'the diff gate compares the combined watermark, not the blob stamp alone')
  assert.ok(!/const at = \(doc && doc\._savedAt\) \|\| 0\s*\n\s*if \(at > lastSettingsSavedAt\)/.test(src), 'the blob stamp alone no longer gates the diff')
})
