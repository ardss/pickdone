/**
 * main-ipc wave (2026-09-25) — IPC gates / recovery chain / quit chain regression battery.
 * Covers:
 *   1. csv-import: isLocked gate on import:pick-preview + import:run; structured {ok:false,code}
 *      contract for USAGE / HASH_MISMATCH / FORMAT_UNKNOWN instead of bare throws.
 *   2. shortcuts: 'shortcut-capturing' sender whitelist + suppress self-heal timeout.
 *   3. dbRecovery.recoveryDialogAction: pure dialog map (recovered choice 1 must open the data
 *      dir, not just quit); declined-probe branch never renames a possibly-healthy db.
 *   4. handlers/tomato: side-effecting control channels reject non-main senders + locked state.
 *   5. quit-ack: token space is process-global (two trackers never collide).
 *   6. backup.uniqueSnapshotName: exhaustion returns null (never a taken name).
 *   7. import.allocCategoryId: bumps past taken ids (no ON-CONFLICT clobber).
 *      handlers/todo: dead `!viaBus && notifySyncChange` branches stay deleted (reads kick nothing).
 * Run: node --test tests/unit/main/dw-main-ipc-gate-wave.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

/** Load a main-process module with selected requests stubbed (electron etc.). */
function loadWithStubs (relPath, stubs) {
  const resolved = require_.resolve(path.join(ROOT, relPath))
  delete require_.cache[resolved]
  const Module = require_('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try {
    return require_(resolved)
  } finally { Module._load = origLoad }
}

function fakeWebContents () {
  const listeners = {}
  return {
    isDestroyed: () => false,
    on (ev, h) { (listeners[ev] = listeners[ev] || []).push(h) },
    removeListener (ev, h) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(h)
      if (i >= 0) arr.splice(i, 1)
    },
    emit (ev, ...args) { for (const h of [...(listeners[ev] || [])]) h(...args) },
    send (ch) { listeners.__sent = listeners.__sent || []; listeners.__sent.push(ch) },
    id: 7
  }
}

/* ---------------- 1. csv-import ---------------- */

const dialogStubData = { filePaths: [] }
const electronStub = {
  app: { isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: dialogStubData.filePaths }) },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow () { this.webContents = fakeWebContents() },
  screen: { getPrimaryDisplay: () => ({ bounds: {}, workArea: {} }), getDisplayMatching: () => ({ workArea: {} }) },
  globalShortcut: { register: () => true, unregisterAll: () => {} }
}

/** Handlers lazy-require('electron') at CALL time (dialog etc.) — a load-time-only stub is not
 *  enough. Plant a persistent stub module in the require cache for the whole test process. */
function installPersistentElectronStub () {
  try {
    const resolved = require_.resolve('electron')
    require_.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: electronStub }
  } catch { /* no real electron package installed — loadWithStubs covers it */ }
}
installPersistentElectronStub()

function loadCsvImport () {
  return loadWithStubs('src/main/handlers/csv-import.js', { electron: electronStub })
}

function csvCtx (over = {}) {
  const sender = { id: 42 }
  return {
    sender,
    ctx: Object.assign({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
      dbApi: () => ({}),
      broadcastTodosChanged: () => {},
      log: { warn () {}, info () {} },
      resyncDbWatch: () => null,
      isLocked: () => false
    }, over),
    e: { sender }
  }
}

test('csv-import: locked app rejects both import channels before any dialog/parse/write', async () => {
  const imp = loadCsvImport()
  const { ctx, e } = csvCtx({ isLocked: () => true })
  const h = imp(ctx)
  await assert.rejects(() => h['import:pick-preview'](e), /app is locked/, 'pick-preview must refuse while locked')
  // import:run without a granted path would normally throw 'path not granted' — the lock gate must fire FIRST
  await assert.rejects(() => h['import:run'](e, 'C:\\nope\\never-granted.csv'), /app is locked/, 'run must refuse while locked')
})

test('csv-import: oversized run returns structured {ok:false, code:USAGE} instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvimp-'))
  const big = path.join(dir, 'big.csv')
  fs.writeFileSync(big, 'x'.repeat(21 * 1024 * 1024))
  dialogStubData.filePaths = [big]
  const imp = loadCsvImport()
  const { ctx, e } = csvCtx()
  const h = imp(ctx)
  const preview = await h['import:pick-preview'](e)
  assert.equal(preview && preview.ok, false)
  assert.equal(preview && preview.code, 'USAGE', 'preview reports USAGE for the oversized file')
  const r = await h['import:run'](e, big)
  assert.equal(r && r.ok, false, 'run must NOT reject on the 20MB cap anymore')
  assert.equal(r && r.code, 'USAGE', 'run reports the structured USAGE code (bare throw lost the code across the context bridge)')
})

test('csv-import: hash mismatch returns structured {ok:false, code:HASH_MISMATCH} instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvimp-'))
  const csv = path.join(dir, 'tasks.csv')
  fs.writeFileSync(csv, fs.readFileSync(path.join(ROOT, 'tests/fixtures/import/ticktick-backup.csv')))
  dialogStubData.filePaths = [csv]
  const imp = loadCsvImport()
  const { ctx, e } = csvCtx()
  const h = imp(ctx)
  const preview = await h['import:pick-preview'](e)
  assert.equal(preview && preview.ok, true, 'preview must succeed against the valid ticktick fixture')
  fs.writeFileSync(csv, fs.readFileSync(path.join(ROOT, 'tests/fixtures/import/dida365-backup.csv')))
  const r = await h['import:run'](e, csv)
  assert.equal(r && r.ok, false, 'changed file must NOT reject as a bare Error anymore')
  assert.equal(r && r.code, 'HASH_MISMATCH', 'renderer gets the structured TOCTOU code')
})

test('csv-import: unrecognizable format surfaces the structured FORMAT_UNKNOWN code (preview catch path)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvimp-'))
  const csv = path.join(dir, 'weird.csv')
  fs.writeFileSync(csv, 'a,b,c\n1,2,3\n') // matches none of ticktick/dida365/todoist
  dialogStubData.filePaths = [csv]
  const imp = loadCsvImport()
  const { ctx, e } = csvCtx()
  const h = imp(ctx)
  const p = await h['import:pick-preview'](e)
  assert.equal(p && p.ok, false, 'preview must NOT reject with a bare Error')
  assert.equal(p && p.code, 'FORMAT_UNKNOWN', 'the code the renderer branches on rides the structured result')
})

/* ---------------- 2. shortcuts ---------------- */

function loadShortcuts (opts) {
  const ipcHandlers = {}
  const stub = {
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    ipcMain: { on: (ch, h) => { ipcHandlers[ch] = h } }
  }
  const mod = loadWithStubs('src/main/shortcuts.js', { electron: stub })
  return { mod, ipcHandlers }
}

function shortcutSetup (factoryOpts = {}) {
  const mainWc = fakeWebContents()
  mainWc.__sent = []
  const sent = []
  mainWc.send = (ch, ...a) => { sent.push([ch, ...a]); mainWc.__sent.push(ch) }
  const win = { isDestroyed: () => false, webContents: mainWc }
  const { mod, ipcHandlers } = loadShortcuts()
  const s = mod.createShortcuts({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    quickAdd: {},
    i18n: { mt: k => k },
    log: { warn () {}, info () {} }
  }, Object.assign({ captureSuppressMaxMs: 25 }, factoryOpts))
  s.applyShortcuts({ addEvent: 'ctrl+d' })
  return { s, ipcHandlers, win, sent, mainSender: win.webContents }
}

test('shortcuts: a non-whitelisted sender cannot raise the capture suppression', () => {
  const { ipcHandlers, win, sent } = shortcutSetup()
  const stranger = { sender: fakeWebContents() }
  ipcHandlers['shortcut-capturing'](stranger, true) // must be REJECTED (gate is MAIN WINDOW ONLY — adversarial review 2026-09-25 narrowed it; aux windows have no legitimate record surface)
  // ctrl+d must still dispatch (suppression must NOT be active)
  win.webContents.emit('before-input-event', { preventDefault () {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.ok(sent.some(x => x[0] === 'shortcut-action'), 'combo must dispatch: stranger never got to suppress shortcuts')
  // a second aux-window-shaped sender is equally rejected (never whitelisted)
  const aux = { sender: fakeWebContents() }
  ipcHandlers['shortcut-capturing'](aux, true)
  win.webContents.emit('before-input-event', { preventDefault () {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.ok(sent.some(x => x[0] === 'shortcut-action'), 'aux-window sender must not suppress either')
})

test('shortcuts: whitelisted main sender suppresses dispatch, and the armed timeout self-heals', async () => {
  const { ipcHandlers, win, sent } = shortcutSetup()
  ipcHandlers['shortcut-capturing']({ sender: win.webContents }, true)
  win.webContents.emit('before-input-event', { preventDefault () {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.ok(!sent.some(x => x[0] === 'shortcut-action'), 'combo must NOT dispatch mid-record')
  // self-heal: recorder died without sending the stop toggle — the timeout must restore dispatch
  await new Promise(r => setTimeout(r, 60))
  win.webContents.emit('before-input-event', { preventDefault () {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.ok(sent.some(x => x[0] === 'shortcut-action'), 'after the timeout the combo dispatches again (no permanent suppression)')
})

test('shortcuts: explicit stop toggle from the same sender clears suppression immediately', () => {
  const { ipcHandlers, win, sent } = shortcutSetup()
  ipcHandlers['shortcut-capturing']({ sender: win.webContents }, true)
  ipcHandlers['shortcut-capturing']({ sender: win.webContents }, false)
  win.webContents.emit('before-input-event', { preventDefault () {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.ok(sent.some(x => x[0] === 'shortcut-action'))
})

/* ---------------- 3. dbRecovery dialog map + declined probe ---------------- */

test('dbRecovery.recoveryDialogAction: recovered choice 1 maps to open-data-dir (used to be a silent bare quit)', () => {
  const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
  assert.equal(dbRecovery.recoveryDialogAction(true, 0), 'relaunch')
  assert.equal(dbRecovery.recoveryDialogAction(true, 1), 'open-data-dir', 'btnOpenDataDir must actually open the data dir')
  assert.equal(dbRecovery.recoveryDialogAction(true, 2), 'quit')
  assert.equal(dbRecovery.recoveryDialogAction(false, 0), 'open-data-dir')
  assert.equal(dbRecovery.recoveryDialogAction(false, 1), 'reset-and-relaunch')
  assert.equal(dbRecovery.recoveryDialogAction(false, 2), 'quit')
  // the wired branch in index.js performs the open: static guard against re-losing shell.openPath
  const idxSrc = fs.readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8')
  assert.match(idxSrc, /open-data-dir'\) \{ shell\.openPath\(ud\); app\.quit\(\) \}/, 'index.js open-data-dir branch must call shell.openPath(ud) then app.quit()')
})

test('dbRecovery: an inconclusive decrypt probe declines recovery WITHOUT renaming the db, and the label carries the probe reason', () => {
  const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dbrec-'))
  const mainDb = path.join(ud, 'todos.db')
  fs.writeFileSync(mainDb, 'CIPHERTEXT-NOT-SQLITE') // wrong header → probe branch
  fs.mkdirSync(path.join(ud, 'db.key')) // a DIRECTORY: readFileSync throws → probe 'unknown'
  const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('init failed again') })
  assert.equal(r && r.source, 'transient', 'inconclusive probe must stay conservative (transient, not a corrupt rename)')
  assert.match(r && r.label, /inconclusive/, 'dialog label carries the probe reason instead of a false "recovered" claim')
  assert.equal(fs.existsSync(mainDb), true, 'the possibly-healthy db file was never renamed aside')
  assert.equal(fs.existsSync(mainDb + '.corrupt-0') || fs.readdirSync(ud).some(f => f.includes('.corrupt-')), false, 'no .corrupt-* quarantine scene was created')
})

/* ---------------- 4. tomato control-channel gates ---------------- */

function tomatoHarness () {
  const mainSender = fakeWebContents()
  const floatSender = fakeWebContents()
  const calls = []
  const win = {
    isDestroyed: () => false,
    webContents: mainSender,
    minimize: () => calls.push('minimize'),
    maximize: () => calls.push('maximize'),
    unmaximize: () => calls.push('unmaximize'),
    isMaximized: () => false,
    hide: () => calls.push('hide'),
    close: () => calls.push('close'),
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 })
  }
  const h = loadWithStubs('src/main/handlers/tomato.js', { electron: electronStub })(Object.assign({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    rebuildTrayMenu: () => {},
    updateTomatoTray: () => {},
    isLocked: () => false
  }))
  return { h, win, calls, mainSender, floatSender }
}

test('tomato: main-window control channels reject a foreign sender (used to be gate-less)', () => {
  const { h } = tomatoHarness()
  const stranger = { sender: fakeWebContents() }
  for (const ch of ['minimize-main-window', 'maximize-main-window', 'hide-main-window', 'close-main-window-request']) {
    assert.throws(() => h[ch](stranger), /forbidden/, ch + ' must refuse a non-main sender')
  }
  assert.throws(() => h['quick-add-hide'](stranger), /forbidden/, 'quick-add-hide must refuse a foreign sender')
  assert.throws(() => h['flush-tomato-float'](stranger), /forbidden/, 'flush-tomato-float must refuse a foreign sender')
  assert.throws(() => h['undock-tomato-float'](stranger), /forbidden/, 'undock-tomato-float must refuse a foreign sender')
  // adversarial review 2026-09-25 ①: the remaining float side-effect channels join the gate
  assert.throws(() => h['show-tomato-float'](stranger), /forbidden/, 'show-tomato-float must refuse a foreign sender')
  assert.throws(() => h['hide-tomato-float'](stranger), /forbidden/, 'hide-tomato-float must refuse a foreign sender')
  assert.throws(() => h['set-tomato-float-bounds'](stranger), /forbidden/, 'set-tomato-float-bounds must refuse a foreign sender')
  // read-only channels stay open
  assert.equal(h['tomato-float-shown'](), false, 'tomato-float-shown is read-only and stays ungated')
})

test('tomato: the main window still drives its own controls', () => {
  const { calls } = tomatoHarness()
  // the harness's fake win must own the sender — rebuild with matching sender
  const mainSender = fakeWebContents()
  const win2 = { isDestroyed: () => false, webContents: mainSender, minimize: () => calls.push('minimize'), hide: () => calls.push('hide'), close: () => calls.push('close'), isMaximized: () => false }
  const h2 = loadWithStubs('src/main/handlers/tomato.js', { electron: electronStub })({
    getMainWindow: () => win2, showMainOrLock: () => {}, rebuildTrayMenu: () => {}, updateTomatoTray: () => {}, isLocked: () => false
  })
  assert.equal(h2['minimize-main-window']({ sender: mainSender }), true)
  assert.equal(h2['hide-main-window']({ sender: mainSender }), true)
  assert.equal(h2['close-main-window-request']({ sender: mainSender }), true)
  assert.deepEqual(calls.slice(-3), ['minimize', 'hide', 'close'])
  // read-only channel stays open for any window
  assert.equal(h2['is-maximized']({ sender: fakeWebContents() }), false)
})

test('tomato: locked state blocks the side-effecting window controls even from the main window', () => {
  const mainSender = fakeWebContents()
  const win2 = { isDestroyed: () => false, webContents: mainSender, minimize: () => {}, isMaximized: () => false }
  const h = loadWithStubs('src/main/handlers/tomato.js', { electron: electronStub })({
    getMainWindow: () => win2, showMainOrLock: () => {}, rebuildTrayMenu: () => {}, updateTomatoTray: () => {}, isLocked: () => true
  })
  for (const ch of ['minimize-main-window', 'maximize-main-window', 'hide-main-window', 'close-main-window-request']) {
    assert.throws(() => h[ch]({ sender: mainSender }), /locked/, ch + ' must refuse while the security lock is active')
  }
})

/* ---------------- 5. quit-ack shared token space ---------------- */

test('quit-ack: two tracker instances (quit path + updater early flush) draw from ONE token space', () => {
  const { createQuitAckTracker } = require_(path.join(ROOT, 'src/main/quit-ack.js'))
  const quit = createQuitAckTracker()
  const upd = createQuitAckTracker()
  const a = quit.nextToken()
  const b = upd.nextToken()
  assert.notEqual(a, b, 'tokens issued in the same millisecond by different trackers must never collide (the ack router tries the quit tracker first)')
  assert.ok(b > a, 'shared counter stays strictly increasing across trackers')
  // and a stale token from the OTHER tracker can never satisfy this round
  quit.beginRound(1, a)
  assert.equal(quit.ack(b, 1), false, 'a token minted by the updater tracker is stale garbage for the quit tracker')
})

/* ---------------- 6. backup uniqueSnapshotName exhaustion ---------------- */

test('backup.uniqueSnapshotName: an exhausted 900-name space returns null (never an already-taken name)', () => {
  const backup = require_(path.join(ROOT, 'src/main/handlers/backup.js'))
  const alwaysTaken = () => true
  assert.equal(backup.uniqueSnapshotName(alwaysTaken, 'C:\\dir', 'auto-', '20260925-120000', 1e12), null,
    'exhaustion must return null so the caller can report failure instead of silently overwriting an existing snapshot')
})

/* ---------------- 7. import category id allocation ---------------- */

test('import.allocCategoryId: bumps past every taken id (no ON-CONFLICT clobber of a live category)', () => {
  const imp = require_(path.join(ROOT, 'src/main/import/index.js'))
  assert.equal(imp.allocCategoryId(100, () => false), 100, 'free id passes through untouched')
  assert.equal(imp.allocCategoryId(100, n => n < 105), 105, 'a run of taken ids is skipped')
  assert.equal(imp.allocCategoryId(7, new Set([7, 8, 9, 10]).has.bind(new Set([7, 8, 9, 10]))), 11, 'bumps past a finite taken block')
})

/* ---------------- 8. handlers/todo dead-branch removal ---------------- */

test('todo-db:call: reads no longer fire notifySyncChange (the dead !viaBus branch was read-live only)', () => {
  const bus = require_(path.join(ROOT, 'src/main/command-bus'))
  const origCommitOp = bus.commitOp
  const commitCalls = []
  bus.commitOp = (op, p, o) => { commitCalls.push(op); return 'BUS-OK' }
  try {
    const syncKicks = []
    const mainSender = fakeWebContents()
    const dbmStub = { isWriteOp: () => false, LEDGER_WRITE_OPS: new Set(), call: () => null }
    const h = loadWithStubs('src/main/handlers/todo.js', {})({
      isLocked: () => false, isLockWindow: () => false, getMainWindow: () => ({ isDestroyed: () => false, webContents: mainSender }),
      resyncDbWatch: () => null, broadcastTomatoRecordsChanged: () => {}, broadcastTodosChanged: () => {}, dbApi: () => ({}),
      attachDir: '', notifySyncChange: op => syncKicks.push(op), dbm: dbmStub
    })
    const e = { sender: mainSender }
    const r = h['todo-db:call'](e, 'getMeta', 'someKey') // read op: direct db path, no bus
    assert.equal(r, null)
    assert.deepEqual(syncKicks, [], 'a read must not kick a sync round mislabeled as a local write')
    // setMeta write: bus-routed, sync kick comes ONLY from the ls-mirror hook — the handler inline kick is gone
    const r2 = h['todo-db:call'](e, 'setMeta', ['k', 'v'])
    assert.equal(r2, 'BUS-OK', 'setMeta still routes through the bus')
    assert.deepEqual(commitCalls, ['setMeta'])
    // behavioral guard: the dead inline pattern must stay deleted from the source
    const src = fs.readFileSync(path.join(ROOT, 'src/main/handlers/todo.js'), 'utf8')
    assert.ok(!/^\s*if \(!viaBus && notifySyncChange\)/m.test(src), 'the dead !viaBus sync-kick branches must not come back (code form, comments exempt)')
  } finally {
    bus.commitOp = origCommitOp
  }
})
