/* D11 fix-wave regression tests (main handlers / shortcuts / windows):
 *   finding 5  computeMetaGc covers the two orphaned families: planChipsSnapshot:<taskId> and
 *              snowDedup:<taskId>:<dedupKey> die with their task (startup backstop parity with
 *              the db-meta-gc.cjs per-delete hooks)
 *   finding 6  restoreCategoriesFromCriticalBackup keeps tombstone stamps: a restored deletion
 *              carries its backup deletedAt (or the epoch-oldest 1) and updatedAt=1, so a
 *              backup-era tombstone can no longer win LWW against a peer's recovered category
 *   finding 8  ensure/restore-window-width: main-window-only + locked-state gate (a trapped aux
 *              window could move/resize the main window, including while locked)
 *   finding 17 backup auto-dedup twin is scoped to the SAME tag prefix (an evt-* twin must not
 *              suppress an auto-* snapshot whose retention is then hostage to the evt rotation)
 *   hotkey     a conflicted global hotkey whose final failure happens with no main window queues
 *              its notice and delivers it on the next renderer did-finish-load
 *   12-windows openExternalSafely: async rejections are caught+logged, never unhandled
 * Run: node --test tests/unit/main/d11-main-handlers.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const db = require_('../../../src/main/db.js')
const shared = require_('../../../src/main/handlers/shared.js')
const dbRecovery = require_('../../../src/main/dbRecovery.cjs')

// Electron/aux-module stubs must be installed BEFORE the handler modules load.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-main-'))
const electronStub = {
  app: { getPath: () => TMP, isPackaged: false },
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: { on: () => {} },
}
const modStubs = {
  electron: electronStub,
  '../tomato-float': {
    isSelfSender: () => false, show: () => {}, hide: () => {}, isVisible: () => false,
    flushNow: () => {}, setBounds: () => {}, dragStart: () => {}, dragStop: () => {},
    setPanelOpen: () => {}, undock: () => {},
  },
  '../tomato-taskbar': { update: () => {} },
  '../quick-add': { hide: () => {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (modStubs[request]) return modStubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tomatoHandlers = require_('../../../src/main/handlers/tomato.js')
const backupHandlers = require_('../../../src/main/handlers/backup.js')

function freshDb (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-main-' + label + '-'))
  db.init(dir)
  return { dir }
}

// ---------- finding 5: computeMetaGc families ----------
test('finding 5: planChipsSnapshot and snowDedup keys die with their task, live ones survive', () => {
  const live = [{ taskId: 't1' }, { taskId: 't2' }]
  const keys = [
    'planChipsSnapshot:t1', // live task -> keep
    'planChipsSnapshot:t9', // dead task -> GC
    'snowDedup:t2:focus-1', // live task -> keep
    'snowDedup:t9:abc', // dead task -> GC
    'tomatoEstimateState:t1', // live task -> keep
  ]
  const dead = shared.computeMetaGc(keys, [], live)
  assert.ok(dead.includes('planChipsSnapshot:t9'), 'a dead task\'s chip snapshot is GC\'d (startup backstop used to miss the family)')
  assert.ok(dead.includes('snowDedup:t9:abc'), 'a dead task\'s snowDedup fence is GC\'d (startup backstop used to miss the family)')
  assert.ok(!dead.includes('planChipsSnapshot:t1'))
  assert.ok(!dead.includes('snowDedup:t2:focus-1'))
  assert.ok(!dead.includes('tomatoEstimateState:t1'))
})

// ---------- finding 6: category restore tombstone stamps ----------
test('finding 6: a restored category tombstone keeps its stamps (no fresh-now LWW win)', () => {
  const { dir } = freshDb('catrestore')
  const backupAt = 1700000000000 // backup-era tombstone: a now() stamp would be unmistakably newer
  const raw = { backup: { categoryState: JSON.stringify({ schemaV: 1, list: [
    { categoryId: 5001, categoryName: 'gone', delete: true, deletedAt: backupAt },
    { categoryId: 5002, categoryName: 'kept', delete: false },
  ] }) } }
  const n = dbRecovery.restoreCategoriesFromCriticalBackup(raw, c => db.call('upsertCategory', c))
  assert.equal(n, 2)
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get()
  const gone = d.prepare('SELECT deleted, deletedAt, updatedAt FROM categories WHERE id = 5001').get()
  const kept = d.prepare('SELECT deleted, updatedAt FROM categories WHERE id = 5002').get()
  d.close()
  assert.equal(gone.deleted, 1)
  assert.equal(gone.deletedAt, backupAt, 'the backup\'s tombstone stamp survives (was re-stamped to local now)')
  assert.equal(gone.updatedAt, 1, 'epoch-oldest LWW age: any real peer row wins the next round (was local now)')
  assert.equal(kept.deleted, 0)
  assert.ok(kept.updatedAt > 0)
  db.close()
})

// ---------- finding 8: window-width channel gates ----------
function makeWin (bounds) {
  return {
    isDestroyed: () => false,
    webContents: { id: 'main', send: () => {} },
    getBounds: () => ({ x: 10, y: 10, width: 1000, height: 800 }),
    isMaximized: () => false,
    isFullScreen: () => false,
    setBounds: b => bounds.push(b),
  }
}

test('finding 8: ensure/restore-window-width reject non-main senders and locked state', () => {
  const bounds = []
  const win = makeWin(bounds)
  let locked = false
  const handlers = tomatoHandlers({ getMainWindow: () => win, showMainOrLock: () => {}, rebuildTrayMenu: () => {}, updateTomatoTray: () => {}, isLocked: () => locked })
  const eAux = { sender: { id: 'aux' } }
  const eMain = { sender: win.webContents }
  assert.throws(() => handlers['ensure-window-width'](eAux, 1400), /forbidden/, 'aux sender must not move the main window')
  assert.throws(() => handlers['restore-window-width'](eAux, 1400), /forbidden/, 'aux sender must not resize the main window')
  locked = true
  assert.throws(() => handlers['ensure-window-width'](eMain, 1400), /locked/, 'locked state refuses the write channel')
  assert.throws(() => handlers['restore-window-width'](eMain, 1400), /locked/)
  assert.equal(bounds.length, 0, 'no setBounds leaked through the gate checks')
  locked = false
  handlers['ensure-window-width'](eMain, 1400)
  handlers['restore-window-width'](eMain, 900)
  assert.equal(bounds.length, 2, 'both legitimate widen/restore calls reach setBounds once gated')
})

// ---------- finding 17: same-tag dedup twin ----------
test('finding 17: the dedup twin is the newest file of the SAME tag prefix', () => {
  const names = ['evt-appclose-20261001-120000.json', 'auto-20261001-110000.json', 'evt-appclose-20261001-100000.json']
  assert.equal(backupHandlers.newestSameTag(names, 'auto-'), 'auto-20261001-110000.json', 'an evt twin is not compared against an auto write')
  assert.equal(backupHandlers.newestSameTag(names, 'evt-appclose-'), 'evt-appclose-20261001-120000.json')
  assert.equal(backupHandlers.newestSameTag(names, 'evt-other-'), null)
  assert.equal(backupHandlers.newestSameTag(names, ''), null)
})

// ---------- hotkey pending-notice queue ----------
test('hotkey: final conflict failure with no main window queues the notice; the next renderer load delivers it', () => {
  const resolved = require_.resolve(path.resolve('src/main/shortcuts.js'))
  delete require_.cache[resolved]
  const timerFns = []
  const electronStub2 = {
    globalShortcut: { register: () => false, unregisterAll: () => {} }, // hotkey always conflicted
    ipcMain: { on: () => {} },
  }
  const origLoad2 = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub2
    return origLoad2.call(this, request, parent, isMain)
  }
  let mod
  try { mod = require_(resolved) } finally { Module._load = origLoad2 }
  const sent2 = []
  let win = null
  const api = mod.createShortcuts({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    quickAdd: { toggle: () => {} },
    i18n: { mt: (k, v) => k + ':' + (v && v.key) },
    log: { warn: () => {} },
  }, {
    setTimeout: fn => { timerFns.push(fn); return { unref () {} } },
    clearTimeout: () => {},
  })
  api.applyShortcuts({ toggleMainWindow: 'ctrl+shift+q' })
  // Backoff retries at 3s/12s/30s: none win (register always false), and no window is up.
  for (const fn of timerFns.splice(0)) fn()
  assert.equal(sent2.length, 0, 'no send while the window is unavailable (was log-only: the notice was lost)')
  // The main window comes up; applyShortcuts re-attaches the load hook (which owns the queue
  // flush), then the queued notice flushes when the renderer's did-finish-load fires.
  let loadHook = null
  win = { isDestroyed: () => false, webContents: { on (ev, h) { if (ev === 'did-finish-load') loadHook = h }, send: (ch, p) => sent2.push([ch, p]) } }
  api.applyShortcuts({ toggleMainWindow: 'ctrl+shift+q' })
  assert.equal(sent2.filter(([ch]) => ch === 'shortcut-conflict').length, 0, 'still nothing sent before the renderer actually loads')
  assert.equal(typeof loadHook, 'function', 'the load hook that flushes the queue is attached')
  loadHook()
  assert.ok(sent2.some(([ch]) => ch === 'shortcut-conflict'), 'the queued notice is delivered to the first live renderer')
  loadHook()
  assert.equal(sent2.filter(([ch]) => ch === 'shortcut-conflict').length, 1, 'the queue drains exactly once')
})

// ---------- 12-windows: openExternalSafely ----------
test('12-windows: openExternalSafely catches async rejections (no unhandled rejection)', async () => {
  const rejections = []
  const onUnhandled = reason => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const shell = { openExternal: () => Promise.reject(new Error('blocked by policy')) }
  const logs = []
  const ok = shared.openExternalSafely(shell, 'https://example.com', { warn: (...a) => logs.push(a) })
  assert.equal(ok, true, 'http(s) urls are handed to the shell')
  await new Promise(r => setTimeout(r, 10))
  process.off('unhandledRejection', onUnhandled)
  assert.equal(rejections.length, 0, 'the rejection was caught, not left unhandled')
  assert.equal(logs.length, 1, 'the failure is logged')
  assert.equal(shared.openExternalSafely(shell, 'file:///etc/passwd'), false, 'non-http(s) urls never reach the shell')
  assert.equal(shared.openExternalSafely({ openExternal: () => { throw new Error('sync throw') } }, 'https://x.test'), false, 'a sync throw is contained')
})
