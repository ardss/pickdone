/* W15 main-process fixes (2026-10-27) — five regressions, one file:
 * [1] db.js oplog factory wiring: the onAppendFailure hook was silently swallowed by an inline
 *     // comment (2026-09-28 r3 fix regressed) — 'oplog-append-failed' syncEvents died.
 * [2] config-store: a transient lock timeout set the sticky _readFailed gate and permanently
 *     suppressed quarantineConfig — a later parse-error read (definitive corruption) never
 *     quarantined and writeConfig stayed gated forever. Quarantine is now keyed on the last
 *     RENAME failing, not on any read failure.
 * [3] db-enc-copy: an unknown (SCHEMA-外) table threw in every migratePlainToEncrypted run —
 *     the user permanently ran plaintext. Unknown tables now get an enc-side clone of the main
 *     DDL; zero-shared-column tables are skipped with a warn, never thrown.
 * [4] tomato-session: the start-transition future window was a hand-copied 60s instead of the
 *     shared STAMP_CLAMP_MS (10min) — clock-fast machines had every FSM start rejected.
 * [5] external-db-watch: a failed kick-path mtime re-read fell back to the PRE-CHANGE baseline,
 *     replaying the same external write (full reload + broadcast) on every later poll.
 * Run: node --test tests/unit/main/w15-main-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

/* ---------- [1] oplog onAppendFailure wiring ---------- */

test('w15[1a]: the db-oplog factory invokes the injected onAppendFailure hook on append failure', () => {
  const failures = []
  const oplog = require_('../../../src/main/db-oplog.js')({
    getDb: () => ({ prepare: () => { throw new Error('no such table: sync_oplog') } }),
    log: { warn: () => {}, info: () => {}, error: () => {} },
    onAppendFailure: info => failures.push(info)
  })
  oplog.appendOplog([{ entity: 'todos', entityId: 't1', ts: 123 }])
  assert.equal(oplog.oplogStats().appendFailures, 1, 'failure counted')
  assert.equal(failures.length, 1, 'red before the fix wiring: the hook must fire on append failure')
  assert.equal(failures[0].count, 1)
  assert.match(failures[0].error, /no such table/)
})

test('w15[1b]: db.js wires onAppendFailure into the oplog factory as a REAL property (not a commented line)', () => {
  const src = fs.readFileSync(new URL('../../../src/main/db.js', import.meta.url), 'utf8')
  const factoryCall = src.slice(src.indexOf("require('./db-oplog')("), src.indexOf("}), syncSchema ="))
  const hit = factoryCall.match(/^\s*onAppendFailure: info => \{.*emitOplogAppendFailure.*\}/m)
  assert.ok(hit, 'red before the fix: onAppendFailure must be a live object property of the factory argument, never commented out')
  assert.ok(factoryCall.includes('require(\'./lan-sync-bootstrap\')'), 'the hook surfaces via the lazy lan-sync-bootstrap require')
})

/* ---------- [2] config-store quarantine decoupling ---------- */

test('w15[2]: after a transient lock timeout, a later parse-error read STILL quarantines the corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w15-cfg-'))
  const cfg = require_('../../../src/main/config-store.js')
  cfg.__setConfigDir(dir)
  const cfgPath = path.join(dir, 'config.json')
  const origRead = fs.readFileSync
  fs.writeFileSync(cfgPath, JSON.stringify({ locale: 'zh' }), 'utf8')
  // Phase A: sustained EBUSY (transient exhausted) — the D14 C3 write gate engages, no quarantine.
  let mode = 'ebusy'
  fs.readFileSync = (p, enc) => {
    if (mode === 'ebusy' && String(p).endsWith('config.json')) {
      const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'
      throw e
    }
    return origRead(p, enc)
  }
  try {
    cfg.readConfig()
    assert.equal(cfg.isReadFailed(), true, 'lock timeout gates writes')
    assert.ok(!fs.existsSync(cfgPath + '.bad'), 'a lock timeout is not corruption: nothing quarantined yet')
    // Phase B: the lock is gone but the file turns out CORRUPT (parse error). The old sticky
    // gate skipped quarantine forever (no .bad, no notice, writeConfig permanently off).
    fs.writeFileSync(cfgPath, '{corrupt', 'utf8')
    mode = 'ok'
    cfg.readConfig()
    assert.ok(fs.existsSync(cfgPath + '.bad'), 'red before the fix: parse-error corruption must be quarantined even after a prior lock timeout')
    assert.ok(!fs.existsSync(cfgPath), 'the corrupt file is out of the way')
    assert.equal(cfg.isReadFailed(), false, 'successful quarantine re-opens the write gate')
    assert.equal(cfg.consumeQuarantineNotice(), true, 'the quarantine surfaces a user-visible notice')
    assert.equal(cfg.writeConfig({ locale: 'en' }).locale, 'en', 'writes resume after quarantine')
  } finally {
    fs.readFileSync = origRead
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- [3] db-enc-copy unknown-table resilience ---------- */

test('w15[3]: a table missing from the enc schema is cloned from the main DDL and copied — migration never wedges', () => {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const encCopyTable = require_('../../../src/main/db-enc-copy.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w15-enc-'))
  const db = new Database(':memory:')
  const warns = []
  const origWarn = console.warn
  console.warn = m => warns.push(String(m))
  try {
    db.exec("CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT)")
    db.exec("CREATE TABLE legacy_notes (id TEXT PRIMARY KEY, body TEXT)") // outside the current SCHEMA
    db.prepare("INSERT INTO legacy_notes VALUES ('n1', 'hello')").run()
    const encFile = path.join(dir, 'enc.db')
    db.exec(`ATTACH DATABASE '${encFile.replace(/\\/g, '/')}' AS enc`)
    db.exec('CREATE TABLE IF NOT EXISTS enc."todos" (id TEXT PRIMARY KEY, title TEXT)')
    db.prepare("INSERT INTO enc.\"todos\" VALUES ('t0', 'keep')").run()
    // red before the fix: SELECT * FROM enc.legacy_notes threw here and killed the whole migration
    encCopyTable(db, 'legacy_notes')
    const rows = db.prepare('SELECT * FROM enc."legacy_notes"').all()
    assert.deepEqual(rows, [{ id: 'n1', body: 'hello' }], 'unknown table: enc-side clone built from the main DDL, data copied')
    // empty unknown table: clone + copy must also work with zero rows
    db.exec("CREATE TABLE legacy_empty (id TEXT, v INTEGER)")
    encCopyTable(db, 'legacy_empty')
    assert.deepEqual(db.prepare('SELECT * FROM enc."legacy_empty"').all(), [], 'empty table path covered')
    // zero-shared-columns: skipped loudly, never thrown
    db.exec('CREATE TABLE odd (alpha INTEGER)')
    db.exec('CREATE TABLE IF NOT EXISTS enc."odd" (beta INTEGER)')
    encCopyTable(db, 'odd')
    assert.ok(warns.some(w => w.includes('odd') && w.includes('no columns shared')), 'zero-shared-column table: loud warn, migration continues')
    // the normal path still copies by name
    db.prepare("INSERT INTO todos VALUES ('t1', 'x')").run()
    encCopyTable(db, 'todos')
    assert.deepEqual(db.prepare('SELECT * FROM enc."todos"').all(), [{ id: 't0', title: 'keep' }, { id: 't1', title: 'x' }])
    db.exec('DETACH DATABASE enc')
  } finally {
    console.warn = origWarn
    try { db.close() } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- [4] tomato-session future clock window ---------- */

test('w15[4]: a start a few minutes in the future is ACCEPTED (10min shared clamp), far-future is rejected', () => {
  const { sessionRowFromTransition } = require_('../../../src/main/tomato-session.js')
  const base = { transition: 'start', status: 'startTomatoTime', tomatoTime: 25, restTime: 5 }
  // red before the fix: 60s window rejected this — clock-fast machines lost every focus
  const ok = sessionRowFromTransition({ ...base, startedAt: Date.now() + 5 * 60 * 1000 })
  assert.ok(ok, 'a +5min clock-skew start must be accepted (STAMP_CLAMP_MS window)')
  assert.equal(ok.status, 'startTomatoTime')
  const rejected = sessionRowFromTransition({ ...base, startedAt: Date.now() + 11 * 60 * 1000 })
  assert.equal(rejected, null, 'beyond the shared clamp window: still forged, rejected')
  const past = sessionRowFromTransition({ ...base, startedAt: Date.now() - 60 * 1000 })
  assert.ok(past, 'normal past timestamps unaffected')
})

/* ---------- [5] external-db-watch failed mtime re-read ---------- */

test('w15[5]: a failed kick-path mtime re-read does NOT resurrect the pre-change baseline (no replay loop)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w15-watch-'))
  fs.writeFileSync(path.join(dir, 'todos.db'), '')
  // Phase-driven mtime stub (call-count stubs are nondeterministic: fs.watchFile's own initial
  // stat consumes reads too). 'baseline' = real file mtime (factory init); 'change' = M2 (2000,
  // the external write); 'fail' = stable-read failure (null) while kick #1 re-baselines; 'echo'
  // = M3 (3000, the reloadAll wal write) for every later read.
  let phase = 'baseline'
  const fixUtil = { stableRead: fn => phase === 'fail' ? null : phase === 'change' ? 2000 : phase === 'echo' ? 3000 : fn() }
  let reloads = 0
  const { createExternalDbWatch } = require_('../../../src/main/external-db-watch.js')
  const w = createExternalDbWatch({
    app: { getPath: () => dir },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    dbm: { call: () => null },
    fixUtil,
    extWatchGate: { canPoll: () => true },
    nextWatchBaseline: (prev, read) => read() ?? prev,
    scheduler: { reloadAll: () => { reloads++ } },
    getMainWindow: () => null,
    isLocked: () => false,
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    broadcastTomatoRecordsChanged: () => {},
    BrowserWindow: class { static getAllWindows () { return [] } }
  })
  try {
    w.watchDbForExternalWrites()
    phase = 'change'
    w.__pollChangeForTests() // change tick: baseline -> M2, kick scheduled (150ms debounce)
    phase = 'fail'
    await new Promise(r => setTimeout(r, 300)) // kick runs; its mtime re-read FAILS -> null
    phase = 'echo'
    w.__pollChangeForTests() // next poll reads M3 (our own reloadAll echo) — must be absorbed, no re-kick
    await new Promise(r => setTimeout(r, 300)) // give any wrongly armed re-kick its debounce window
    w.__pollChangeForTests() // and the tick after that sees the same M3 — nothing further
    await new Promise(r => setTimeout(r, 300))
    assert.equal(reloads, 1, 'red before the fix: the failed re-read left the baseline stale, so every poll replayed a full reload+broadcast on our own echo (500ms replay storm); the external change is processed exactly once')
  } finally {
    w.stopForQuit()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
