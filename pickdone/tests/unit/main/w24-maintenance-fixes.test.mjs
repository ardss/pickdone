/**
 * feat/w24-maintenance round (2026-10-31) — four regressions, one file:
 *  [1] P1 db-enc-copy: the clone-path DDL rewrite only matched bare `CREATE TABLE`, but every
 *      sqlite_master.sql this app produces is `CREATE TABLE IF NOT EXISTS x (...)` — the rewrite
 *      emitted `CREATE TABLE IF NOT EXISTS enc.IF NOT EXISTS "x"` (parse error, swallowed), so
 *      legacy tables were silently NEVER cloned into the enc DB while migration reported success.
 *  [2] P2 protocol.js isLocalBookkeepingFile: the guard was prefix-shaped (`^\.att-tmp-`) while
 *      the real temp files are suffix-shaped (`<name>.att-tmp-<ts>-<rand>`, `<name>.<pid>.<ms>.<seq>.dtmp`)
 *      — the "never served" guard was dead. Now matches the suffix forms; legit attachment keys
 *      (timestamp+random minted names) contain neither marker.
 *  [3] P2 db-bulk-ops + scheduler: hardDelete pruned the firedReminders meta BLOB but the
 *      scheduler's in-memory LRU kept the deleted entries — the next flushFiredNow() re-packed
 *      the whole LRU back into meta, resurrecting the tombstoned watermark. The scheduler now
 *      owns its state: pruneFired(taskIds) drops the LRU entries, and db-bulk-ops calls it.
 *  [4] P3 quick-add toggle: comment said "visible and focused → collapse" but the code hid on
 *      isVisible alone. Now requires win.isFocused() too.
 * Run: node --test tests/unit/main/w24-maintenance-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/* ---------- [1] db-enc-copy: legacy `CREATE TABLE IF NOT EXISTS` DDL is cloned, not dropped ---------- */

test('w24[1]: a legacy IF NOT EXISTS-shaped table is cloned into enc with its data (migration no longer silently skips it)', () => {
  const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')
  const encCopyTable = require('../../../src/main/db-enc-copy.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w24-enc-'))
  const db = new Database(':memory:')
  const warns = []
  const origWarn = console.warn
  console.warn = m => warns.push(String(m))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS legacy_t (id TEXT PRIMARY KEY, note TEXT)') // the shape EVERY app table has in sqlite_master.sql
    db.prepare("INSERT INTO legacy_t VALUES ('r1', 'precious legacy row')").run()
    db.exec(`ATTACH DATABASE '${path.join(dir, 'enc.db').replace(/\\/g, '/')}' AS enc`)
    encCopyTable(db, 'legacy_t')
    const names = db.prepare('SELECT name FROM enc.sqlite_master WHERE type = ? AND name = ?').all('table', 'legacy_t')
    assert.equal(names.length, 1, 'red before the fix: the malformed rewrite threw (swallowed) and legacy_t never landed in enc')
    const rows = db.prepare('SELECT * FROM enc."legacy_t"').all()
    assert.deepEqual(rows, [{ id: 'r1', note: 'precious legacy row' }], 'the legacy data must be copied into the encrypted DB')
    // bare `CREATE TABLE` DDL (hand-built edge) still clones fine
    db.exec('CREATE TABLE bare_t (id TEXT)')
    db.prepare("INSERT INTO bare_t VALUES ('b1')").run()
    encCopyTable(db, 'bare_t')
    assert.deepEqual(db.prepare('SELECT * FROM enc."bare_t"').all(), [{ id: 'b1' }], 'bare CREATE TABLE DDL still clones')
    assert.ok(!warns.some(w => w.includes('legacy_t') && w.includes('could not create')), 'no silent warn for the legacy table')
    db.exec('DETACH DATABASE enc')
  } finally {
    console.warn = origWarn
    try { db.close() } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- [2] protocol.js isLocalBookkeepingFile: suffix-shaped tmp guards ---------- */

test('w24[2a]: real-shaped tmp residue files are bookkeeping (404), prefix guard used to miss them', () => {
  // electron stub: protocol.js's dependency chain (attachments.js) loads electron at require time
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, protocol: { handle: () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  let isLocalBookkeepingFile
  try {
    const mod = require(path.join(ROOT, 'src/main/protocol.js'))
    isLocalBookkeepingFile = mod.isLocalBookkeepingFile
  } finally {
    Module._load = origLoad
  }
  // att-transfer.js:217 / attachments.js:210 shape — SUFFIX, not prefix
  assert.equal(isLocalBookkeepingFile('report.pdf.att-tmp-1730000000000-123456'), true, 'red before the fix: the ^\\.att-tmp- guard never matched the real suffix shape')
  assert.equal(isLocalBookkeepingFile('.att-tmp-123-456'), true, 'legacy prefix-shaped residue still caught')
  // durable-fs.js shape: <file>.<pid>.<ms>.<seq>.dtmp
  assert.equal(isLocalBookkeepingFile('data.json.4321.1699999999999.7.dtmp'), true, 'dtmp suffix residue caught')
  assert.equal(isLocalBookkeepingFile('x.dtmp'), true)
  // the alias map stays guarded
  assert.equal(isLocalBookkeepingFile('aliases.json'), true)
})

test('w24[2b]: legitimate attachment names are NOT bookkeeping (no false 404)', () => {
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, protocol: { handle: () => {} } }
    return origLoad.call(this, request, parent, isMain)
  }
  let isLocalBookkeepingFile
  try {
    const mod = require(path.join(ROOT, 'src/main/protocol.js'))
    isLocalBookkeepingFile = mod.isLocalBookkeepingFile
  } finally {
    Module._load = origLoad
  }
  // saveAttachment-minted keys (<taskId>_<ts>_<name>) and conflict renames
  assert.equal(isLocalBookkeepingFile('t42_1699999999999_quarterly-report.pdf'), false)
  assert.equal(isLocalBookkeepingFile('t7_1699999999999_photo (1).png'), false)
  assert.equal(isLocalBookkeepingFile('noise-custom.mp3'), false, 'white-noise slot stays served')
  assert.equal(isLocalBookkeepingFile('myatt-tmp-notes.txt'), false, 'no dot-delimited marker: plain name with a similar substring passes')
  assert.equal(isLocalBookkeepingFile('a.dtmp.bak.png'), false, 'dtmp is anchored at end-of-name: a user file containing ".dtmp." mid-name is never misclassified')
})

/* ---------- [3] hardDelete prunes both the meta blob AND the scheduler LRU (no resurrection) ---------- */

test('w24[3]: deleting a fired-reminder task then flushing does NOT resurrect the watermark blob', () => {
  const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')
  const scheduler = require('../../../src/main/scheduler.js')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE plan_chips (taskId TEXT)')
  db.exec('CREATE TABLE todos (id TEXT PRIMARY KEY)')
  db.prepare("INSERT INTO todos VALUES ('42')").run()
  // stub the lazy requires flushFiredNow makes: db.js (call probe) + command-bus (the persist)
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() }, Notification: class { show () {} on () {} } }
    if (request === './db.js' || request.endsWith('src/main/db.js')) return { call: () => true }
    if (request === './command-bus' || request.endsWith('src/main/command-bus.js')) {
      return { commit: (_mod, _op, params) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(params[0], params[1]) }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    scheduler._clearStateForTest()
    scheduler._markFired('42:0')
    scheduler.flushFiredNow()
    let blob = db.prepare("SELECT value FROM meta WHERE key = 'firedReminders:'").get().value
    assert.ok(blob.includes('42:0'), 'baseline: the watermark was persisted')
    // hardDelete the task (db-bulk-ops prunes the blob AND, after the fix, the scheduler LRU)
    const bulk = require('../../../src/main/db-bulk-ops.js')(() => db, () => ({}))
    const deleted = bulk.hardDelete('42')
    assert.deepEqual(deleted, ['42'], 'the task row is physically deleted')
    blob = db.prepare("SELECT value FROM meta WHERE key = 'firedReminders:'").get().value
    assert.ok(!blob.includes('42:0'), 'the meta blob no longer holds the deleted task entry (pre-existing D22 prune)')
    assert.equal(scheduler._fired.has('42:0'), false, 'red before the fix: the in-memory LRU still held the deleted entry')
    // the resurrection vector: any later flush re-packs the WHOLE LRU into meta
    scheduler.flushFiredNow()
    blob = db.prepare("SELECT value FROM meta WHERE key = 'firedReminders:'").get().value
    assert.ok(!blob.includes('42:0'), 'red before the fix: flushFiredNow re-packed the stale LRU entry back into meta — the tombstoned watermark resurrected')
    // unrelated watermarks survive both the delete and the flush
    scheduler._clearStateForTest()
    scheduler._markFired('43:0')
    scheduler.flushFiredNow()
    bulk.hardDelete('42')
    scheduler.flushFiredNow()
    blob = db.prepare("SELECT value FROM meta WHERE key = 'firedReminders:'").get().value
    assert.ok(blob.includes('43:0'), 'other tasks\' watermarks are untouched by the prune')
  } finally {
    Module._load = origLoad
    scheduler._clearStateForTest()
    try { db.close() } catch { /* already closed */ }
  }
})

test('w24[3b]: scheduler.pruneFired drops exact-id and offset keys, keeps others', () => {
  const scheduler = require('../../../src/main/scheduler.js')
  scheduler._clearStateForTest()
  scheduler._markFired('7:0')
  scheduler._markFired('7:-30')
  scheduler._markFired('8:0')
  scheduler._markFired('77:0')
  scheduler.pruneFired(['7'])
  assert.equal(scheduler._fired.has('7:0'), false)
  assert.equal(scheduler._fired.has('7:-30'), false, 'offset instances of the deleted task go too')
  assert.equal(scheduler._fired.has('8:0'), true, 'other tasks untouched')
  assert.equal(scheduler._fired.has('77:0'), true, 'prefix-collision id (77 vs 7) untouched')
  scheduler._clearStateForTest()
})

/* ---------- [4] quick-add toggle: visible AND focused, per the comment ---------- */

test('w24[4]: quick-add toggle hides only when the window is visible AND focused (source shape)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/quick-add.js'), 'utf8')
  const toggleBody = src.slice(src.indexOf('function toggle ()'), src.indexOf("win.setBounds(defaultBounds())"))
  assert.ok(/!win\.isDestroyed\(\)/.test(toggleBody), 'the destroyed-window guard is kept')
  assert.ok(/win\.isVisible\(\) && win\.isFocused\(\)/.test(toggleBody), 'red before the fix: the hide branch gated on isVisible alone — an unfocused-but-visible window was hidden instead of summoned/focused')
  assert.ok(/visible and focused/i.test(toggleBody.slice(0, 200)) || /visible AND focused/i.test(src.slice(src.indexOf('/** Toggle')), src.indexOf('function toggle')) || /visible and focused/i.test(src.slice(src.lastIndexOf('/**', src.indexOf('function toggle')), src.indexOf('function toggle'))), 'comment and behavior stay aligned')
})
