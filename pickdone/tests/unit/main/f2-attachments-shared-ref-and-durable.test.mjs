/**
 * F2 fix regression (2026-10-15), two fixes:
 *   1. [P2] Shared-reference guard on single-attachment deletes. delete-file (App) and
 *      attachment rm (CLI) used to unlink the physical file by local:// key alone — task B's
 *      ONLY copy died when task A deleted its entry for the same key. Now: surviving
 *      references in other todo rows (or duplicates in the same row) refuse the delete
 *      (structured error; App: opts.force bypass, CLI: ATTACH_SHARED_REF + --force), and the
 *      physical file stays until the last reference goes.
 *   2. [P2] CLI addAttachment routes its spool through durable-fs.writeFileDurable
 *      (tmp -> fsync -> rename), App parity with saveAttachment (D22). Verified by wrapping
 *      the shared exports object and asserting the CLI call goes through it and lands a
 *      byte-complete final file with no residue.
 *
 * Run: node --test tests/unit/main/f2-attachments-shared-ref-and-durable.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-attach-shared-'))
process.env.TODO_DB_DIR = TMP
const FILES_DIR = path.join(TMP, 'files')

// Electron stub: attachments.js / handlers touch app.getPath('userData') only.
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' }, shell: { openPath: async () => '' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const attachments = require_('../../../src/main/attachments.js')
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')
const durableFs = require_('../../../src/main/durable-fs.js')
const db = require_('../../../src/main/db.js')
const core = require_('../../../src/main/core/todo-core.js')
const libAttachmentsFactory = require_('../../../cli/lib-attachments.cjs')

db.init(TMP)

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

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }

function makeHandlers (dbmCall) {
  return attachmentHandlers({
    isLocked: () => false,
    isSafeExternal: u => typeof u === 'string' && /^https?:\/\//i.test(u),
    getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
    dbm: { call: dbmCall }
  })
}

/* ---------------- fix 1: shared-reference guard ---------------- */

test('findKeyRefs: counts refs across rows and fields, decodes/basename-resolves like attachmentPath', () => {
  const rows = [
    seed({ files: JSON.stringify([{ url: 'local://' + encodeURIComponent('a%b.png'), name: 'a%b.png' }]) }),
    seed({ image: JSON.stringify([{ url: 'local://k.png' }]), files: JSON.stringify([{ url: 'local://k.png' }]) }),
    seed({ files: JSON.stringify([{ url: 'https://example.com/k.png' }]) }) // non-local: ignored
  ]
  assert.equal(attachments.findKeyRefs('k.png', rows).length, 2, 'image + files entries of row 2')
  assert.equal(attachments.attachmentKeyOfUrl('local://' + encodeURIComponent('a%b.png')), 'a%b.png')
  assert.equal(attachments.attachmentKeyOfUrl('https://x/y.png'), null)
})

test('App delete-file: refuses and keeps the physical file while another task still references the key', () => {
  const handlers = makeHandlers((op, p) => db.call(op, p))
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const key = 'shared-' + Date.now() + '.png'
  const phys = path.join(FILES_DIR, key)
  fs.writeFileSync(phys, 'PNGDATA')
  const a = seed({ files: JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: key }]) })
  seed({ files: JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: key }]) })
  assert.throws(
    () => handlers['delete-file'](eMain, 'local://' + encodeURIComponent(key)),
    err => /still referenced by 2 other task row/.test(String(err && err.message)),
    'the handler counts every surviving DB reference (the renderer removes its own entry BEFORE calling, so surviving refs are real other-task pins)'
  )
  assert.equal(fs.existsSync(phys), true, 'physical file must survive while referenced')
  // references drain row by row (renderer order) → the last one lets the delete through
  db.call('upsert', { ...db.call('getById', a.taskId), files: '[]' })
  assert.throws(
    () => handlers['delete-file'](eMain, 'local://' + encodeURIComponent(key)),
    err => /still referenced by 1 other task row/.test(String(err && err.message))
  )
  // clear every remaining row that references the key, then the delete goes through
  for (const r of db.call('getAll', { deleted: null })) {
    if (String(r.taskId) === String(a.taskId)) continue
    if (attachments.findKeyRefs(key, [r]).length) db.call('upsert', { ...r, files: '[]' })
  }
  assert.equal(handlers['delete-file'](eMain, 'local://' + encodeURIComponent(key)), true)
  assert.equal(fs.existsSync(phys), false, 'file is unlinked once the last reference is gone')
})

test('App delete-file: opts.force bypasses the refusal (and still cleans the alias map path)', () => {
  const handlers = makeHandlers((op, p) => db.call(op, p))
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const key = 'forced-' + Date.now() + '.txt'
  fs.writeFileSync(path.join(FILES_DIR, key), 'x')
  seed({ files: JSON.stringify([{ url: 'local://' + key, name: key }]) })
  seed({ files: JSON.stringify([{ url: 'local://' + key, name: key }]) })
  assert.equal(handlers['delete-file'](eMain, 'local://' + key, { force: true }), true)
  assert.equal(fs.existsSync(path.join(FILES_DIR, key)), false)
})

test('CLI attachment rm: shared key → ATTACH_SHARED_REF, row untouched, file kept; force removes', () => {
  const api = libAttachmentsFactory({
    resolveTask: (input) => db.call('getById', String(input)),
    liveTasks: () => db.call('queryTodos', { deleted: 0 }),
    patchTodo: (id, patch, meta) => db.call('upsert', { ...db.call('getById', String(id)), ...patch, updateTime: Date.now() }),
    userDataDir: () => TMP,
    CliError: class CliError extends Error {
      constructor (message, code) { super(message); this.code = code }
    }
  })
  fs.mkdirSync(FILES_DIR, { recursive: true })
  const key = 'cli-shared-' + Date.now() + '.pdf'
  const phys = path.join(FILES_DIR, key)
  fs.writeFileSync(phys, 'PDFBYTES')
  const a = seed({ files: JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: 'doc.pdf' }]) })
  const b = seed({ files: JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: 'doc.pdf' }]) })
  assert.throws(
    () => api.removeAttachment(a.taskId, 'file', 1),
    e => e.code === 'ATTACH_SHARED_REF' && /still referenced by 1 other task row/.test(e.message)
  )
  // validate-before-write contract: the refusal must leave the row untouched
  assert.equal(db.call('getById', a.taskId).files, JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: 'doc.pdf' }]))
  assert.equal(fs.existsSync(phys), true, 'physical file must not be unlinked while B still references it')
  // duplicate entry of the same key inside the SAME row also blocks
  db.call('upsert', { ...db.call('getById', b.taskId), files: '[]' })
  db.call('upsert', { ...db.call('getById', a.taskId), files: JSON.stringify([{ url: 'local://' + encodeURIComponent(key), name: 'd1' }, { url: 'local://' + encodeURIComponent(key), name: 'd2' }]) })
  assert.throws(
    () => api.removeAttachment(a.taskId, 'file', 1),
    e => e.code === 'ATTACH_SHARED_REF',
    'a same-row duplicate still pins the file'
  )
  // force overrides
  const out = api.removeAttachment(a.taskId, 'file', 1, { force: true })
  assert.equal(out.removed, 'd1')
  assert.equal(fs.existsSync(phys), false, 'force deletes the last-pinned file')
})

/* ---------------- fix 2: CLI addAttachment durable write ---------------- */

test('CLI addAttachment: spools through writeFileDurable (fsync+rename) and lands a complete file', () => {
  const api = libAttachmentsFactory({
    resolveTask: (input) => db.call('getById', String(input)),
    liveTasks: () => db.call('queryTodos', { deleted: 0 }),
    patchTodo: (id, patch, meta) => db.call('upsert', { ...db.call('getById', String(id)), ...patch, updateTime: Date.now() }),
    userDataDir: () => TMP,
    CliError: class CliError extends Error {
      constructor (message, code) { super(message); this.code = code }
    }
  })
  const t = seed({})
  const src = path.join(TMP, 'upload-' + Date.now() + '.txt') // non-image ext → lands in `files`
  const payload = Buffer.from('PNG' + Date.now() + 'BYTES')
  fs.writeFileSync(src, payload)
  // Prove the CLI goes through the SHARED durable-fs entry (same exports object both sides require)
  let durableCalls = 0
  const orig = durableFs.writeFileDurable
  durableFs.writeFileDurable = (f, d, fsMod) => { durableCalls++; return orig(f, d, fsMod) }
  let out
  try { out = api.addAttachment(t.taskId, src) } finally { durableFs.writeFileDurable = orig }
  assert.equal(durableCalls, 1, 'add path must route through writeFileDurable (tmp -> fsync -> rename)')
  // the physical file: complete bytes, no spool residue
  const row = db.call('getById', t.taskId)
  const list = JSON.parse(row.files)
  assert.equal(list.length, 1)
  const key = decodeURIComponent(list[0].url.replace(/^local:\/\//, ''))
  const dest = path.join(FILES_DIR, key)
  assert.equal(fs.existsSync(dest), true, 'final file published')
  assert.deepEqual(fs.readFileSync(dest), payload, 'final file byte-complete')
  const residue = fs.readdirSync(FILES_DIR).filter(f => f.includes('.att-tmp-') || f.endsWith('.dtmp'))
  assert.equal(residue.length, 0, 'no spool residue left: ' + residue.join(', '))
})
