/**
 * D13 domain-4 fault-handler fixes (2026-10-01):
 *   C3  appLocale is now validated/normalized through i18n.normalizeLocale on BOTH sides —
 *       currentLocale honors a stored 'zh-CN' (it only ever recognized exact 'en-US' and
 *       silently fell through to system detection), and set-app-locale rejects unsupported
 *       values at the IPC boundary instead of persisting junk that flips the app back to the
 *       system default on the next launch.
 *   C4  the win32 beep spawn carries an 'error' listener — a spawn failure (missing/blocked
 *       powershell.exe) used to surface as an uncaught exception (the linux/mac twin is
 *       try/caught, this branch was not).
 *   C7  import:run: an importItems throw mid-write now settles like success (db-watch
 *       re-baseline, scheduler reload, broadcast, sync kick), consumes the single-shot grant
 *       (replay after a partial import needs a fresh preview), and returns the SAME
 *       {ok:false, code, message} contract instead of a bare reject.
 *   C8  tomato-announce: a probe that confirms the seq space is intact resets zeroRowPolls —
 *       the healthy idle path used to pay the extra probe query on EVERY later poll forever.
 * Isolation: TODO_DB_DIR + TODO_USER_DATA_DIR point at temp dirs (d9 pattern) — never the real
 * %APPDATA%/pickdone.
 * Run: node --test tests/unit/main/d13-domain4-fault-handlers.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-d4-db-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-d4-ud-'))

/* ---------------- stub infra (d9-import-pipeline-fixes pattern) ---------------- */

let moduleStubs = {}
function withStubs (stubs, fn) {
  const Module = require_('module')
  const origLoad = Module._load
  moduleStubs = stubs || {}
  Module._load = function (request, parent, isMain) {
    if (moduleStubs[request]) return moduleStubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try { return fn() } finally { Module._load = origLoad; moduleStubs = {} }
}
function loadWithStubs (relPath, stubs) {
  const resolved = require_.resolve(path.join(ROOT, relPath))
  delete require_.cache[resolved]
  return withStubs(stubs, () => require_(resolved))
}
function clearCache (relPath) {
  delete require_.cache[require_.resolve(path.join(ROOT, relPath))]
}

/* ---------------- C3: shared locale normalization ---------------- */

test('C3: currentLocale honors a stored appLocale \'zh-CN\' even when the system locale is English', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-c3-ud-'))
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({ appLocale: 'zh-CN' }))
  // English system locale: the pre-fix code only recognized exact 'en-US' in config, so the
  // user's explicit Chinese choice fell through to system detection and came back 'en-US'.
  const electronStub = { app: { getPath: () => ud, getLocale: () => 'en-US' } }
  const i18n = loadWithStubs('src/main/i18n.js', { electron: electronStub })
  clearCache('src/main/i18n.js') // fresh module state for the other tests
  assert.equal(i18n.currentLocale(), 'zh-CN', 'red before the fix: system English won over the stored zh-CN')
  assert.equal(i18n.normalizeLocale('zh-CN'), 'zh-CN')
  assert.equal(i18n.normalizeLocale('en-US'), 'en-US')
  assert.equal(i18n.normalizeLocale('fr-FR'), null, 'unsupported values must be unrecognizable, not silently accepted')
  assert.equal(i18n.normalizeLocale(undefined), null)
})

test('C3: set-app-locale rejects an unsupported locale WITHOUT persisting it, and normalizes a valid one', () => {
  const main = { isDestroyed: () => false, webContents: { id: 1 }, setTitle () {} }
  const writes = []
  const ctx = {
    readConfig: () => ({}),
    writeConfig: patch => { writes.push(patch); return Object.assign({ appLocale: patch.appLocale }, patch) },
    app: {},
    getMainWindow: () => main,
    applyShortcuts () {},
    rebuildTrayMenu () {},
    getTray: () => null
  }
  const settings = loadWithStubs('src/main/handlers/settings.js', {
    'electron-log': { warn () {}, info () {} },
    '../tomato-float': { isSelfSender: () => false },
    '../tomato-taskbar': { setBaseTitle () {} }
  })
  clearCache('src/main/handlers/settings.js')
  const h = settings(ctx)
  const e = { sender: main.webContents }
  // junk value: must throw and never reach writeConfig (red before the fix: fr-FR was persisted verbatim)
  assert.throws(() => h['set-app-locale'](e, 'fr-FR'), /unsupported locale/)
  assert.equal(writes.length, 0, 'a rejected locale must not be persisted to config.json')
  // valid value goes through unchanged
  const c = h['set-app-locale'](e, 'en-US')
  assert.equal(c.appLocale, 'en-US')
  assert.equal(writes.length, 1)
})

/* ---------------- C4: win32 beep spawn carries an 'error' listener ---------------- */

test('C4: the win32 beep fallback registers an error listener on the spawned child (spawn failure must not become an uncaught exception)', () => {
  const regs = []
  const fakeChild = { on (ev, h) { regs.push([ev, typeof h === 'function']) }, unref () {} }
  let spawned = false
  const notifySound = loadWithStubs('src/main/notify-sound.js', {
    './window-ref': { getMainWindow: () => null } // force the beep fallback branch
  })
  clearCache('src/main/notify-sound.js')
  assert.ok(!spawned)
  // notify-sound requires 'child_process' INSIDE sound() at call time — keep the interception
  // active across the call, not just the module load. The win32 branch is platform-gated, so pin
  // process.platform for the duration (this suite must pass on linux CI too).
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    withStubs({ child_process: { spawn: () => { spawned = true; return fakeChild } } }, () => notifySound.sound(''))
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
  assert.ok(spawned, 'the powershell beep spawn happened')
  const err = regs.find(([ev]) => ev === 'error')
  assert.ok(err, 'red before the fix: no error listener — a spawn ENOENT crashed the main process')
  assert.equal(err[1], true, 'the error listener must be a function')
})

/* ---------------- C7: importItems throw settles + consumes the grant ---------------- */

const electronStub = {
  app: { isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: dialogStubData.filePaths }) },
  ipcMain: { on: () => {}, handle: () => {} }
}
let dialogStubData = { filePaths: [] }
try {
  const resolved = require_.resolve('electron')
  require_.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: electronStub }
} catch { /* no real electron package — fine */ }

const fakeItem = over => Object.assign(
  { list: '', title: 'x', notes: '', tags: [], due: 0, reminder: 0, priority: 0, done: false, completedAt: 0 }, over)

function loadCsvImport (importerStub) {
  class FakeWorker {
    constructor (entry, opts) { this.h = {} }
    on (ev, h) { this.h[ev] = h }
    terminate () { return Promise.resolve(0) }
  }
  const mod = loadWithStubs('src/main/handlers/csv-import.js', {
    electron: electronStub,
    worker_threads: {
      Worker: class extends FakeWorker {
        constructor (entry, opts) { super(entry, opts); setTimeout(() => this.h.message && this.h.message({ ok: true, format: 'ticktick', items: [fakeItem({ list: 'D13清单C7', title: 'd13 c7 任务' })] }), 0) }
      }
    }
  })
  // csv-import requires '../import' lazily INSIDE the handlers at call time — plant the stub in
  // the require cache (Module._load interception is gone by then).
  const importerPath = require_.resolve(path.join(ROOT, 'src/main/import/index.js'))
  const prev = require_.cache[importerPath]
  require_.cache[importerPath] = { id: importerPath, filename: importerPath, loaded: true, exports: importerStub }
  return { mod, unplant: () => { if (prev) require_.cache[importerPath] = prev; else delete require_.cache[importerPath] } }
}

test('C7: an importItems throw at run time returns the structured contract, still settles (broadcast) and wipes the grant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-c7-'))
  const csv = path.join(dir, 'c7.csv')
  fs.writeFileSync(csv, 'List Name,Title\r\nD13清单C7,d13 c7 任务\r\n')
  dialogStubData = { filePaths: [csv] }
  let broadcastCalls = 0
  let resyncCalls = 0
  const { mod, unplant } = loadCsvImport({
    importItems (items, opts) {
      if (opts && opts.dryRun) return { wouldImport: 1 } // preview succeeds
      throw Object.assign(new Error('engine blew up mid-write'), { code: 'WRITE_FAIL' }) // run fails after a partial write
    }
  })
  try {
    const sender = { id: 42 }
    const e = { sender }
    const h = mod({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
      dbApi: () => ({}),
      broadcastTodosChanged: () => { broadcastCalls++ },
      log: { warn () {}, info () {} },
      resyncDbWatch: () => { resyncCalls++; return null },
      isLocked: () => false
    })
    const p = await h['import:pick-preview'](e)
    assert.equal(p && p.ok, true, 'preview must succeed so the run stage is reached')
    const r = await h['import:run'](e, csv) // red before the fix: bare throw out of the IPC handler
    assert.equal(r && r.ok, false, 'the failure must ride the structured {ok:false} contract')
    assert.equal(r && r.code, 'WRITE_FAIL')
    assert.equal(broadcastCalls, 1, 'C7: the partial write must still broadcast so the UI converges')
    assert.ok(resyncCalls >= 1, 'C7: the db-watch baseline must be re-synced after a partial write')
    const r2 = await h['import:run'](e, csv)
    assert.equal(r2 && r2.code, 'AUTH_EXPIRED', 'C7: the single-shot grant is consumed even when the engine threw — same bytes are not replayable after a partial import')
  } finally { unplant() }
})

/* ---------------- C8: healthy idle probe does not repeat every poll ---------------- */

test('C8: a probe confirming an intact seq space resets zeroRowPolls — idle polls stop paying the extra probe query every poll', () => {
  const ta = require_('../../../src/main/tomato-announce.js')
  ta.__reset()
  const rows = [{ seq: 50, entity: 'meta', entityId: ta.keyFor('dev-c8'), ts: 5 }]
  const store = { [ta.keyFor('dev-c8')]: JSON.stringify({ deviceId: 'dev-c8', deviceName: 'C8', status: 'idle', startedAt: 0, plannedSec: 0, at: 1 }) }
  let probeCalls = 0
  const base = (op, p) => {
    if (op === 'syncOplogSince') return rows.filter(r => r.seq > (p.sinceSeq || 0)).slice(0, p.limit || rows.length)
    if (op === 'getMeta') return store[p] ?? null
    return null
  }
  ta.init({ dbCall: (op, p) => {
    if (op === 'syncOplogSince' && p.sinceSeq === 49) probeCalls++
    return base(op, p)
  } })
  ta.listAnnounces() // poll 1: watermark 0 → full scan picks the row (cheap, no probe)
  const POLLS = 7
  for (let i = 0; i < POLLS - 1; i++) assert.equal(ta.listAnnounces().length, 1, 'idle poll still lists the announce')
  // Red before the fix: polls 2..7 ALL probed (6 probes). Green: probes fire at 2,4,6 (3 probes) —
  // the healthy-idle guarantee is one cheap incremental scan per poll with no permanent extra query.
  assert.equal(probeCalls, 3, `healthy idle must not probe on every poll (got ${probeCalls} probes over ${POLLS} polls; red before the fix: ${POLLS - 1})`)
  ta.__reset()
})
