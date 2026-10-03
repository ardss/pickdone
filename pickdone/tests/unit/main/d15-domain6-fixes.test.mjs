/* D15 fixer domain 6 (2026-10-02) — main process handlers + audit + security fixes:
 *   C4/C16 audit.js: flushNow must OWN the chunks it steals from the async writer (no duplicate
 *          appends, no sync-retry of stolen chunks) and must SEAL the noop-fold chain for entries
 *          leaving through the in-flight path too.
 *   C6     handlers/system.js: notification rate budget is PER SENDER, not one process-global window.
 *   C7     handlers/system.js: log:write gets the same per-sender rate gate (generous sizing).
 *   C8     security-lock.js: verifyLockPassword short-circuits on length BEFORE Buffer allocation.
 *   C9     scheduler.js: firedReminders LRU bound holds per-admission even when the persist keeps failing.
 *   C11    quick-add.js: summon bounds are computed for the cursor's display.
 *   C12    handlers/settings.js: set-app-locale under the config read-failed gate rejects with a
 *          structured error instead of returning a null body.
 *   C13    handlers/attachments.js: white-noise pick — post-copy size check + tmp+rename atomic write.
 *   C15    handlers/security.js: lock-app gated to the main window like every sibling control channel.
 * Run: node --test tests/unit/main/d15-domain6-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd15-domain6-'))
process.env.TODO_DB_DIR = TMP // log-isolation: keep electron-log writes inside the temp dir

/* ---------------- narrow module stubbing helper (d13 pattern) ---------------- */
let moduleStubs = null
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (moduleStubs && Object.prototype.hasOwnProperty.call(moduleStubs, request)) return moduleStubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })
function withStubs (stubs, fn) {
  const prev = moduleStubs
  moduleStubs = stubs ? { ...moduleStubs, ...stubs } : prev
  try { return fn() } finally { moduleStubs = prev }
}

const electronStub = {
  Notification: class { show () {} },
  shell: { openPath: async () => '', openExternal: async () => '' },
  BrowserWindow: class {},
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: b => b, decryptString: b => b },
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test', getLocale: () => 'en-US', on () {}, whenReady: () => Promise.resolve() }
}
// 'electron' stays stubbed for the WHOLE file: the real npm electron shim exports a path string,
// and once origLoad caches it (first require outside a stub window) every later require gets the
// poisoned cache. Handlers call require('electron') lazily inside their factories.
moduleStubs = { electron: electronStub }

/* ================= C4 / C16 — audit chunk ownership + fold seal ================= */
const audit = require_('../../../src/main/audit.js')
const auditDir = path.join(TMP, 'audit-c4')
fs.mkdirSync(auditDir, { recursive: true })
audit.setDirResolver(() => auditDir)
function freshAuditFile () {
  audit.resetForTests()
  audit.setDirResolver(() => auditDir)
  try { fs.rmSync(path.join(auditDir, 'cli-audit.jsonl'), { force: true }) } catch { /* first run */ }
}

test('C4: flushNow steals in-flight chunks exactly once — no duplicate appends after the async callback lands', async () => {
  freshAuditFile()
  // 64 distinct noop entries trigger flushAsync (buffer >= FLUSH_BATCH_MAX): one chunk is handed
  // to fs.appendFile and registered inFlight. A macrotask hop lets the serialized writer actually
  // ISSUE the appendFile; flushNow then runs while that append is still in flight (the real
  // quit-time situation) — any duplication afterwards is the old bug.
  for (let i = 0; i < 64; i++) audit.recordCustom('c4t', ['op' + i], [], [], null)
  await new Promise(r => setImmediate(r)) // writer chain issues the async appendFile
  audit.flushNow()
  await new Promise(r => setTimeout(r, 100)) // let the racing async callback land (if it would)
  const lines = fs.readFileSync(path.join(auditDir, 'cli-audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 64, 'each entry appended exactly once, got ' + lines.length)
})

test('C16: fold chain is sealed when the folded entry leaves through the in-flight path', async () => {
  freshAuditFile()
  for (let i = 0; i < 64; i++) audit.recordCustom('c16t', ['op' + i], [], [], null)
  await new Promise(r => setImmediate(r))
  audit.flushNow() // lastNoop.entry is now inside the STOLEN chunk
  // Identical to entry #64: without the seal it folds into the detached, already-written entry
  // and the record is silently lost; with the seal it starts a fresh line.
  audit.recordCustom('c16t', ['op63'], [], [], null)
  audit.flushNow()
  const lines = fs.readFileSync(path.join(auditDir, 'cli-audit.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 65, 'the post-flush identical record must reach disk, got ' + lines.length)
  audit.resetForTests()
})

/* ================= C6 / C7 — per-sender rate budgets in system handlers ================= */
const { allowWithinRate } = require_('../../../src/main/security-lock.js')
const systemHandlers = withStubs({ electron: electronStub }, () => require_('../../../src/main/handlers/system.js'))
const sys = withStubs({ electron: electronStub }, () => systemHandlers({
  isLocked: () => false,
  allowWithinRate,
  i18n: { mt: () => 'x' },
  app: { getPath: () => TMP },
  getMainWindow: () => null,
  isSafeExternal: () => true
}))

test('C6: notification rate budget is per sender — a chatty window cannot starve another', () => {
  const e1 = { sender: { id: 'w1' } }
  const e2 = { sender: { id: 'w2' } }
  let ok = true
  for (let i = 0; i < 10; i++) ok = sys.notification(e1, { title: 't' })
  assert.equal(ok, true, 'first 10 sends of w1 allowed')
  assert.equal(sys.notification(e1, { title: 't' }), false, 'w1 11th within window blocked')
  assert.equal(sys.notification(e2, { title: 't' }), true, 'w2 has its OWN budget (old code: starved)')
})

const sys2 = withStubs({ electron: electronStub }, () => systemHandlers({
  isLocked: () => false,
  allowWithinRate,
  i18n: { mt: () => 'x' },
  app: { getPath: () => TMP },
  getMainWindow: () => null,
  isSafeExternal: () => true
}))
test('C7: log:write is rate gated per sender, generously', () => {
  const e = { sender: { id: 'logger-1' } }
  let last = null
  for (let i = 0; i < 120; i++) last = sys2['log:write'](e, ['hello ' + i])
  assert.equal(last, true, '120 calls within the window allowed (legitimate logging never trips)')
  assert.equal(sys2['log:write'](e, ['spam']), false, 'call 121 in the window is gated')
  assert.equal(sys2['log:write']({ sender: { id: 'logger-2' } }, ['ok']), true, 'another sender unaffected')
})

/* ================= C8 — verifyLockPassword allocation short-circuit ================= */
test('C8: oversized plain passwords are rejected BEFORE any Buffer.from allocation', () => {
  const securityLock = withStubs({ electron: electronStub }, () => require_('../../../src/main/security-lock.js'))
  const lock = securityLock.createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    readConfig: () => ({ securityLockPassword: 'plain:s3cret' }),
    writeConfig: () => {},
    i18n: { mt: () => 'x' },
    log: { warn () {}, error () {}, info () {} }
  })
  assert.equal(lock.verifyLockPassword('s3cret'), true)
  assert.equal(lock.verifyLockPassword('nope'), false)
  let allocated = 0
  const origFrom = Buffer.from
  Buffer.from = function (...args) { allocated++; return origFrom.apply(Buffer, args) }
  let r
  try { r = lock.verifyLockPassword('y'.repeat(5000)) } finally { Buffer.from = origFrom }
  assert.equal(r, false, 'oversized input rejected')
  assert.equal(allocated, 0, 'no attacker-sized Buffer allocated (old code: allocated 2)')
})

/* ================= C9 — LRU bound holds under sustained persist failure ================= */
test('C9: firedReminders stays bounded at FIRED_MAX even when every persist fails', () => {
  const scheduler = withStubs({
    electron: electronStub,
    './command-bus': { commit: () => { throw new Error('disk full') } },
    './db.js': { call: () => { throw new Error('disk full') } }
  }, () => require_('../../../src/main/scheduler.js'))
  scheduler._clearStateForTest()
  for (let i = 0; i < 2000; i++) scheduler._markFired('k' + i)
  assert.equal(scheduler._fired.size, 2000)
  // Sustained persist failure: the old code skipped the eviction each time ("self-heals later")
  // and the map grew without bound. The bound must hold per admission.
  for (let i = 0; i < 50; i++) scheduler._markFired('over' + i)
  assert.ok(scheduler._fired.size <= 2000, 'bound holds under failure, got ' + scheduler._fired.size)
  scheduler._clearStateForTest()
})

/* ================= C11 — quick-add summons on the cursor's display ================= */
test('C11: default bounds center on the display the user is working on (cursor)', () => {
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 40, width: 1920, height: 1040 } }
  const secondary = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
  class BW {
    constructor (opts) { BW.lastOpts = opts; this.webContents = { on () {}, setWindowOpenHandler () {}, send () {} } }
    setAlwaysOnTop () {} setMenu () {} setBounds () {} show () {} focus () {} on () {}
    isDestroyed () { return false } isVisible () { return false }
    loadURL () { return Promise.resolve() }
  }
  const qaElectron = {
    ...electronStub,
    BrowserWindow: BW,
    screen: {
      getCursorScreenPoint: () => ({ x: 3000, y: 500 }),
      getDisplayNearestPoint: () => secondary,
      getPrimaryDisplay: () => primary
    }
  }
  const qa = withStubs({ electron: qaElectron }, () => require_('../../../src/main/quick-add.js'))
  qa.toggle()
  const opts = BW.lastOpts
  // secondary work area x=1920 w=1920 → bar (480 wide) centered at 1920 + 720 = 2640
  assert.equal(opts.x, 2640, 'summon centered on the CURSOR display (old code: 720 = primary)')
  assert.equal(opts.y, Math.round(1040 * 0.18))
})

/* ================= C12 — set-app-locale under the read-failed gate ================= */
test('C12: set-app-locale under the config read-failed gate rejects with a structured error', () => {
  const settingsHandlers = withStubs({
    '../tomato-float': { isSelfSender: () => false },
    '../tomato-taskbar': { setBaseTitle () {} }
  }, () => require_('../../../src/main/handlers/settings.js'))
  const mainWC = { id: 'main' }
  const ctx = {
    readConfig: () => ({}),
    writeConfig: () => null, // config-store read-failed gate returns null
    app: { setLoginItemSettings () {}, getPath: () => TMP },
    getMainWindow: () => ({ webContents: mainWC, isDestroyed: () => false }),
    applyShortcuts () {}, rebuildTrayMenu () {}, getTray: () => null
  }
  const h = settingsHandlers(ctx)
  assert.throws(
    () => h['set-app-locale']({ sender: mainWC }, 'en-US'),
    err => err.code === 'CONFIG_READ_FAILED',
    'null body must never be returned; degradation must be explicit'
  )
  // Healthy path unchanged: sanitized config body returned (fresh handler — the factory
  // destructures ctx once, so a healthy writeConfig needs its own instance)
  const h2 = settingsHandlers({ ...ctx, writeConfig: () => ({ appLocale: 'en-US', shortcutKeySettings: {}, securityLockPassword: 'enc1:xx' }) })
  const out = h2['set-app-locale']({ sender: mainWC }, 'en-US')
  assert.equal(out.appLocale, 'en-US')
  assert.equal(out.securityLockPassword, undefined, 'security keys still stripped on the healthy path')
})

/* ================= C13 — white-noise pick: post-copy size check + atomic rename ================= */
test('C13: swapped-oversize source is caught AFTER the copy; final key never sees bad bytes; no tmp residue', async () => {
  const filesDir = path.join(TMP, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const src = path.join(TMP, 'picked.wav')
  fs.writeFileSync(src, Buffer.alloc(10))
  const attachmentHandlers = withStubs({
    electron: { ...electronStub, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [src] }) } }
  }, () => require_('../../../src/main/handlers/attachments.js'))
  const mainWC = { id: 'main' }
  const ctx = {
    isLocked: () => false,
    isSafeExternal: () => true,
    getMainWindow: () => ({ webContents: mainWC, isDestroyed: () => false }),
    broadcastWhiteNoiseUpdated () {},
    notifySyncChange () {}
  }
  // factory call inside the stub window: dialog is destructured per factory call
  const h = withStubs({ electron: { ...electronStub, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [src] }) } } }, () => attachmentHandlers(ctx))
  const realCopy = fs.promises.copyFile
  // Simulate the TOCTOU swap: by the time bytes land, the "source" became a 51MB file
  fs.promises.copyFile = async (from, to) => {
    await realCopy(from, to)
    fs.writeFileSync(to, Buffer.alloc(51 * 1024 * 1024))
  }
  let threw = null
  try {
    await h['select-user-white-noise-audio-file']({ sender: mainWC })
  } catch (e) { threw = e } finally { fs.promises.copyFile = realCopy }
  assert.ok(threw && /too large/.test(threw.message), 'oversized copy rejected post-copy, got: ' + threw)
  assert.equal(fs.existsSync(path.join(filesDir, 'noise-custom.wav')), false, 'final key never holds the oversized bytes')
  const residue = fs.readdirSync(filesDir).filter(f => f.includes('.tmp-'))
  assert.deepEqual(residue, [], 'tmp file cleaned up, got ' + residue.join(','))
})

test('C13: healthy pick lands atomically via tmp+rename with no residue', async () => {
  const filesDir = path.join(TMP, 'files')
  const src = path.join(TMP, 'picked2.wav')
  fs.writeFileSync(src, Buffer.alloc(10))
  const mainWC2 = { id: 'main' }
  const h = withStubs({
    electron: { ...electronStub, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [src] }) } }
  }, () => require_('../../../src/main/handlers/attachments.js')({
    isLocked: () => false, isSafeExternal: () => true,
    getMainWindow: () => ({ webContents: mainWC2, isDestroyed: () => false }),
    broadcastWhiteNoiseUpdated () {}, notifySyncChange () {}
  }))
  const out = await h['select-user-white-noise-audio-file']({ sender: mainWC2 })
  assert.equal(out.key, 'noise-custom.wav')
  assert.equal(fs.existsSync(path.join(filesDir, 'noise-custom.wav')), true)
  assert.deepEqual(fs.readdirSync(filesDir).filter(f => f.includes('.tmp-')), [])
})

/* ================= C15 — lock-app sender gate ================= */
test('C15: lock-app is main-window-only like its sibling control channels', () => {
  const securityHandlers = withStubs({ electron: electronStub }, () => require_('../../../src/main/handlers/security.js'))
  const mainWC = { id: 'main' }
  const auxWC = { id: 'float' }
  let locked = 0
  const h = securityHandlers({
    lockAppNow: () => { locked++ },
    unlockAppNow: () => {},
    verifyLockPassword: () => true,
    isLockWindow: () => false,
    getMainWindow: () => ({ webContents: mainWC, isDestroyed: () => false })
  })
  assert.throws(() => h['lock-app']({ sender: auxWC }), /forbidden: main window only/, 'aux window cannot lock')
  assert.equal(locked, 0, 'no lock side effect for a rejected sender')
  h['lock-app']({ sender: mainWC })
  assert.equal(locked, 1, 'main window still locks')
})
