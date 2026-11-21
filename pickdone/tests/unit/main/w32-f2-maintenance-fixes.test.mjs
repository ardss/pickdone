/* W32 F2 maintenance-round regression tests (fix agent F2, 2026-11-03).
 *
 *   #1 [P2] handlers/system.js data:relocate success path ran app.relaunch()+app.exit(0)
 *      OUTSIDE the quit chain: after dbm.close() the migration window (minutes) + the 400ms
 *      exit timer kept the LAN sync server / in-flight rounds / relay poller alive, writing
 *      watermarks and cursors against the CLOSED handle. Fix: stopSyncForQuit() + relay
 *      stopForQuit() fire BEFORE dbm.close(), mirroring updater.js preInstallSyncSettle's
 *      W16 ordering.
 *   #2 [P2] db-recovery-restore.cjs criticalBackupRowCount counted ONLY todoState rows — a
 *      legitimate "user deleted every task" snapshot carrying newer metaState/filter/plan
 *      rows was judged EMPTY and quarantined to a side file (only 5 kept), pinning the main
 *      recovery source at the pre-deletion state forever. Fix: empty means ALL consumed
 *      segments empty.
 *   #3 [P2] relay-sync-adapter.js enable() rebind guard leaked on a falsy priorBaseUrl: with
 *      a registered DEVICE_SECRET and an empty recorded origin, a different origin was
 *      accepted and the old bearer + cursor shipped to the new host. Fix: DEVICE_SECRET with
 *      no priorBaseUrl also refuses (explicit forget required).
 *   #4 [P3] handlers/system.js allowWithinRatePerSender: the "drained window" map-entry
 *      delete was dead code (allowWithinRate always pushes on allow; a refusal leaves the
 *      window non-empty) — the dead branch is removed, cleanup owned by the size>64 sweep.
 *
 * Run: node --test tests/unit/main/w32-f2-maintenance-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')

// ---------------------------------------------------------------------------
// Fixture #1/#4: sandbox copy of src/main with stubbed bootstrap + data-location
// modules, exercising the REAL handlers/system.js (same pattern as
// w29-relocate-closefail-watch.test.mjs).
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-f2-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(UD, { recursive: true })
const TARGET = path.join(TMP, 'target')

const captured = {}
const relayCalls = { relaunch: 0, exit: 0 }
const ELECTRON_STUB = {
  app: {
    getPath: () => UD,
    getVersion: () => '0.0.0-test',
    relaunch: () => { relayCalls.relaunch++ },
    exit: () => { relayCalls.exit++ },
  },
  dialog: {
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBoxSync: () => 0,
    showErrorBox: () => {},
  },
  Notification () { return { show: () => {}, on: () => {} } },
  shell: { openExternal: async () => {}, openPath: () => {} },
  protocol: { handle: (scheme, cb) => { captured[scheme] = cb } },
  BrowserWindow () { return {} },
}
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {}, hooks: [], transports: { file: {}, console: {} } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  if (request === 'electron-updater') {
    return { autoUpdater: { on: () => {}, checkForUpdates: async () => ({}), setFeedURL: () => {}, quitAndInstall: () => {} } }
  }
  if (request.endsWith('shortcut-defaults.mjs')) {
    return { DEFAULT_SHORTCUT_SETTINGS: {}, computeDefaultShortcutSettings: () => ({}) }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// copy the whole src/main tree so the handler's relative requires resolve inside the sandbox
fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })

// The quit-path settle order is recorded by these sandbox stubs (real bootstrap modules
// would try to open servers/DB handles). data-location is stubbed to a synchronous
// successful migration so the success path is reachable without touching the disk tree.
globalThis.__w32order = []
const order = globalThis.__w32order
fs.writeFileSync(path.join(TMP, 'src', 'main', 'lan-sync-bootstrap.js'), `
module.exports = {
  stopSyncForQuit: () => { globalThis.__w32order.push('lanStop'); return Promise.resolve() },
}
`)
fs.writeFileSync(path.join(TMP, 'src', 'main', 'relay-sync-bootstrap.js'), `
module.exports = {
  stopForQuit: () => { globalThis.__w32order.push('relayStop'); return Promise.resolve() },
}
`)
fs.writeFileSync(path.join(TMP, 'src', 'main', 'data-location.cjs'), `
module.exports = {
  readBootRedirect: () => null,
  volumeFreeBytes: () => 1,
  validateTarget: () => ({ ok: true }),
  migrateData: async () => ({ ok: true, target: ${JSON.stringify(TARGET)} }),
}
`)

const systemHandlers = require(path.join(TMP, 'src', 'main', 'handlers', 'system.js'))
const watchMod = require(path.join(TMP, 'src', 'main', 'external-db-watch.js'))
watchMod.stopLatestDbWatch = () => { order.push('watchStop') }
watchMod.restartLatestDbWatch = () => { order.push('watchRestart') }

// The ratchet/coverage runs set TODO_DB_DIR/TODO_USER_DATA_DIR for isolation; data:relocate
// refuses outright under them. Scrub for this process (restored on exit), same as w29.
for (const k of ['TODO_DB_DIR', 'TODO_USER_DATA_DIR']) { process.env['__w32_saved_' + k] = process.env[k]; delete process.env[k] }
process.on('exit', () => { for (const k of ['TODO_DB_DIR', 'TODO_USER_DATA_DIR']) { const v = process.env['__w32_saved_' + k]; if (v != null) process.env[k] = v; delete process.env['__w32_saved_' + k] } })

function buildCtx (dbm) {
  return {
    isLocked: () => false,
    allowWithinRate: () => true,
    i18n: { mt: (k) => k },
    app: ELECTRON_STUB.app,
    getMainWindow: () => ({ webContents: fakeSender, isDestroyed: () => false }),
    isSafeExternal: () => true,
    scheduler: { flushFiredNow: () => { order.push('flush') } },
    dbm,
  }
}
const fakeSender = { id: 7 }

test('w32 #1: relocate success stops LAN sync + relay BEFORE dbm.close() and still relaunches', async () => {
  order.length = 0
  relayCalls.relaunch = 0
  const dbm = { close: () => { order.push('close') } }
  const h = systemHandlers(buildCtx(dbm))
  const r = await h['data:relocate']({ sender: fakeSender }, { targetDir: TARGET })
  assert.equal(r.ok, true, 'the migration succeeds')
  // RED before the fix: neither stop ran at all. GREEN after: both stops precede close()
  // (and the external db-watch stop, which itself precedes them, stays first).
  const iLan = order.indexOf('lanStop')
  const iRelay = order.indexOf('relayStop')
  const iClose = order.indexOf('close')
  assert.ok(iLan !== -1, 'stopSyncForQuit was called on the relocate success path')
  assert.ok(iRelay !== -1, 'relay stopForQuit was called on the relocate success path')
  assert.ok(iClose !== -1, 'dbm.close still runs')
  assert.ok(iLan < iClose, 'LAN sync stop precedes dbm.close (W16 ordering)')
  assert.ok(iRelay < iClose, 'relay stop precedes dbm.close (W16 ordering)')
  // the 400ms relaunch timer still fires on the success path
  await new Promise(res => setTimeout(res, 600))
  assert.ok(relayCalls.relaunch >= 1, 'relocate success still relaunches into the new location')
})

test('w32 #1b: relocate close() failure still stops sync/relay first and does NOT relaunch', async () => {
  order.length = 0
  relayCalls.relaunch = 0
  const dbm = {
    close: () => { order.push('close'); throw new Error('w32 injected close failure') },
    init: () => {},
    call: () => { throw new Error('dead handle') },
  }
  const h = systemHandlers(buildCtx(dbm))
  const r = await h['data:relocate']({ sender: fakeSender }, { targetDir: TARGET })
  assert.equal(r.ok, false, 'the close failure still aborts the migration')
  const iClose = order.indexOf('close')
  assert.ok(order.indexOf('lanStop') !== -1 && order.indexOf('lanStop') < iClose, 'LAN stop precedes the failing close')
  assert.ok(order.indexOf('relayStop') !== -1 && order.indexOf('relayStop') < iClose, 'relay stop precedes the failing close')
  await new Promise(res => setTimeout(res, 600))
  assert.equal(relayCalls.relaunch, 0, 'a failed migration never relaunches')
})

// ---------------------------------------------------------------------------
// Fixture #4: the dead "drained window" branch is gone from the real source —
// allowWithinRate pushes on every allow and a refusal leaves stamps non-empty,
// so stamps.length could never be 0 there; bounded-map cleanup is owned by the
// size>64 sweep, which must stay.
// ---------------------------------------------------------------------------
test('w32 #4: dead drain-branch removed, size>64 sweep retained', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'handlers', 'system.js'), 'utf8')
  assert.ok(!/stamps\.length\) senderRateBuckets\.delete\(id\)/.test(src), 'RED before the fix: the dead delete branch was present')
  assert.ok(src.includes('senderRateBuckets.size > 64'), 'the bounded-map sweep is retained')
  assert.ok(!src.includes("senderRateBuckets.delete(id) // drained"), 'no drain-time delete remains')
  // behavior sanity: allowWithinRatePerSender still rate-gates per sender through the handler
  const h = systemHandlers(buildCtx({ close: () => {} }))
  assert.equal(typeof h['notification'], 'function')
})

// ---------------------------------------------------------------------------
// Fixture #2: db-recovery-restore.cjs (pure-with-callbacks factory) — real module.
// ---------------------------------------------------------------------------
const parseSegment = (seg) => {
  let o = seg || {}
  if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return {} } }
  return o
}
const recovery = require(path.join(ROOT, 'src', 'main', 'db-recovery-restore.cjs'))({
  parseSegment,
  criticalBackupPath: (ud) => path.join(ud, 'critical-state-backup.json'),
  logWarn: () => {},
  SUPPORTED_SCHEMA_V: 1,
  attLoss: {},
})
const RECOVERY_UD = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-recovery-'))

const dumpJson = (segments) => JSON.stringify({ backup: segments })

test('w32 #2: empty-todo snapshot WITH newer meta rows overwrites the main recovery source (no side file)', () => {
  const good = dumpJson({ todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 't1' }], recycleList: [] }) })
  const dest = path.join(RECOVERY_UD, 'critical-state-backup.json')
  fs.writeFileSync(dest, good)
  // user legally deleted every task; the snapshot still carries meta/filter/plan state
  const emptied = dumpJson({
    todoState: JSON.stringify({ schemaV: 1, todoList: [], recycleList: [] }),
    metaState: JSON.stringify({ schemaV: 1, entries: [{ key: 'repeatRule:r1', value: 'every day' }] }),
    filterState: JSON.stringify({ schemaV: 1, list: [{ id: 'f1', name: 'work' }] }),
    planState: JSON.stringify({ schemaV: 1, chips: [{ id: 'p1', taskId: 'x', day: '2026-11-03', mm: '10:00' }] }),
  })
  const out = recovery.writeCriticalStateBackupAtomic(RECOVERY_UD, emptied)
  assert.equal(out, dest, 'RED before the fix: the emptied-but-not-empty snapshot went to a side file')
  assert.equal(fs.readFileSync(dest, 'utf8'), emptied, 'the main recovery source now holds the post-deletion snapshot')
  assert.equal(fs.readdirSync(RECOVERY_UD).filter(f => f.startsWith('critical-state-backup.empty-')).length, 0, 'nothing was quarantined')
})

test('w32 #2b: a snapshot empty across ALL segments is still quarantined to the side file', () => {
  const good = dumpJson({ todoState: JSON.stringify({ schemaV: 1, todoList: [{ taskId: 't1' }], recycleList: [] }) })
  const dest = path.join(RECOVERY_UD, 'critical-state-backup.json')
  fs.writeFileSync(dest, good)
  const allEmpty = dumpJson({
    todoState: JSON.stringify({ schemaV: 1, todoList: [], recycleList: [] }),
    metaState: JSON.stringify({ schemaV: 1, entries: [] }),
    categoryState: JSON.stringify({ schemaV: 1, list: [] }),
    habitsState: JSON.stringify({ schemaV: 1, habits: [], moments: [] }),
  })
  const out = recovery.writeCriticalStateBackupAtomic(RECOVERY_UD, allEmpty)
  assert.notEqual(out, dest, 'a truly empty snapshot is still quarantined')
  assert.ok(out.includes('critical-state-backup.empty-'), 'side-file naming preserved')
  assert.equal(fs.readFileSync(dest, 'utf8'), good, 'the good source is untouched')
})

test('w32 #2c: criticalBackupRowCount counts every consumed segment', () => {
  assert.equal(recovery.criticalBackupRowCount(dumpJson({})), 0)
  assert.equal(recovery.criticalBackupRowCount(dumpJson({
    todoState: JSON.stringify({ todoList: [{}], recycleList: [{}, {}] }),
  })), 3)
  assert.ok(recovery.criticalBackupRowCount(dumpJson({
    tomatoRecords: [{ tomatoId: 'a', endTime: 1 }],
    metaState: JSON.stringify({ entries: [{ key: 'k', value: 'v' }] }),
  })) >= 2, 'bare-array + nested-string segments both count')
})

// ---------------------------------------------------------------------------
// Fixture #3: relay adapter enable() rebind guard (real module, stubbed settings).
// ---------------------------------------------------------------------------
const { createRelayAdapter } = require(path.join(ROOT, 'src', 'main', 'relay-sync-adapter.js'))

function makeAdapter (settings) {
  return createRelayAdapter({
    nodeId: 'node-w32',
    settingsGet: k => settings[k] || '',
    settingsPut: (k, v) => { settings[k] = v },
    loadStore: async () => ({}),
    log: {},
  })
}

test('w32 #3: registered DEVICE_SECRET with empty priorBaseUrl refuses a new origin (explicit forget required)', async () => {
  const settings = { account: 'acct', deviceSecret: 'sec-1', baseUrl: '' }
  const a = makeAdapter(settings)
  await assert.rejects(
    () => a.enable({ account: 'acct', baseUrl: 'http://127.0.0.1:9101' }, { deferStart: true }),
    /registered device without a recorded relay origin requires explicit forget/,
    'RED before the fix: the falsy priorBaseUrl slipped past the rebind guard',
  )
  assert.equal(settings.baseUrl, '', 'no origin was persisted by the refused enable')
})

test('w32 #3b: no DEVICE_SECRET + empty priorBaseUrl still enables (fresh enrollment path intact)', async () => {
  const settings = { account: 'acct2', baseUrl: '' }
  const a = makeAdapter(settings)
  const st = await a.enable({ account: 'acct2', baseUrl: 'http://127.0.0.1:9102' }, { deferStart: true })
  assert.equal(st.enabled, true, 'fresh enable without a device registration is untouched')
  assert.equal(settings.baseUrl, 'http://127.0.0.1:9102')
})

test('w32 #3c: set priorBaseUrl differing origin is still refused (existing branch pinned)', async () => {
  const settings = { account: 'acct3', deviceSecret: 'sec-3', baseUrl: 'http://127.0.0.1:9103' }
  const a = makeAdapter(settings)
  await assert.rejects(
    () => a.enable({ account: 'acct3', baseUrl: 'http://127.0.0.1:9104' }, { deferStart: true }),
    /different account or relay origin requires explicit forget/,
  )
})
