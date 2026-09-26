/**
 * Domain-3 import/export pipeline fixes (2026-09-25):
 *   A15  importItems dry-run now REPORTS would-be categories (categoriesCreated) without writing
 *        them — the preview used to always claim 0 while the real import created N.
 *   C9   import:run wraps runImportParse in try/catch → structured {ok:false, code, message}
 *        (a worker failure at run time used to escape as a bare throw and degrade to generic
 *        renderer copy, because invoke() rejections strip Error.code across the context bridge).
 *   B13  audit single-lining: the App-side recordCustom duplicate is gone — importItems' own
 *        engine audit line is the ONE record per import (same cli-audit.jsonl as the CLI).
 *   B15  single-shot execution grant: import:run clears lastPickedImportPath/Hash on success;
 *        a second run without a fresh preview returns the structured AUTH_EXPIRED contract
 *        instead of a bare throw.
 * Isolation: TODO_DB_DIR + TODO_USER_DATA_DIR point at temp dirs (f6 pattern) — never the real
 * %APPDATA%/pickdone.
 * Run: node --test tests/unit/main/d9-import-pipeline-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-import-db-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-import-ud-'))
const db = require_('../../../src/main/db.js')
db.init(process.env.TODO_DB_DIR)
const importer = require_('../../../src/main/import/index.js')

/* ---------------- stub infra (dw-main-ipc-gate-wave pattern) ---------------- */

const electronStub = {
  app: { isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: dialogStubData.filePaths }) },
  ipcMain: { on: () => {}, handle: () => {} }
}
let dialogStubData = { filePaths: [] }

/** Handlers lazy-require('electron') at CALL time — plant a persistent stub module in the require
 *  cache for the whole test process (dw-main-ipc-gate-wave pattern). */
try {
  const resolved = require_.resolve('electron')
  require_.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: electronStub }
} catch { /* no real electron package installed — loadWithStubs covers it */ }

function loadWithStubs (relPath, stubs) {
  const resolved = require_.resolve(path.join(ROOT, relPath))
  delete require_.cache[resolved]
  const Module = require_('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try { return require_(resolved) } finally { Module._load = origLoad }
}

/** Fake parse worker: emits whatever `script(worker)` schedules (real worker_threads untouched
 *  for the lazily-required import engine). */
function loadCsvImportWithWorker (script, extraStubs) {
  class FakeWorker {
    constructor (entry, opts) { this.opts = opts; this.h = {}; script(this) }
    on (ev, h) { this.h[ev] = h }
    terminate () { return Promise.resolve(0) }
  }
  return loadWithStubs('src/main/handlers/csv-import.js', Object.assign(
    { electron: electronStub, worker_threads: { Worker: FakeWorker } }, extraStubs || {}))
}

function handlerCtx () {
  const sender = { id: 42 }
  return {
    e: { sender },
    ctx: {
      getMainWindow: () => ({ isDestroyed: () => false, webContents: sender }),
      dbApi: () => ({}),
      broadcastTodosChanged: () => {},
      log: { warn () {}, info () {} },
      resyncDbWatch: () => null,
      isLocked: () => false
    }
  }
}

const fakeItem = over => Object.assign(
  { list: '', title: 'x', notes: '', tags: [], due: 0, reminder: 0, priority: 0, done: false, completedAt: 0 }, over)

function countAuditImports () {
  const file = path.join(process.env.TODO_DB_DIR, 'cli-audit.jsonl')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).filter(l => {
    try { return JSON.parse(l).action === 'import' } catch { return false }
  }).length
}

/* ---------------- A15: dry-run reports categoriesCreated without writing ---------------- */

test('A15: dry-run import from two NEW lists reports categoriesCreated==2 and writes nothing', () => {
  const csv = 'List Name,Title\r\nD9清单甲,d9任务甲\r\nD9清单乙,d9任务乙\r\n'
  const items = importer.rowsToItems(csv, 'ticktick')
  const dry = importer.importItems(items, { dryRun: true, format: 'ticktick' })
  assert.equal(dry.wouldImport, 2)
  assert.deepEqual([...dry.categoriesCreated].sort(), ['D9清单乙', 'D9清单甲'],
    'preview must name the categories it WOULD create (JSDoc contract at :223)')
  const names = db.call('getAllCategories').map(c => c.categoryName || '')
  assert.ok(!names.includes('D9清单甲') && !names.includes('D9清单乙'), 'dry-run must not write categories')
  // and the real run afterwards still creates them (cache placeholder did not poison the write path)
  const real = importer.importItems(items, { dryRun: false, format: 'ticktick' })
  assert.equal(real.imported, 2)
  assert.equal(real.categoriesCreated.length, 2)
  const names2 = db.call('getAllCategories').map(c => c.categoryName || '')
  assert.ok(names2.includes('D9清单甲') && names2.includes('D9清单乙'))
})

/* ---------------- C9 + B15 + B13: import:run structured failures, grant wipe, single audit line ---------------- */

test('C9: a parse-worker failure at RUN time returns structured {ok:false, code} instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-c9-'))
  const csv = path.join(dir, 'c9.csv')
  fs.writeFileSync(csv, 'List Name,Title\r\nD9清单丙,d9 c9 任务\r\n')
  dialogStubData = { filePaths: [csv] }
  let parseCalls = 0
  const mod = loadCsvImportWithWorker(w => {
    setTimeout(() => {
      parseCalls++
      if (parseCalls === 1) w.h.message && w.h.message({ ok: true, format: 'ticktick', items: [fakeItem({ list: 'D9清单丙', title: 'd9 c9 任务' })] })
      else w.h.error && w.h.error(Object.assign(new Error('[FORMAT_UNKNOWN] worker blew up at run time'), { code: 'FORMAT_UNKNOWN' }))
    }, 0)
  })
  const { ctx, e } = handlerCtx()
  const h = mod(ctx)
  const p = await h['import:pick-preview'](e)
  assert.equal(p && p.ok, true, 'preview must succeed so the run stage is reached')
  const r = await h['import:run'](e, csv) // must NOT reject
  assert.equal(r && r.ok, false)
  assert.equal(r && r.code, 'FORMAT_UNKNOWN', 'the run-time worker failure rides the structured contract')
  assert.equal(typeof r.message, 'string')
})

test('B15 + B13: after a successful run the grant is wiped (second run = AUTH_EXPIRED) and exactly ONE audit line lands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-b15-'))
  const csv = path.join(dir, 'b15.csv')
  fs.writeFileSync(csv, 'List Name,Title\r\nD9清单丁,d9 b15 任务\r\n')
  dialogStubData = { filePaths: [csv] }
  const mod = loadCsvImportWithWorker(w => {
    setTimeout(() => w.h.message && w.h.message({ ok: true, format: 'ticktick', items: [fakeItem({ list: 'D9清单丁', title: 'd9 b15 任务' })] }), 0)
  })
  const { ctx, e } = handlerCtx()
  const h = mod(ctx)
  const p = await h['import:pick-preview'](e)
  assert.equal(p && p.ok, true)
  const before = countAuditImports()
  const r1 = await h['import:run'](e, csv)
  assert.equal(r1 && r1.imported, 1, 'first approved run imports')
  assert.equal(countAuditImports() - before, 1,
    'B13: an App-side import lands EXACTLY ONE audit line (the engine line; the recordCustom duplicate is gone — same single-line caliber as the CLI)')
  const r2 = await h['import:run'](e, csv) // replay without a fresh preview — must NOT throw
  assert.equal(r2 && r2.ok, false, 'the replayed run must fail structurally, not as a bare reject')
  assert.equal(r2 && r2.code, 'AUTH_EXPIRED', 'single-shot grant: B15 wiped it at the end of the successful run')
  // and a never-granted path is the same structured contract (was: throw 'path not granted by picker')
  const r3 = await h['import:run'](e, path.join(dir, 'never-granted.csv'))
  assert.equal(r3 && r3.code, 'AUTH_EXPIRED')
})

/* ---------------- R3-stability: TOCTOU read guard — file vanishing between stat and read ---------------- */

test('R3-stability: a file deleted between the run-time stat and the read returns structured FILE_MISSING instead of throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd9-toctou-'))
  const csv = path.join(dir, 'vanish.csv')
  fs.writeFileSync(csv, 'List Name,Title\r\nD9清单戊,d9 vanish 任务\r\n')
  dialogStubData = { filePaths: [csv] }
  // Interpose on fixUtil.checkImportFileSize (the only code between the :135 stat and the read):
  // the first call (preview) passes through; the second (import:run) unlinks the file mid-window —
  // reproducing the cross-process delete (AV scanner etc.) between statSync and readFileSync.
  const realFixUtil = require_('../../../src/main/fix-util.js')
  let statCalls = 0
  const fixUtilStub = Object.assign(Object.create(Object.getPrototypeOf(realFixUtil)), realFixUtil, {
    checkImportFileSize (size) {
      statCalls++
      if (statCalls === 2) { try { fs.unlinkSync(csv) } catch { /* already gone */ } }
      return realFixUtil.checkImportFileSize(size)
    }
  })
  const mod = loadCsvImportWithWorker(
    w => setTimeout(() => w.h.message && w.h.message({ ok: true, format: 'ticktick', items: [fakeItem({ list: 'D9清单戊', title: 'd9 vanish 任务' })] }), 0),
    { '../fix-util': fixUtilStub })
  const { ctx, e } = handlerCtx()
  const h = mod(ctx)
  const p = await h['import:pick-preview'](e)
  assert.equal(p && p.ok, true, 'preview must succeed so the run stage reaches the unguarded read')
  assert.equal(statCalls, 1)
  const r = await h['import:run'](e, csv) // must NOT reject with raw ENOENT
  assert.equal(statCalls, 2, 'the run-time stat must have happened (the vanish happened after it)')
  assert.equal(r && r.ok, false)
  assert.equal(r && r.code, 'FILE_MISSING', 'the vanishing read must ride the structured {ok:false} contract, not a bare throw')
  assert.match(r.message, /no longer readable/)
})
