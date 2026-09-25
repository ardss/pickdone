/** maint/d4 daily-maintenance regression tests (main-process data safety).
 *  Covers:
 *   - db.js plaintext→encrypted migration copies columns BY NAME (legacy ALTER-appended column order
 *     used to be positionally shifted into the wrong columns on first encrypted launch)
 *   - csv-import.js import:run aborts when the file no longer matches the previewed bytes (TOCTOU hash)
 *   - audit.js MIRROR_KEY_SKIP also skips the bare legacy 'habitsState' meta key
 *   - autoBackup.js nameToTs parses filename stamps as LOCAL time (writer used local formatting)
 *   - db.js tomato succeed coercion still lands 0/1 after dead-branch removal (no behavior change)
 *   - db-sync-schema.js migrateV6 also migrates the bare legacy 'habitsState' blob key
 *  Run: node --test tests/unit/main/d4-maint-data-safety.test.mjs */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const appAudit = require_('../../../src/main/audit.js')
const autoBackup = require_('../../../src/main/autoBackup.js')
const syncSchemaFactory = require_('../../../src/main/db-sync-schema.js')

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d4-main-'))
  process.env.TODO_DB_DIR = tmpDir
  appAudit.setDirResolver(() => tmpDir)
})

afterEach(() => {
  appAudit.resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* windows EBUSY retries below */ }
})

function auditLines () {
  appAudit.flushNow() // F-B7: entries are buffered and flushed async in production — drain before asserting
  const file = path.join(tmpDir, 'cli-audit.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function driverCtor () {
  return require_('../../../vendor/better-sqlite3-multiple-ciphers')
}

test('plaintext→encrypted migration copies columns BY NAME (legacy column order survives)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d4-mig-'))
  try {
    const Database = driverCtor()
    // Build a LEGACY-shaped todos table: important/urgent/reminders/predecessors were appended via
    // ALTER TABLE (END of the column list) on pre-v2 installs, while the current SCHEMA string has
    // important/urgent/reminders mid-table — the exact positional-mismatch scenario.
    // Full current column set, but important/urgent/reminders/predecessors appended AT THE END —
    // exactly where the historical ALTER TABLE migrations (v2/v4) put them on pre-v2 installs.
    const legacy = `CREATE TABLE todos (
      id TEXT PRIMARY KEY, userId INTEGER, content TEXT, description TEXT,
      complete INTEGER NOT NULL DEFAULT 0, completedAt INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL DEFAULT 0,
      syncTime INTEGER NOT NULL DEFAULT 0, scheduledAt INTEGER NOT NULL DEFAULT 0,
      scheduledDay INTEGER NOT NULL DEFAULT 0, remindAt INTEGER,
      sort REAL NOT NULL DEFAULT 0, focusMinutes INTEGER NOT NULL DEFAULT 0,
      difficulty INTEGER, recurGroupId TEXT, subtasks TEXT,
      imageUrls TEXT, fileAttach TEXT, categoryId INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0, deadlineTs INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'add', version INTEGER NOT NULL DEFAULT 0,
      important INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0,
      reminders TEXT, predecessors TEXT
    )`
    const d0 = new Database(path.join(dir, 'todos.db'))
    d0.exec(legacy)
    d0.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
    d0.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '6')").run()
    d0.prepare(`INSERT INTO todos (id, userId, content, complete, createdAt, updatedAt, syncTime,
      status, scheduledAt, important, urgent, reminders, predecessors)
      VALUES ('legacy1', 1, '旧库任务', 1, 111, 222, 333, 'add', 444, 1, 1, '["r1"]', '["p1"]')`).run()
    d0.close()

    const dbm = require_('../../../src/main/db.js')
    dbm.init(dir) // no db.key yet + pre-existing tables → plaintext→encrypted migration runs
    dbm.close()
    const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
    assert.ok(fs.existsSync(path.join(dir, 'todos.db') + '.plain-bak'), 'plaintext backup kept')

    const d = new Database(path.join(dir, 'todos.db'))
    d.pragma(`key='${key}'`)
    d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
    const row = d.prepare('SELECT * FROM todos WHERE id = ?').get('legacy1')
    d.close()
    assert.equal(row.content, '旧库任务')
    assert.equal(row.complete, 1)
    assert.equal(row.scheduledAt, 444, 'scheduledAt (todoTime) value lands in its own column')
    assert.equal(row.important, 1, 'important must land in the important COLUMN (positional copy shifted it)')
    assert.equal(row.urgent, 1)
    assert.equal(row.reminders, '["r1"]')
    assert.equal(row.predecessors, '["p1"]')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('tomato succeed coercion still lands 0/1 after the dead re-default branch removal', () => {
  const dbm = require_('../../../src/main/db.js')
  dbm.init(tmpDir)
  const base = Date.now()
  dbm.call('tomatoAppendMany', [{ tomatoId: 'd4s1', endTime: base, dateKey: '2026-09-19', succeed: false, manual: 1 }])
  dbm.call('tomatoAppendMany', [{ tomatoId: 'd4s2', endTime: base + 1, dateKey: '2026-09-19', succeed: 'garbage' }])
  dbm.call('tomatoAppendMany', [{ tomatoId: 'd4s3', endTime: base + 2, dateKey: '2026-09-19' }])
  const recs = dbm.call('tomatoAll', [])
  const by = Object.fromEntries(recs.map(r => [r.tomatoId, r]))
  assert.equal(by.d4s1.succeed, false, 'false → 0')
  assert.equal(by.d4s2.succeed, true, 'garbage coerces to 1 (unchanged behavior)')
  assert.equal(by.d4s3.succeed, true, 'undefined coerces to 1 (legacy default)')
  dbm.close()
})

test('import:run aborts when the file changed since the approved preview (TOCTOU hash)', async () => {
  // Stub the electron require cache entry BEFORE loading the handler module (plain-node test)
  const csvPath = require_.resolve('../../../src/main/handlers/csv-import.js')
  const csvRequire = createRequire(csvPath)
  const electronId = csvRequire.resolve('electron')
  const electronModule = require_('module')
  const csvFile = path.join(tmpDir, 'tasks.csv')
  const ticktickHeader = '"List Name","Title","Content","Is Checklist","Start Date","Due Date","Reminder","Repeat","Priority","Status","Completed Time","Order","Timezone","Is All Day"'
  fs.writeFileSync(csvFile, 'Date: 2026/09/19 08:00\nVersion: 3.0\n' + ticktickHeader + '\n"收件箱","hello","","","2026/09/20 09:00","","",,0,"0",,,1,,\n')
  const dialogTarget = csvFile
  require_(electronId) // ensure the cache entry exists (npm electron exports a path string)
  electronModule._cache[electronId].exports = {
    app: null,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [dialogTarget] }) }
  }
  const handlers = require_(csvPath)({
    getMainWindow: () => ({ webContents: wc }),
    dbApi: () => ({}),
    broadcastTodosChanged: () => {},
    log: { warn () {}, info () {}, error () {} },
    resyncDbWatch: null
  })
  const wc = { id: 1 }
  const fakeEvent = { sender: wc }

  // db init for the actual import write path
  const dbm = require_('../../../src/main/db.js')
  dbm.init(tmpDir)

  const preview = await handlers['import:pick-preview'](fakeEvent)
  assert.ok(preview.ok, 'preview succeeds: ' + (preview.message || ''))

  // Mutate the file AFTER approval → run must refuse
  fs.writeFileSync(csvFile, 'Date: 2026/09/19 08:00\nVersion: 3.0\n' + ticktickHeader + '\n"收件箱","hello CHANGED","","","2026/09/21 10:00","","",,0,"0",,,1,,\n"收件箱","EVIL","","","2026/10/01","","",,0,"0",,,1,,\n')
  // main-ipc wave (2026-09-25): the abort is now the structured { ok:false, code } contract
  // (bare throws lose the code across the context bridge) instead of a rejection.
  const abort = await handlers['import:run'](fakeEvent, csvFile)
  assert.equal(abort && abort.ok, false, 'run must abort on hash mismatch')
  assert.equal(abort && abort.code, 'HASH_MISMATCH', 'the renderer gets the structured TOCTOU code')
  const abortLine = auditLines().find(l => l.action === 'import' && /changed since preview/.test(l.note || ''))
  assert.ok(abortLine, 'an audit line records the aborted run')

  // Re-preview after the change → the CURRENT content is approved and executes cleanly
  const preview2 = await handlers['import:pick-preview'](fakeEvent)
  assert.ok(preview2.ok)
  const run = await handlers['import:run'](fakeEvent, csvFile)
  assert.ok(run && run.imported >= 2, 'run executes after a fresh approval')
  dbm.close()
})

test("audit MIRROR_KEY_SKIP also skips the bare legacy 'habitsState' meta key", () => {
  appAudit.recordAppOp('setMeta', ['habitsState', '{}'])
  appAudit.recordAppOp('setMeta', ['db.habitsState', '{}'])
  appAudit.recordAppOp('setMeta', ['someOtherKey', '{}'])
  const lines = auditLines()
  assert.equal(lines.filter(l => l.action === 'meta.set' && /habitsState/i.test(JSON.stringify(l))).length, 0,
    'neither spelling of the habits mirror blob is audited')
  assert.equal(lines.filter(l => l.action === 'meta.set' && /someOtherKey/.test(JSON.stringify(l))).length, 1)
})

test('autoBackup nameToTs parses filename stamps as LOCAL time', () => {
  const ts = autoBackup.nameToTs('auto-20260315-103000.json')
  assert.equal(ts, +new Date(2026, 2, 15, 10, 30, 0), 'must equal the LOCAL wall-clock the writer formatted')
  const evt = autoBackup.nameToTs('evt-pre-reset-20260102-030405.json')
  assert.equal(evt, +new Date(2026, 0, 2, 3, 4, 5))
})

test('db-sync-schema migrateV6 migrates the bare legacy habitsState blob key', () => {
  const mem = driverCtor()(':memory:')
  mem.exec('CREATE TABLE todos (id TEXT PRIMARY KEY)')
  mem.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  mem.prepare("INSERT INTO meta (key, value) VALUES ('habitsState', ?)")
    .run(JSON.stringify({ habitA: { name: '喝水', count: 3 } }))
  const mod = syncSchemaFactory({ getDb: () => mem, log: { warn () {}, info () {}, error () {} } })
  assert.equal(mod.migrateV6(mem), true)
  const row = mem.prepare('SELECT value FROM settings_rows WHERE key = ?').get('habitA')
  assert.ok(row, 'bare-key blob fields land in settings_rows')
  assert.deepEqual(JSON.parse(row.value), { name: '喝水', count: 3 })
  // And the bridge accepts a bare-key write too
  const OPS = { setMeta: () => true }
  const oplog = { appendOplog: () => {} }
  mod.registerOps(OPS, new Set(), oplog)
  OPS.setMeta('habitsState', JSON.stringify({ habitB: { name: '跑步' } }))
  const rowB = mem.prepare('SELECT value FROM settings_rows WHERE key = ?').get('habitB')
  assert.ok(rowB, 'bare-key setMeta bridges into settings_rows')
  mem.close()
})
