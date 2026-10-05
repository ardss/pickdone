/**
 * D22 (P2 2026-10-02) — attachment UPLOAD door durability + P3 main-side guards.
 *
 * 1. attachments.js saveAttachment (upload door): the LAN-receive twin (att-transfer.js
 *    writeAtomic) was made durable in D21 (tmp -> fsync -> rename), but the upload path still
 *    used writeFileSync + renameSync without fsync — the two doors had different durability.
 *    Now both route through durable-fs writeFileDurable while KEEPING the .att-tmp-* naming so
 *    the D19 startup residue sweep still matches crash trash from either door.
 * 2. export-xlsx: a renderer-less invocation (getMainWindow() falsy/destroyed) no longer
 *    throws a bare dialog argument TypeError — falls back to the parentless save dialog.
 * Run: node --test tests/unit/main/d22-attachment-upload-durable.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Module } from 'node:module'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd22-att-'))
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => TMP, isPackaged: false },
      dialog: {
        // Parentless form: record which overload the exporter used.
        showSaveDialog: async (...args) => {
          dialogCalls.push(args.length === 1 ? 'parentless' : 'with-window')
          return { canceled: true }
        },
      },
    }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const require = createRequire(import.meta.url)
const attachments = require('../../../src/main/attachments.js')
const { createExporter } = require('../../../src/main/export-xlsx.js')
const dialogCalls = []

const PNG_B64 = Buffer.from('<png-bytes-for-d22-durability-test>', 'utf8').toString('base64')

test('D22: saveAttachment (upload door) writes durably with the .att-tmp naming preserved', async () => {
  const dir = path.join(TMP, 'files') // attachDir() = <userData>/files
  const { key, size } = await attachments.saveAttachment({ taskId: 't1', name: 'pic.png', dataBase64: PNG_B64 })
  const dest = path.join(dir, key)
  assert.ok(fs.existsSync(dest), 'the file landed')
  assert.equal(fs.readFileSync(dest, 'utf8'), '<png-bytes-for-d22-durability-test>', 'content survived the durable write')
  assert.equal(size, Buffer.from(PNG_B64, 'base64').length)
  assert.deepEqual(fs.readdirSync(dir).filter(f => /\.att-tmp-/.test(f)), [],
    'no tmp residue: writeFileDurable owns the tmp lifecycle, rename publishes atomically')
})

test('D22: source anchor — the upload path matches the LAN-receive durable pattern', () => {
  const src = fs.readFileSync(new URL('../../../src/main/attachments.js', import.meta.url), 'utf8')
  assert.ok(src.includes("require('./durable-fs').writeFileDurable(tmp, raw, fs)"),
    'upload spools through writeFileDurable (the D21 receive-path twin)')
  assert.ok(!src.includes('fs.writeFileSync(tmp, raw)'),
    'red before the fix: bare writeFileSync on the upload tmp')
})

test('D22: export-xlsx with no main window falls back to the parentless save dialog', async () => {
  // 17 columns: the D6 header parse runs before the dialog is shown.
  const i18n = { mt: k => k === 'exportCols' ? Array.from({ length: 17 }, (_, i) => 'c' + i).join(',') : 'x' }
  const log = { info: () => {}, error: () => {} }
  // No window at all (renderer-less invocation).
  dialogCalls.length = 0
  let r = await createExporter({ getMainWindow: () => null, i18n, log }).exportTodosToXlsx({ fileName: 'a.xlsx', rows: [] })
  assert.equal(dialogCalls[0], 'parentless', 'red before the fix: showSaveDialog(null, opts) threw a TypeError')
  assert.deepEqual(r, { canceled: true })
  // Destroyed window stub is treated the same way.
  dialogCalls.length = 0
  r = await createExporter({ getMainWindow: () => ({ isDestroyed: () => true }), i18n, log }).exportTodosToXlsx({ fileName: 'a.xlsx', rows: [] })
  assert.equal(dialogCalls[0], 'parentless')
  // A healthy window still parents the dialog (no regression).
  dialogCalls.length = 0
  r = await createExporter({ getMainWindow: () => ({ isDestroyed: () => false }), i18n, log }).exportTodosToXlsx({ fileName: 'a.xlsx', rows: [] })
  assert.equal(dialogCalls[0], 'with-window')
})
