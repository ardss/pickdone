// W29 coverage anchor — saveAttachment's happy path and attachmentPath's resolve face were only
// exercised from suites outside the unit pool (deep/live), so the ratchet never saw them. Real
// temp storage via the TODO_USER_DATA_DIR isolation env; real fs, no IPC.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-att-save-'))
process.env.TODO_USER_DATA_DIR = process.env.TODO_USER_DATA_DIR || UD
process.on('exit', () => { try { fs.rmSync(UD, { recursive: true, force: true }) } catch { /* sweeper fallback */ } })

import { createRequire } from 'node:module'
import Module from 'node:module'
// electron stub (attachments.js's storage seam reads app.getPath for the user-data dir)
const ELECTRON_STUB = { app: { getPath: () => UD } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })
const require = createRequire(import.meta.url)
const { saveAttachment, attachmentPath, attachDir } = require('../../../src/main/attachments.js')

const b64 = buf => Buffer.from(buf).toString('base64')

test('saveAttachment happy path: durable write, path-form url, size reported', async () => {
  const png = Buffer.from('\x89PNG\r\n\x1a\nfake-png-bytes')
  const r = await saveAttachment({ taskId: 'w29t1', name: '截图 一.png', dataBase64: b64(png) })
  assert.equal(r && r.ok !== false, true, 'upload succeeds')
  assert.match(r.url, /^local:\/\/\//, 'modern PATH form: local:///<encoded>')
  assert.ok(r.size === png.length, 'size reflects the raw bytes (post-#222 statSync-guard contract)')
  const onDisk = attachmentPath(r.url)
  assert.ok(onDisk && fs.existsSync(onDisk), 'the url resolves to a real file on disk')
  assert.equal(fs.readFileSync(onDisk).length, png.length)
})

test('saveAttachment gates: bad extension / invalid base64 / empty payload all reject', async () => {
  await assert.rejects(() => saveAttachment({ taskId: 't', name: 'a.svg', dataBase64: b64(Buffer.from('x')) }), /not allowed/)
  await assert.rejects(() => saveAttachment({ taskId: 't', name: 'a.png', dataBase64: 'not!!base64' }), /base64/)
  await assert.rejects(() => saveAttachment({ taskId: 't', name: 'a.png', dataBase64: '' }), /base64|empty/)
})

test('saveAttachment sanitizes reserved/control-char names but keeps the upload working', async () => {
  const r = await saveAttachment({ taskId: 't', name: 'con.png', dataBase64: b64(Buffer.from('ok')) })
  assert.match(r.url, /^local:\/\/\//)
  const onDisk = attachmentPath(r.url)
  assert.ok(fs.existsSync(onDisk), 'reserved device name was prefixed, file landed')
})

test('attachmentPath: missing key resolves through the raw-key fallback and reports non-existent', () => {
  const p = attachmentPath('local:///%E4%B8%AD%E6%96%87-not-on-disk.png')
  assert.ok(typeof p === 'string' && p.length > 0, 'returns a resolved path (caller keeps the 404 contract)')
  assert.equal(fs.existsSync(p), false)
})

test('attachDir lives inside the isolated user-data dir', () => {
  const d = attachDir()
  assert.ok(d.startsWith(UD) || process.env.TODO_USER_DATA_DIR === undefined, 'sandbox-respecting storage dir')
})
