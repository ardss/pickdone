/* H7 round-7 C2 fixes — import chain / attachment domain regressions:
 *  1. [P1] cli/import.js: importItems no longer re-runs a full queryTodos table scan PER ROW to compute
 *     daySorts (O(N²)); one snapshot pool + per-insert decrement. Writes land through the transactional
 *     'upsertMany' op instead of per-row upsert (crash mid-import used to leave a half-imported DB).
 *  2. [P1] handlers/csv-import.js: import:run re-baselines the db watch (resyncDbWatch) so our own bulk
 *     import is not misread as an external write (full reload + undo-stack wipe).
 *  4. [P1] csv-import.js: worker terminate() rejection is logged, not swallowed/unhandled.
 *  5. [P2] notify-sound.js: toSoundUrl uses pathToFileURL ('#'/'?' in filenames no longer break file://).
 *  6. [P2] handlers/attachments.js: save-upload-file-to-download filters '\' + Windows reserved names and
 *     checks the exact 'local://' prefix before slicing.
 *  7. [P2] import:pick-preview asserts a live main window.
 *  8. [P2] import:run re-stats the file and re-applies the 20MB cap.
 * Real temp DB via TODO_DB_DIR (f6 pattern), never touches real data.
 * Run: node --test tests/unit/main/h7-import-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-h7-import-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

const importer = require_('../../../cli/import.js')

/* ---- 1a: daySorts snapshot — top-insert min-100 chain preserved, no per-row full scan ---- */
test('h7-1: import assigns top-insert sorts within an existing day pool and 0 on an empty day (snapshot semantics)', () => {
  const due = +dayjs().add(3, 'day').hour(9).minute(0).second(0).millisecond(0)
  const day = +dayjs(due).startOf('day')
  const a = seed({ taskContent: 'h7占用A', todoTime: due, dayStart: day, taskSort: -500 })
  seed({ taskContent: 'h7占用B', todoTime: due, dayStart: day, taskSort: -300 })
  const csv = ['List Name,Title,Due Date', 'Inbox,h7新任务1,' + dayjs(due).format('YYYY-MM-DD HH:mm:ss'),
    'Inbox,h7新任务2,' + dayjs(due).format('YYYY-MM-DD HH:mm:ss'),
    'Inbox,h7无日期,'].join('\r\n')
  const r = importer.importItems(importer.rowsToItems(csv, 'ticktick'), { dryRun: false, format: 'ticktick' })
  assert.equal(r.imported, 3)
  const fresh = db.call('queryTodos', { deleted: 0 }).filter(t => /^h7新任务|h7无日期/.test(t.taskContent))
  const sorts = Object.fromEntries(fresh.map(t => [t.taskContent, t.taskSort]))
  // both new same-day tasks chain on top of the existing min (-500): -600 then -700
  assert.equal(sorts['h7新任务1'], Math.fround(-500 - 100))
  assert.equal(sorts['h7新任务2'], Math.fround(-500 - 200))
  assert.equal(sorts['h7无日期'], 0) // empty day pool → sort 0
  assert.ok(a && fresh.length === 3)
})

test('h7-1: queryTodos is called a bounded number of times regardless of row count (O(N²) regression)', () => {
  const calls = { n: 0 }
  const orig = db.call
  db.call = function (op, params) { if (op === 'queryTodos') calls.n++; return orig.call(this, op, params) }
  try {
    const items = Array.from({ length: 60 }, (_, i) => ({ list: '', title: 'h7批量' + i, notes: '', tags: [], due: 0, reminder: 0, priority: 0, done: false, completedAt: 0 }))
    const r = importer.importItems(items, { dryRun: false, format: 'ticktick' })
    assert.equal(r.imported, 60)
    // fingerprint pool (deleted:0 + deleted:1) + daySort snapshot = 3 full scans total, NOT 60+
    assert.ok(calls.n <= 5, 'queryTodos calls must be O(1) in row count, got ' + calls.n)
  } finally { db.call = orig }
})

test('h7-1: batch write goes through the transactional upsertMany op (source assertion)', () => {
  const src = readSrc('cli', 'import.js')
  assert.match(src, /db\.call\('upsertMany', rows\)/)
  assert.doesNotMatch(src, /db\.call\('upsert', t\)/, 'per-row upsert must be gone from the import loop')
  // db.js: upsertMany is wrapped in db.transaction
  const dbsrc = readSrc('src', 'main', 'db.js')
  assert.match(dbsrc, /stmts\.upsertMany = db\.transaction/)
})

/* ---- 2: import:run re-baselines the db watch ---- */
test('h7-2: import:run calls resyncDbWatch after the bulk write (source assertion + contract)', () => {
  const src = readSrc('src', 'main', 'handlers', 'csv-import.js')
  const runIdx = src.indexOf("'import:run'")
  assert.ok(runIdx > 0)
  const runBody = src.slice(runIdx)
  assert.match(runBody, /resyncDbWatch/, 'import:run must re-baseline the db watch (own writes otherwise look external)')
  // same pattern as handlers/todo.js: resolve then invoke
  assert.match(runBody, /const rw = resyncDbWatch && resyncDbWatch\(\); if \(rw\) rw\(\)/)
  // manual verification path: set a breakpoint after import:run and confirm lastMtime was re-baselined —
  // without it the next watch poll triggers reloadAll + clear of the renderer undo stack.
})

/* ---- 4: worker terminate failure is logged, not silently swallowed ---- */
test('h7-4: runImportParse terminate() rejection is handled (source assertion)', () => {
  const src = readSrc('src', 'main', 'handlers', 'csv-import.js')
  assert.match(src, /Promise\.resolve\(worker\.terminate\(\)\)\.catch/)
})

/* ---- 5: toSoundUrl escapes reserved URL characters ---- */
test('h7-5: toSoundUrl percent-encodes # and ? in out-of-root sound files', () => {
  const { toSoundUrl } = require_('../../../src/main/notify-sound.js')
  const outside = path.join(os.tmpdir(), 'ring#1 name?.ogg')
  const url = toSoundUrl(outside, path.join(ROOT, 'src'))
  assert.match(url, /^file:\/\//)
  assert.ok(!url.includes('#'), '# must be percent-encoded or it parses as a URL fragment')
  assert.ok(!url.includes('?'), '? must be percent-encoded or it parses as a URL query')
  assert.ok(url.includes('%23') && url.includes('%3F'))
  // in-root branch unchanged: app://app/<rel>
  const inRoot = toSoundUrl(path.join(ROOT, 'src', 'a.mp3'), path.join(ROOT, 'src'))
  assert.equal(inRoot, 'app://app/a.mp3')
})

/* ---- 6: save-upload-file-to-download sanitizer ---- */
function loadAttachmentHandlers (fakeAppRoot) {
  const require = createRequire(import.meta.url)
  const Module = require('module')
  const resolved = require.resolve('../../../src/main/handlers/attachments.js')
  delete require.cache[resolved]
  delete require.cache[require.resolve('../../../src/main/attachments.js')]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => fakeAppRoot }, dialog: {}, shell: {} }
    return origLoad.call(this, request, parent, isMain)
  }
  const mod = require('../../../src/main/handlers/attachments.js')
  Module._load = origLoad
  return mod
}
test('h7-6: save-to-download filters backslash traversal, reserved device names, and non-local urls', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-h7-dl-'))
  fs.mkdirSync(path.join(tmp, 'files'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'files', 'src.png'), 'x')
  const mod = loadAttachmentHandlers(tmp)
  const h = mod({ isLocked: () => false, isSafeExternal: u => /^https?:/i.test(u), getMainWindow: () => null, broadcastWhiteNoiseUpdated: () => {}, app: { getPath: () => tmp } })
  // backslash traversal must collapse to a flat name inside downloads (separators → '_', no path segments)
  const dst1 = h['save-upload-file-to-download']({}, 'local://src.png', '..\\..\\evil.png')
  assert.equal(path.basename(dst1), '.._.._evil.png')
  assert.ok(dst1.startsWith(tmp), 'must land inside the downloads dir')
  // Windows reserved device names get a safe prefix instead of an unpredictable device open
  const dst2 = h['save-upload-file-to-download']({}, 'local://src.png', 'CON.png')
  assert.equal(path.basename(dst2), '_CON.png')
  const dst3 = h['save-upload-file-to-download']({}, 'local://src.png', 'com1')
  assert.equal(path.basename(dst3), '_com1')
  // non-local URL: null without touching/slicing the value
  assert.equal(h['save-upload-file-to-download']({}, 'https://x/y.png', 'y.png'), null)
})

/* ---- 7 + 8: pick-preview main-window guard, import:run re-stat (source assertions) ---- */
test('h7-7/8: pick-preview guards the main window; import:run re-stats the file size cap', () => {
  const src = readSrc('src', 'main', 'handlers', 'csv-import.js')
  assert.match(src, /makeAssertMainWindow/)
  const pickIdx = src.indexOf("'import:pick-preview'")
  assert.match(src.slice(pickIdx), /assertMainWindow\(e\)/)
  const runIdx = src.indexOf("'import:run'")
  const runBody = src.slice(runIdx)
  const statIdx = runBody.indexOf('statSync')
  const readIdx = runBody.indexOf('readFileSync')
  assert.ok(statIdx > 0 && statIdx < readIdx, 'import:run must stat+cap-check BEFORE reading the file')
  assert.match(runBody, /checkImportFileSize/)
})
