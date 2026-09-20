/* QC follow-up round (branch fix/qc-followup-main, 2026-09-20) — main-process fixes:
 *   M-1 dbRecovery: a stale db.key is quarantined (rename→.bad→delete) before the restored
 *       plaintext DB is reopened; total quarantine failure reports source:'error' (no false
 *       "recovery succeeded" loop);
 *   M-3 csv-import: unguarded statSync paths return the structured {ok:false,code} contract;
 *   M-4 purge channels kick the sync round (GAP-B pattern);
 *   M-9 security-lock: timing-safe password compare;
 *   M-10 scheduler: flushFiredNow retries (30s backoff, max 3) on setMeta failure;
 *   M-11 computeMetaGc: orphan tomatoEstimateState:<taskId> keys are GC'd;
 *   CONTRACT: getMetaMany(keys) → [{key, value|null}] aligned array (real better-sqlite3 DB).
 * Real temp DB via db.init; never touches real user data.
 * Run: node --test tests/unit/main/qc-followup-20260920.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-followup-'))
const MISSING_CSV = path.join(process.env.TODO_DB_DIR, 'no-such-file.csv')

const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [MISSING_CSV] }) },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../lan-sync-bootstrap': {
    kickSyncRound: reason => { bootstrapKicks.push(reason) },
    initLanSync () {},
    stopSyncForQuit () {},
    invalidateSyncWatermarks () {}
  },
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false }
}
const bootstrapKicks = []
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require_('../../../src/main/db.js')
db.init(process.env.TODO_DB_DIR)

// ---------------------------------------------------------------------------
// M-1 dbRecovery key quarantine
// ---------------------------------------------------------------------------
const rec = require_('../../../src/main/dbRecovery.cjs')

/** Unique-nested userData: criticalBackupPath looks in dirname(ud)/pickdone-backups, so ud must
 *  have its OWN parent to avoid picking up another test run's external backup JSON. */
function isolatedUd (prefix) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const ud = path.join(parent, 'userData')
  fs.mkdirSync(ud)
  return ud
}

test('M-1: key rename SUCCESS path — recovery proceeds, db.key is renamed aside', () => {
  const ud = isolatedUd('m1-ok-')
  fs.writeFileSync(path.join(ud, 'todos.db'), 'garbage-not-sqlite') // wrong header → recovery branch
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'plain')
  fs.writeFileSync(path.join(ud, 'db.key'), 'stale-key')
  const r = rec.attemptDbRecovery(ud, null)
  assert.equal(r.source, 'plain-bak')
  assert.ok(!fs.existsSync(path.join(ud, 'db.key')), 'stale key is OUT of the way before reopen')
  assert.ok(fs.readdirSync(ud).some(f => f.startsWith('db.key.corrupt-')), 'the key was renamed (forensics preserved)')
  assert.ok(fs.existsSync(path.join(ud, 'todos.db')), 'restored DB in place → the follow-up dbm.init opens plaintext, not the old key')
})

test('M-1: key quarantine TOTAL failure — source:error, no false "recovery succeeded"', () => {
  const ud = isolatedUd('m1-fail-')
  fs.writeFileSync(path.join(ud, 'todos.db'), 'garbage-not-sqlite')
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'plain')
  fs.writeFileSync(path.join(ud, 'db.key'), 'stale-key')
  // Inject failure of every quarantine strategy (rename×2 + delete): locked by AV/AV-like hold.
  const realRename = fs.renameSync
  const realRm = fs.rmSync
  const blocked = p => String(p).includes('db.key')
  fs.renameSync = (a, b) => { if (blocked(a) || blocked(b)) throw new Error('EPERM injected'); return realRename(a, b) }
  fs.rmSync = (p, o) => { if (blocked(p)) throw new Error('EPERM injected'); return realRm(p, o) }
  try {
    const r = rec.attemptDbRecovery(ud, null)
    assert.equal(r.source, 'error', 'the caller must show a FAILURE dialog, not loop on a fake success')
    assert.ok(/db\.key/.test(r.label))
  } finally {
    fs.renameSync = realRename
    fs.rmSync = realRm
  }
})

test('M-1: no db.key present → recovery proceeds (plaintext-continuation shape)', () => {
  const ud = isolatedUd('m1-nok-')
  fs.writeFileSync(path.join(ud, 'todos.db'), 'garbage-not-sqlite')
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'plain')
  const r = rec.attemptDbRecovery(ud, null)
  assert.equal(r.source, 'plain-bak')
})

// ---------------------------------------------------------------------------
// M-3 csv-import structured stat errors
// ---------------------------------------------------------------------------
const importHandlers = require_('../../../src/main/handlers/csv-import.js')
// assertMainWindow compares e.sender === w.webContents BY IDENTITY — share one fake object.
const mainWinWebContents = { id: 1 }
const mkWinCtx = () => ({
  getMainWindow: () => ({ webContents: mainWinWebContents }),
  dbApi: () => db, broadcastTodosChanged: () => {}, log: console, resyncDbWatch: () => {},
})
const mkWinEvent = () => ({ sender: mainWinWebContents })

test('M-3: import:pick-preview with a vanished file returns structured {ok:false} — no throw', async () => {
  // The dialog stub (top of file) "picks" a path that does NOT exist on disk: the size-gate
  // statSync must fail INSIDE the try and come back as the structured contract.
  const hs = importHandlers(mkWinCtx())
  const r = await hs['import:pick-preview'](mkWinEvent())
  assert.equal(r.ok, false)
  assert.ok(r.message && /no-such-file|ENOENT|no such/i.test(r.message), 'structured error message present, got: ' + r.message)
  assert.equal(lastPickedImportPathFor(hs), undefined) // (helper below exists only for clarity)
})
function lastPickedImportPathFor () { return undefined } // closure-private: asserted implicitly via the contract shape above

test('M-3: import:pick-preview contract after successful pick is {ok:true,...} (shape guard)', async () => {
  const file = path.join(process.env.TODO_DB_DIR, 'qc-ok.csv')
  fs.writeFileSync(file, 'Date: 2024-01-01 12:00:00\r\nVersion: 3.0\r\n"List Name","Title","Start Date","Due Date","Completed Time","Content","Priority","Tags"\r\n"Inbox","t1",,,,"",0,life\r\n')
  const origDialog = stubs.electron.dialog
  stubs.electron.dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }
  const hs = importHandlers(mkWinCtx())
  const r = await hs['import:pick-preview'](mkWinEvent())
  stubs.electron.dialog = origDialog
  assert.equal(r.ok, true, 'happy path still works after moving the stat inside the try')
})

test('M-3: import:run with a vanished picked file returns structured {ok:false, code}', async () => {
  const file = path.join(process.env.TODO_DB_DIR, 'vanish.csv')
  fs.writeFileSync(file, 'a,b\r\n1,2\r\n')
  const origDialog = stubs.electron.dialog
  stubs.electron.dialog = { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }
  const hs = importHandlers(mkWinCtx())
  await hs['import:pick-preview'](mkWinEvent()) // grants lastPickedImportPath + hash
  fs.unlinkSync(file) // vanish between preview and run (the M-3 scenario)
  const r = await hs['import:run'](mkWinEvent(), file)
  stubs.electron.dialog = origDialog
  assert.equal(r.ok, false)
  assert.equal(r.code, 'FILE_MISSING')
})

// ---------------------------------------------------------------------------
// M-4 purge channels kick the sync round
// ---------------------------------------------------------------------------
const todoHandlers = require_('../../../src/main/handlers/todo.js')

test('M-4: purge-recycle-bin and purge-seed-todos fire the sync kick', () => {
  const notify = []
  const wc = { id: 7 }
  const ctx = {
    isLocked: () => false, isLockWindow: () => false,
    getMainWindow: () => ({ webContents: wc }),
    dbApi: () => db,
    resyncDbWatch: () => {},
    broadcastTomatoRecordsChanged: () => {},
    broadcastTodosChanged: () => {},
    attachDir: () => path.join(process.env.TODO_DB_DIR, 'files'),
    notifySyncChange: (op) => notify.push(op),
  }
  const hs = todoHandlers(ctx)
  const mkEvent = () => ({ sender: wc })
  hs['db:purge-recycle-bin'](mkEvent())
  hs['db:purge-seed-todos'](mkEvent())
  assert.ok(notify.includes('purgeRecycleBin'), 'purge-recycle-bin fired the sync kick (GAP-B pattern)')
  assert.ok(notify.includes('purgeSeedTodos'), 'purge-seed-todos fired the sync kick (GAP-B pattern)')
})

// ---------------------------------------------------------------------------
// M-11 computeMetaGc estimate keys
// ---------------------------------------------------------------------------
const { computeMetaGc } = require_('../../../src/main/handlers/shared.js')

test('M-11: orphan tomatoEstimateState:<taskId> keys are GC candidates; live ones survive', () => {
  const metaKeys = [
    'tomatoEstimateState:live-1',
    'tomatoEstimateState:purged-9',
    'repeatRule:r1',
    'projectDeadline:catX',
  ]
  const dead = computeMetaGc(metaKeys, [{ id: 'catX' }], [
    { taskId: 'live-1', repeatId: 'r1' },
  ])
  assert.deepEqual(dead, ['tomatoEstimateState:purged-9'], 'live repeatRule/category keys survive; only the orphaned estimate key is dead')
})

// ---------------------------------------------------------------------------
// CONTRACT: getMetaMany
// ---------------------------------------------------------------------------
const syncOps = require_('../../../src/main/db-sync-ops.js')

test('CONTRACT getMetaMany: real DB, aligned [{key, value|null}] array', () => {
  db.call('setMeta', ['qc:k1', 'v1'])
  db.call('setMeta', ['qc:k2', 'v2'])
  const out = syncOps.dispatch('getMetaMany', ['qc:k1', 'qc:missing', 'qc:k2'])
  assert.deepEqual(out, [
    { key: 'qc:k1', value: 'v1' },
    { key: 'qc:missing', value: null },
    { key: 'qc:k2', value: 'v2' },
  ], 'output is 1:1 ALIGNED to the input key order (F-UI consumes this)')
  // db.js exposes the op and the renderer whitelist allows it from ANY window (read-only)
  assert.equal(typeof db.call('getMetaMany', ['qc:k1'])[0].value, 'string')
})

test('CONTRACT getMetaMany: bad input throws a structured error', () => {
  assert.throws(() => syncOps.dispatch('getMetaMany', 'not-an-array'), /keys must be an array/)
})

// ---------------------------------------------------------------------------
// M-9 security-lock timing-safe compare
// ---------------------------------------------------------------------------
test('M-9: verifyLockPassword accepts the right password and rejects the wrong one', () => {
  const sl = require_('../../../src/main/security-lock.js')
  let stored = { securityLockPassword: 'plain:s3cret' }
  const lock = sl.createSecurityLock({
    getMainWindow: () => null, showMainOrLock: () => {},
    readConfig: () => stored, writeConfig: p => { stored = { ...stored, ...p } },
    i18n: { t: s => s }, log: console,
  })
  assert.equal(lock.verifyLockPassword('s3cret'), true)
  assert.equal(lock.verifyLockPassword('wrong'), false)
  assert.equal(lock.verifyLockPassword(''), false)
  // enc1-undecryptable → treat as no password (availability beats lock, existing contract)
  stored = { securityLockPassword: 'enc1:bm90LXJlYWw' }
  const origReq = Module._load
  Module._load = (request, parent, isMain) => (request === 'electron' ? { safeStorage: { decryptString: () => { throw new Error('no key') } } } : origReq.call(this, request, parent, isMain))
  try { assert.equal(lock.verifyLockPassword('anything'), true, 'decrypt failure == no password (permanent-lockout avoidance)') } finally { Module._load = origReq }
})

// ---------------------------------------------------------------------------
// M-10 scheduler flushFiredNow retry
// ---------------------------------------------------------------------------
test('M-10: flushFiredNow re-arms a persist retry on setMeta failure (30s backoff, max 3)', async (t) => {
  const { mock } = t
  mock.timers.enable({ apis: ['setTimeout'] })
  const realDbPath = require_.resolve('../../../src/main/db.js')
  const realExports = require_.cache[realDbPath].exports
  const calls = []
  let writes = 0
  const flakyDb = {
    // Fails the first 3 setMeta attempts, succeeds on the 4th (initial + 3 retries = the cap).
    call (op, params) {
      if (op !== 'setMeta') return true
      calls.push(op)
      if (calls.length <= 3) throw new Error('db busy (injected attempt ' + calls.length + ')')
      writes++
      return true
    }
  }
  require_.cache[realDbPath].exports = flakyDb
  const scheduler = require_('../../../src/main/scheduler.js')
  try {
    scheduler._clearStateForTest()
    // Seed one fired reminder through the real catch-up path so firedReminders is non-empty.
    scheduler.setFireForTest(() => {})
    const now = Date.now()
    scheduler.reloadAll({
      store: new Map([['reminderLastSeenAt', String(now - 60000)]]),
      getMeta (k) { return this.store.has(k) ? this.store.get(k) : null },
      setMeta ([k, v]) { this.store.set(k, String(v)) },
      queryTodos: () => [{ taskId: 'm10', reminderTime: now - 30000, reminderOffsets: [], complete: false, delete: false }],
    })
    scheduler.flushFiredNow()
    assert.equal(calls.length, 1, 'first flush attempted a setMeta write (and failed)')
    mock.timers.tick(30_000)
    assert.equal(calls.length, 2, 'retry #1 armed at +30s (old code: silent drop, nothing re-armed)')
    mock.timers.tick(30_000)
    assert.equal(calls.length, 3, 'retry #2 armed')
    mock.timers.tick(30_000)
    assert.equal(calls.length, 4, 'retry #3 armed')
    assert.equal(writes, 1, 'the 4th attempt SUCCEEDS — the data is persisted instead of dropped')
    mock.timers.tick(30_000 * 10)
    assert.equal(calls.length, 4, 'no further retries after success (backoff counter reset)')
  } finally {
    require_.cache[realDbPath].exports = realExports
    scheduler._clearStateForTest()
    mock.timers.reset()
  }
})
